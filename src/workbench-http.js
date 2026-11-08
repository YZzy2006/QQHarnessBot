import {pageRecords,activityRecord,memoryRecords,recordRevision} from './workbench-records.js';
import {PORTRAIT_LIMIT,inspectPortrait} from './workbench-portrait.js';
import {buildWorkbenchOperation} from './workbench-operations.js';
import {projectWorkbenchContacts} from './workbench-contacts.js';
import {readOwnerCommandCatalog} from './owner-command-catalog.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createWorkbenchAuth} from './workbench-auth.js';
import {WORKBENCH_TTL} from './workbench-store.js';

export const workbenchContext = new AsyncLocalStorage();
export function workbenchReply(fallback, key, text, options) {
  const ctx = workbenchContext.getStore();
  if (!ctx || ctx.active === false) return fallback(key, text, options);
  ctx.messages.push({key, text: String(text).slice(0, 16000)});
  if (ctx.strict && /^(?:.*失败[：:]|未完成[：:]|用法[：:]|参数(?:错误|无效)|请先|无法|找不到|没找到|未知|不能|无权|不允许|目标.*不(?:在|允许)|找到.*请用)/.test(String(text).split('\n')[0])) ctx.error = String(text).split('\n')[0];
  if (String(text).startsWith('未完成：')) ctx.error = String(text).slice(4);
  return Promise.resolve(true);
}
const fail = (message, statusCode = 400) => { throw Object.assign(Error(message), {statusCode}); };
const str = (v, max = 1000) => typeof v === 'string' && v.trim().length <= max ? v.trim() : fail(`文字必须在${max}字以内`);
const segment = v => { const s = str(v, 1000); if (!s || /[\[\]【】\r\n\u0000-\u001f]/.test(s)) fail('指令参数不能为空或含括号、换行'); return `[${s}]`; };
const scopePattern = /^(?:private|group):[1-9]\d{0,11}$/;

export function createWorkbench({root, stateDir, store, api, execute, facts, redact = String, now = Date.now, publicOrigin = '', administration = null, contacts = null, portraitStorage = null, serverMonitor = null, queryBalance = null, editRecord = null}) {
  if (publicOrigin) {
    const parsed = new URL(publicOrigin);
    if (parsed.protocol !== 'https:' || parsed.origin !== publicOrigin) throw Error('工作台公开来源必须是完整HTTPS源地址（无路径）');
  }
  const auth = createWorkbenchAuth({stateDir, now});
  const jobs = new Map(), portraitUploads = new Map(); let active = null;
  const headers = {
    ...(publicOrigin ? {'Strict-Transport-Security': 'max-age=15552000'} : {}),
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data: https://*.hdslb.com; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  };
  function readJson(rel, fallback) {
    const file = path.join(stateDir, rel);
    if (!fs.existsSync(file)) return fallback;
    if (fs.statSync(file).size > 8_000_000) fail('资料文件过大，无法读取', 503);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('资料文件无法读取，请检查原始档案', 503); }
  }
  function allowed() {
    const f = facts();
    return [...new Set([`private:${f.ownerQQ}`, ...f.scopes])].filter(k => scopePattern.test(k));
  }
  function scope(raw, all = false) {
    if (all && raw === 'all') return raw;
    if (!scopePattern.test(raw || '') || !allowed().includes(raw)) fail('请选择允许的私聊或群聊', 403);
    return raw;
  }
  const matches = (key, selected) => selected === 'all' ? allowed().includes(key) : key === selected;
  const memoryViews=new Map();
  async function conversationMemory(key){
    const old=memoryViews.get(key);if(old&&old.expiresAt>now())return old.data;
    const data={key,...await api('/api/socialV2/memory?key='+encodeURIComponent(key))};
    if(memoryViews.size>=128)memoryViews.delete(memoryViews.keys().next().value);
    memoryViews.set(key,{data,expiresAt:now()+15000});return data;
  }
  let balanceCache=null,balanceFlight=null,balanceChecked=0;
  async function balance(force=false){
    if(balanceFlight)return balanceFlight;
    if(balanceCache&&now()-balanceChecked<(force?10000:60000))return balanceCache;
    balanceChecked=now();balanceFlight=(async()=>{
      try{
        if(!queryBalance)throw Error('unavailable');const data=await queryBalance();
        const rows=(data.balance_infos||[]).filter(r=>['CNY','USD'].includes(r.currency)&&[r.total_balance,r.granted_balance,r.topped_up_balance].every(v=>typeof v==='string'&&/^-?\d+(?:\.\d+)?$/.test(v))).slice(0,2).map(r=>({currency:r.currency,total:r.total_balance,granted:r.granted_balance,toppedUp:r.topped_up_balance}));
        if(!rows.length)throw Error('invalid');balanceCache={at:now(),available:data.is_available===true,rows,stale:false};
      }catch{balanceCache={...(balanceCache||{at:0,rows:[]}),stale:true,error:'余额暂时无法读取，请稍后手动刷新；未消耗对话额度。'};}
      return balanceCache;
    })();try{return await balanceFlight;}finally{balanceFlight=null;}
  }
  async function view(tab, selected, params = new URLSearchParams()) {
    const listing=rows=>pageRecords(rows,params,{now:now()});
    const f = facts(), ownerKey = `private:${f.ownerQQ}`;
    if (tab === 'overview') {
      const status = await api('/api/status');
      return {status: {...status, activity: undefined}, scopes: allowed(), ownerKey, preview: status.preview === true, portrait: store.portrait()};
    }
    if (tab === 'contacts') {
      const fallback = [...allowed(), ...(administration ? administration.read().scopes.map(row => row.key) : [])];
      try {const directory = contacts ? await contacts() : {};return {available: !!contacts, partial: directory.partial === true, entries: projectWorkbenchContacts(directory, fallback), message: directory.partial ? '部分联系人暂未读取，可用号码或刷新重试。' : ''};}
      catch {return {available: false, entries: projectWorkbenchContacts({}, fallback), message: '联系人暂时读取失败，可刷新重试。'};}
    }
    if (tab === 'commands') return readOwnerCommandCatalog();
    if (tab === 'profile') {if (!administration) fail('机器人配置尚未连接', 503);return {...administration.read(), portrait: store.portrait(), portraitUploadAvailable: portraitStorage?.available() === true};}
    scope(selected, true);
    if (tab === 'server') {if(!serverMonitor)fail('服务器检测尚未连接',503);return serverMonitor.snapshot();}
    if (tab === 'balance') return balance();
    if (tab === 'activity') {
      const saved=(store.read().activities||[]).filter(r=>r.at>now()-30*86400000);
      const legacy=String((await api('/api/status')).activity||'').split('\n').map(line=>activityRecord(line,{redact})).filter(Boolean);
      const rows=new Map();for(const row of [...legacy,...saved])if((row.key?matches(row.key,selected):selected==='all'))rows.set(row.id,row);
      return {listing:listing([...rows.values()]),retentionDays:30,legacyNote:'旧日志仅有时分秒，日期未记录的条目不会计入日期筛选。'};
    }
    if (tab === 'diaries') {
      const entries=selected==='all'||selected===ownerKey?store.read().diaries.slice().reverse():[];
      const list=listing(entries);return {entries:list.items,listing:list,private:true,global:true};
    }
    if (tab === 'videos') {
      const ctl = readJson('bilibili/control.json', {reads: [], shares: [], targets: {}, limits: {}});
      const cache = readJson('bilibili/video-results.json', {rows: []});
      const index = readJson('bilibili/video-seen.json', {refs: {}});
      const fresh = (cache.rows || []).filter(r => now() - (r.analyzedAt ?? r.at) < WORKBENCH_TTL && matches(String(r.scope).split('|')[0], selected));
      const rows = new Map();
      for (const r of fresh.slice().sort((a, b) => a.at - b.at)) rows.set(`${r.ref}|${String(r.scope).split('|')[0]}`, {ref: r.ref, key: String(r.scope).split('|')[0], at: r.analyzedAt ?? r.at, title: r.title || '', cover: /^https:\/\/(?:[a-z0-9-]+\.)*hdslb\.com\//i.test(r.cover || '') ? r.cover : '', summary: redact(r.summary || ''), coverage: r.coverage || '', expiresAt: (r.analyzedAt ?? r.at) + WORKBENCH_TTL});
      const shares = (ctl.shares || []).filter(r => matches(r.sourceKey, selected)).slice(-100).map(r => ({id: r.id, bvid: r.bvid, key: r.sourceKey, at: r.at, automatic: r.automatic, status: r.status}));
      const records=[...[...rows.values()].map(r=>({...r,kind:'watched'})),...shares.map(r=>({...r,kind:'shared'})),...store.read().events.filter(r=>r.expiresAt>now()&&matches(r.key,selected)).map(r=>({...r,kind:'selection',eventKind:r.kind}))];
      const activeRefs=new Set([...rows.values()].map(r=>r.ref));
      if(selected==='all')records.push(...Object.entries(index.refs||{}).slice(-200).filter(([ref])=>!activeRefs.has(ref)).map(([ref,r])=>({ref,at:r.lastAt,kind:'indexed'})));
      const list=listing(records);
      return {listing:list,entries:list.items.filter(r=>r.kind==='watched'),receipts:list.items.filter(r=>r.kind==='indexed').map(({ref,at})=>({ref,at})),shares:list.items.filter(r=>r.kind==='shared'),limits:ctl.limits,targets:Object.fromEntries(Object.entries(ctl.targets||{}).filter(([k])=>matches(k,selected))),preferences:store.preferences()};
    }
    if (tab === 'roles') return api('/api/roles');
    if (tab === 'role') return api('/api/roles/content?name=' + encodeURIComponent(selected));
    if (tab === 'memory') {
      const keys = selected === 'all' ? allowed() : [selected];
      const conversations=[];for(const key of keys)conversations.push(await conversationMemory(key));
      const data={conversations, notes: selected === 'all' || selected === ownerKey ? f.notes : [], memories: selected === 'all' || selected === ownerKey ? f.memories : [], tasks: f.tasks.filter(r => matches(r.key, selected)), todos: selected === 'all' || selected === ownerKey ? f.todos : []};
      return {listing:listing(memoryRecords(data))};
    }
    if (tab === 'feedback') {
      const data = await api('/api/socialV2/feedback'), decisions = store.read().decisions;
      const entries=(data.entries||[]).filter(r=>matches(r.key,selected)).map(r=>({...r,kind:r.level==='error'?'error':r.level==='warning'?'warning':'info',decision:decisions[r.id]||{status:'open',note:''}}));
      const list=listing(entries);return {entries:list.items,listing:list,counts:Object.fromEntries(['open','accepted','done','dismissed'].map(status=>[status,entries.filter(r=>r.decision.status===status).length])),total:entries.length};
    }
    if (tab === 'runtime') {
      const [status,usage,currentBalance]=await Promise.all([api('/api/status'),api('/api/tokens/summary?limit=20'),balance()]);
      return {status:{...status,activity:undefined},usage,balance:currentBalance};
    }
    fail('未知工作台页面');
  }
  async function command(family, text, strict = false) {
    const capture = {messages: [], error: '', active: true, strict, ownerReplyKey: strict ? `private:${facts().ownerQQ}` : ''};
    let handled;
    try {handled = await workbenchContext.run(capture, () => execute(family, text));}
    finally {capture.active = false;}
    if (!handled) fail('当前功能不可用，设置未提交');
    if (capture.error) fail(redact(capture.error));
    return {messages: capture.messages.map(r => ({key: r.key, text: redact(r.text)}))};
  }
  async function action(b) {
    const f = facts(), ownerKey = `private:${f.ownerQQ}`;
    const target = () => scope(b.key);
    if (['scope.add','scope.enabled','scope.proactive','scope.voice','capability.toggle','service.vision','service.voice-default'].includes(b.action)) {
      if (!administration) fail('机器人配置尚未连接', 503);
      const {action: name, requestId, ...input} = b;return administration.update(name, input);
    }
    if (b.action === 'command.run') {
      if (Object.keys(b).some(key => !['action','requestId','commandId','args','confirmed'].includes(key))) fail('操作字段无效');
      const operation = buildWorkbenchOperation(b.commandId, b.args, b.confirmed, allowed());
      if (operation.endpoint) {
        if (operation.endpoint === 'role') return api('/api/role', 'POST', {role: operation.values.role});
        if (operation.endpoint === 'role-clear') return api('/api/role', 'POST', {role: null});
        if (operation.endpoint === 'role-mode') return api('/api/role-mode', 'POST', {mode: operation.values.mode});
        if (operation.endpoint === 'session-reset') return api('/api/session/reset', 'POST', {key: scope(operation.values.target)});
        fail('未开放的配置操作');
      }
      return command('operator', operation.command, true);
    }
    switch (b.action) {
      case 'balance.refresh': return {balance:await balance(true)};
      case 'server.refresh': if(!serverMonitor)fail('服务器检测尚未连接',503);return {snapshot:await serverMonitor.snapshot(true)};
      case 'server.preview': if(!serverMonitor)fail('服务器维护尚未连接',503);return serverMonitor.previewCleanup();
      case 'server.cleanup': if(!serverMonitor||b.confirmed!==true)fail('请先预览并确认安全清理');return serverMonitor.applyCleanup(str(b.token,50));
      case 'diary.generate': return {entry:await execute('diary')};
      case 'record.edit': {
        if(!editRecord)fail('编辑尚未连接',503);
        if(!['note','todo','saved'].includes(b.kind)||!/^[nmt]_[a-f0-9]{8,16}$/.test(b.id||'')||!/^[a-f0-9]{64}$/.test(b.revision||''))fail('编辑记录参数无效');
        const value=str(b.text,500);if(!value)fail('正文不能为空');return editRecord({kind:b.kind,id:b.id,text:value,revision:b.revision});
      }
      case 'memory.update': {
        memoryViews.clear();
        if(!['activeTopic','pendingThought','memberImpression'].includes(b.category)||!/^[a-f0-9]{64}$/.test(b.revision||''))fail('记忆类别或版本无效');
        const content=str(b.text,200);if(!content)fail('记忆不能为空');
        return api('/api/socialV2/memory-update','POST',{key:target(),category:b.category,oldContent:str(b.original,200),target:str(b.target||'',64),newContent:content,expectedRevision:b.revision});
      }
      case 'task.edit': {
        const item=f.tasks.find(r=>r.id===b.id&&matches(r.key,target()));if(!item||!['ownerTask','ownerMemo'].includes(item.kind))fail('未找到可编辑的任务');
        if(recordRevision(item)!==b.revision)fail('任务已变化，请刷新后重新编辑',409);
        if(!['text','when'].includes(b.field))fail('任务编辑字段无效');
        return command('operator',`[${b.field==='when'?'任务改期':'任务内容'}]`+segment(item.id)+segment(str(b.text,500)),true);
      }
      case 'portrait.clear': return {portrait: store.portrait(null)};
      case 'diary.save': return store.archive('diary', str(b.text, 10000));
      case 'weekly.generate': return {entry: await execute('weekly')};
      case 'preferences.save': return store.preferences({include: str(b.include, 300), avoid: str(b.avoid, 300)});
      case 'feedback.resolve': {
        const items = await api('/api/socialV2/feedback');
        if (!(items.entries || []).some(r => r.id === b.id)) fail('原反馈不存在');
        return store.decision(b.id, {status: b.status, note: str(b.note, 1000)});
      }
      case 'role.save': return api('/api/roles/update', 'POST', {name: str(b.name, 120), content: str(b.content, 200000)});
      case 'role.select': return api('/api/role', 'POST', {role: str(b.name, 120)});
      case 'memory.append': memoryViews.clear();return api('/api/socialV2/memory-append', 'POST', {key: target(), category: 'activeTopic', content: str(b.text, 1000)});
      case 'conversation.talk': return command('extra', '[主动对话]' + segment(target()) + segment(str(b.text, 500)));
      case 'note.add': return command('owner', '[记一下]' + segment(b.text));
      case 'note.done': return command('owner', '[完成待办]' + segment(b.id));
      case 'note.restore': return command('owner', '[恢复待办]' + segment(b.id));
      case 'task.create': return command('schedule', '[定时任务]' + segment(b.when) + segment(target()) + segment(b.text));
      case 'reminder.create': return command('owner', '[提醒我]' + segment(b.when) + segment(b.text));
      case 'task.pause': return command('owner', '[暂停任务]' + segment(b.id));
      case 'task.resume': return command('owner', '[恢复任务]' + segment(b.id));
      case 'video.status': return command('bilibili', '[B站状态]');
      case 'video.browse': return command('bilibili', '[刷B站]' + segment(target()));
      case 'video.share': case 'video.watch': return command('bilibili', `[${b.action === 'video.share' ? '分享视频' : '观看视频'}]` + segment(b.video) + segment(target()));
      case 'video.enabled': if (typeof b.enabled !== 'boolean') fail('请选择开启或关闭'); return command('bilibili', '[B站浏览]' + segment(b.enabled ? '开启' : '关闭') + segment(target()));
      case 'video.interval': return command('bilibili', '[B站频率]' + segment(String(b.minutes)) + segment(target()));
      case 'video.hours': return command('bilibili', '[B站时段]' + segment(b.hours) + segment(target()));
      case 'video.limit': if (!['私聊主动', '群聊主动', '每日浏览'].includes(b.kind)) fail('限额类型无效'); return command('bilibili', '[B站限额]' + segment(b.kind) + segment(String(b.count)));
      default: fail('未知或未开放的网页指令');
    }
  }
  async function readBody(req, maxBytes = 32768) {
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) fail('请求必须使用JSON', 415);
    if (Number(req.headers['content-length']) > maxBytes) fail('请求过大', 413);
    const chunks = []; let total = 0;
    for await (const chunk of req) { total += chunk.length; if (total > maxBytes) fail('请求过大', 413); chunks.push(chunk); }
    let b;
    try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('JSON格式错误'); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) fail('JSON必须是对象');
    return b;
  }
  async function handle(req, res, url) {
    const staticFiles = {'/workbench': ['workbench.html', 'text/html'], '/workbench/': ['workbench.html', 'text/html'], '/workbench.js': ['workbench.js', 'text/javascript'], '/workbench.css': ['workbench.css', 'text/css'], '/workbench-font.woff': ['workbench-font.woff', 'font/woff'], '/workbench-controls.js': ['workbench-controls.js', 'text/javascript']};
    const asset = staticFiles[url.pathname];
    if (!asset && !url.pathname.startsWith('/api/workbench/')) return false;
    const send = (body, status = 200, extra = {}) => {
      res.writeHead(status, {'content-type': 'application/json; charset=utf-8', ...headers, ...extra});
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers['x-agent-token'] !== undefined || req.headers['x-agent-call'] !== undefined) fail('工作台仅供管理员浏览器使用', 403);
      if (asset && req.method === 'GET') {
        const content = fs.readFileSync(path.join(root, 'public', asset[0]));
        res.writeHead(200, {'content-type': asset[1] + (asset[1].startsWith('text/') ? '; charset=utf-8' : ''), ...headers});
        res.end(content); return true;
      }
      // Public origin is explicit server configuration; never trust arbitrary forwarded headers.
      const origin = publicOrigin || `${req.socket.encrypted ? 'https' : 'http'}://${req.headers.host}`;
      const secureCookie = !!publicOrigin || !!req.socket.encrypted;
      if (req.method !== 'GET' && req.headers.origin !== origin) fail('写操作来源校验失败', 403);
      if (url.pathname === '/api/workbench/login' && req.method === 'POST') {
        const b = await readBody(req), result = await auth.login(b.username, b.password, req.socket.remoteAddress || 'local');
        auth.logout(req);
        send({ok: true, username: result.session.username, csrf: result.session.csrf}, 200, {'Set-Cookie': auth.cookie(result.token, secureCookie)}); return true;
      }
      const session = await auth.session(req);
      if (!session) fail('请先登录工作台', 401);
      if (req.method !== 'GET' && req.headers['x-workbench-csrf'] !== session.csrf) fail('会话校验失败，请刷新后重试', 403);
      if (url.pathname === '/api/workbench/portrait/image' && req.method === 'GET') {
        const portrait = store.portrait();if (!portrait || !portraitStorage) fail('尚未设置形象',404);
        const result = await portraitStorage.image(portrait);
        res.writeHead(200, {...headers,'content-type':result.type,'content-length':result.bytes.length,'content-disposition':'inline'});res.end(result.bytes);return true;
      }
      if (url.pathname === '/api/workbench/portrait/upload' && req.method === 'POST') {
        if (!portraitStorage?.available()) fail('博客OSS尚未接入',503);
        const id = req.headers['x-workbench-upload-id'];if(typeof id !== 'string'||!/^[a-f0-9-]{36}$/i.test(id))fail('上传请求ID无效');
        if(Number(req.headers['content-length'])>PORTRAIT_LIMIT)fail('图片最大3MB',413);
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>PORTRAIT_LIMIT)fail('图片最大3MB',413);chunks.push(chunk);}
        const bytes=Buffer.concat(chunks);inspectPortrait(bytes);
        const fingerprint=crypto.createHash('sha256').update(bytes).digest('hex');
        for(const [key,row] of portraitUploads)if(row.expiresAt<=now())portraitUploads.delete(key);
        const previous=portraitUploads.get(id);
        if(previous){if(previous.fingerprint!==fingerprint)fail('上传请求ID已被使用',409);send({ok:true,portrait:previous.portrait});return true;}
        if(active||portraitUploads.size>=20)fail('已有操作进行中，请稍后再试',409);
        active='portrait:'+id;
        try {const portrait=store.portrait(await portraitStorage.upload(bytes));portraitUploads.set(id,{fingerprint,portrait,expiresAt:now()+900000});send({ok:true,portrait},201);}
        finally {if(active==='portrait:'+id)active=null;}
        return true;
      }
      if (url.pathname === '/api/workbench/session' && req.method === 'GET') send({ok: true, username: session.username, csrf: session.csrf, expiresAt: session.expiresAt});
      else if (url.pathname === '/api/workbench/logout' && req.method === 'POST') {
        auth.logout(req); send({ok: true}, 200, {'Set-Cookie': auth.cookie('', secureCookie, 0)});
      } else if (url.pathname === '/api/workbench/view' && req.method === 'GET') {
        const tab = url.searchParams.get('tab') || 'overview';
        // A role name is not a conversation scope.
        if (tab === 'role') send({ok: true, data: await api('/api/roles/content?name=' + encodeURIComponent(str(url.searchParams.get('name'), 120)))});
        else send({ok: true, data: await view(tab, url.searchParams.get('scope') || 'all',url.searchParams)});
      } else if (url.pathname === '/api/workbench/action' && req.method === 'POST') {
        const b = await readBody(req, 1_000_000), id = b.requestId;
        if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/i.test(id)) fail('请求ID无效');
        for (const [k, j] of jobs) if (j.expiresAt <= now()) jobs.delete(k);
        const fingerprint = crypto.createHash('sha256').update(JSON.stringify(b)).digest('hex');
        let job = jobs.get(id);
        if (job && job.fingerprint !== fingerprint) fail('请求ID已用于另一操作', 409);
        if (!job) {
          if (active || jobs.size >= 100) fail('已有操作执行中，请等待结果', 409);
          job = {id, action: str(b.action, 50), status: 'running', at: now(), expiresAt: now() + 3600000, fingerprint};
          jobs.set(id, job); active = id;
          setImmediate(async () => {
            try { job.result = await action(b); job.status = 'succeeded'; }
            catch (error) {
              const unsafe = /ENOENT|EACCES|ECONN|fetch failed|SyntaxError|\/opt\/|\/home\//.test(String(error.message));
              job.error = unsafe ? '操作未完成，请检查服务日志；不会自动重发' : redact(String(error.message).slice(0, 350));
              job.status = 'failed';
            }
            finally { if (active === id) active = null; job.finishedAt = now(); }
          });
        }
        send({ok: true, job: {id: job.id, action: job.action, status: job.status}}, 202);
      } else if (url.pathname === '/api/workbench/job' && req.method === 'GET') {
        const job = jobs.get(url.searchParams.get('id'));
        if (!job || job.expiresAt <= now()) fail('操作记录已过期；请先检查实际结果，不要直接重发', 404);
        const {fingerprint, ...data} = job; send({ok: true, job: data});
      } else fail('接口不存在', 404);
    } catch (error) {
      send({ok: false, error: error.statusCode ? error.message : '工作台资料暂不可用，请检查账号或档案文件'}, error.statusCode || 503);
    }
    return true;
  }
  return {handle};
}
