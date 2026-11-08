'use strict';
const $ = s => document.querySelector(s);
const pages = {
  profile: ['樱良', '樱良的能力档案', '她会什么、正在用什么，以及每一段对话的设置。'],
  activity: ['动态', '她的日常', '来信、行动和分享，按实际记录慢慢往下看。'],
  diaries: ['日记 / 周记', '日记与周记', '手写日记与管理员私有周记，分别保存。'],
  roles: ['人设', '人物设定', '查看原人物卡，也看清哪些内容正在生效。'],
  videos: ['视频', '刷过的视频', '观看资料、选片经过和分享结果，都放在这里。'],
  memory: ['记忆与安排', '记忆与安排', '会话记忆、明确回忆、待办和原有定时任务。'],
  feedback: ['反馈 / 需求', '她的需求箱', '她提的小问题、新想法，还有等你回应的事。'],
  commands: ['网页指令', '网页指令', '常用 QQ 指令的网页入口。每次操作都有明确结果。'],
  server: ['服务器', '服务器小管家', '手动查看资源、预览安全清理；不给服务器额外添负担。'],
  runtime: ['运行状态', '运行状态', '连接、用量和错误，按记录如实显示。']
};
let commandSelection = 'note';
let commandView = 'quick', commandCatalogSelection = '1';
let feedbackFilters = {status: 'all', kind: 'all', date: ''};
let csrf = '', overview = null, tab = 'profile', generation = 0, roleRequest = 0, busy = false;
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null) n.setAttribute(k, v);
  }
  for (const child of children.flat(Infinity)) if (child !== null && child !== undefined) n.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return n;
}
const time = at => at ? new Date(at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai', hour12: false}) : '时间未记录';
const scopeName = key => key === overview?.ownerKey ? '管理员私聊' : contactLabel(String(key || ''));
const text = value => el('div', {class: 'body-text'}, String(value || ''));
const tag = (value, kind = '') => el('span', {class: `tag ${kind}`}, value);
const statusName = s => ({sent: '分享已确认', failed: '未完成', pending: '待确认', unconfirmed: '发送待确认', candidates: '真实候选', selected: '已选择', skipped: '本轮未选择', open: '待处理', accepted: '已接纳', done: '已完成', dismissed: '暂不处理'}[s] || s || '未记录');
const empty = (title, hint) => el('div', {class: 'empty'}, el('strong', {}, title), hint);
const panel = (title, ...body) => el('section', {class: 'panel'}, el('h2', {}, title), body);
const details = (title, body) => el('details', {}, el('summary', {}, title), el('pre', {}, typeof body === 'string' ? body : JSON.stringify(body, null, 2)));
const field = (label, name, {type = 'text', value = '', options, required = true, max = 1000, placeholder = ''} = {}) => {
  let input;
  if (options) input = el('select', {name, ...(required ? {required: ''} : {})}, options.map(([v, t]) => el('option', {value: v, ...(String(v) === String(value) ? {selected: ''} : {})}, t)));
  else if (type === 'textarea') input = el('textarea', {name, maxlength: max, placeholder, ...(required ? {required: ''} : {})}, value);
  else input = el('input', {name, type, value, maxlength: max, placeholder, ...(required ? {required: ''} : {})});
  input.setAttribute('aria-label', label); return el('label', {}, label, el('span', {class: 'control'}, input));
};
function targetField() {
  return contactField('操作目标', 'key', {value: $('#scope').value === 'all' ? overview.ownerKey : $('#scope').value, allowed: true});
}

let commandOperationSelections = {};
let contactDirectoryMessage = '';
let contactEntries = [], contactLookup = new Map(), contactSequence = 0;
const contactText = key => {const row=contactLookup.get(key);return row ? [row.name,row.remark,row.nickname,...row.aliases,row.id,row.key].join(' ').toLocaleLowerCase() : String(key).toLocaleLowerCase();};
function contactLabel(key) {
  if (!key) return '（未选择）';
  const row=contactLookup.get(key),kind=key.startsWith('group:')?'群聊':'私聊',id=key.split(':')[1];
  return row?.name && row.name!==id ? `${row.name}（${kind} ${id}）` : `${kind} ${id}`;
}
function contactField(label, name, {value='', kind='any', allowed=false, required=true, format='key'}={}) {
  const popupId='contact-options-'+(++contactSequence);
  const hidden=el('input',{type:'hidden',name}),input=el('input',{type:'search',role:'combobox','aria-autocomplete':'list','aria-label':label,'aria-haspopup':'listbox','aria-expanded':'false','aria-controls':popupId,autocomplete:'off',placeholder:'搜索昵称、备注、群名、别名或号码',...(required?{required:''}:{})});
  const popup=el('div',{class:'contact-options',id:popupId,role:'listbox','aria-label':label+'的搜索结果',hidden:''});
  const hint=el('span',{class:'contact-hint',role:'status'});
  let selected=value,active=-1,candidates=[];
  const kindNow=()=>typeof kind==='function'?kind():kind;
  const rows=()=>contactEntries.filter(row=>(kindNow()==='any'||row.kind===kindNow())&&(!allowed||overview?.scopes.includes(row.key)||row.key===overview?.ownerKey));
  function close(){popup.hidden=true;input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');}
  function choose(key){selected=key;hidden.value=format==='id'?key.split(':')[1]:key;input.value=contactLabel(key);input.setCustomValidity('');hint.textContent='已选择 '+contactLabel(key)+(contactDirectoryMessage?' · '+contactDirectoryMessage:'');close();}
  function paint(){[...popup.querySelectorAll('[role=option]')].forEach((button,i)=>{button.classList.toggle('is-active',i===active);button.setAttribute('aria-selected',String(candidates[i]?.key===selected));});if(active>=0){input.setAttribute('aria-activedescendant',popupId+'-'+active);popup.children[active]?.scrollIntoView({block:'nearest'});} }
  function show(){
    const query=(input.value===contactLabel(selected)?'':input.value).trim().toLocaleLowerCase();
    candidates=rows().filter(row=>!query||contactText(row.key).includes(query)).slice(0,12);active=-1;
    const numeric=/^(?:(private|group):)?([1-9]\d{4,11})$/.exec(query);
    if (!allowed && numeric) {
      const kinds=numeric[1]?[numeric[1]]:kindNow()==='any'?['private','group']:[kindNow()];
      for(const type of kinds)if((kindNow()==='any'||kindNow()===type)&&!candidates.some(row=>row.key===type+':'+numeric[2]))candidates.push({key:type+':'+numeric[2],id:numeric[2],kind:type,name:type==='group'?'按群号指定':'按 QQ 号指定',nickname:'',remark:'',aliases:[]});
    }
    popup.replaceChildren(...candidates.map((row,index)=>el('button',{type:'button',role:'option',id:popupId+'-'+index,'aria-selected':String(row.key===selected),onpointerdown:event=>event.preventDefault(),onclick:()=>choose(row.key)},el('strong',{},row.name),el('span',{},(row.kind==='group'?'群聊 ':'好友 ')+row.id+(row.remark&&row.nickname&&row.remark!==row.nickname?' · '+row.nickname:'')))));
    if(!candidates.length)popup.append(el('p',{class:'contact-empty'},'没有匹配项，请换个名字或号码。'));
    popup.hidden=false;input.setAttribute('aria-expanded','true');popup.classList.remove('above');const bounds=popup.getBoundingClientRect();if(bounds.bottom>innerHeight-12&&input.getBoundingClientRect().top>bounds.height+12)popup.classList.add('above');
  }
  input.addEventListener('focus',show);
  input.addEventListener('input',()=>{hidden.value='';input.setCustomValidity(input.value.trim()||required?'请从候选中选择目标，重名时核对号码。':'');hint.textContent='可按昵称、备注、群名、别名搜索；重名请核对号码。';show();});
  input.addEventListener('keydown',event=>{
    if (event.isComposing || event.keyCode === 229) return;
    if(event.key==='Escape'){event.preventDefault();if(selected)choose(selected);else close();}
    else if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();if(popup.hidden)show();if(candidates.length){active=active<0?(event.key==='ArrowDown'?0:candidates.length-1):(active+(event.key==='ArrowDown'?1:-1)+candidates.length)%candidates.length;paint();}}
    else if(event.key==='Enter'&&!popup.hidden){event.preventDefault();if(active>=0)choose(candidates[active].key);else if(candidates.length===1)choose(candidates[0].key);else hint.textContent='请在候选列表中明确选择一项。';}
  });
  const picker=el('div',{class:'contact-picker'},el('span',{class:'control'},input),hidden,popup,hint);
  picker.addEventListener('focusout',()=>setTimeout(()=>{if(!picker.contains(document.activeElement))close();},0));
  picker.resetSelection=()=>{selected='';hidden.value='';input.value='';input.setCustomValidity(required?'请选择目标':'');close();hint.textContent='';};
  if(value)choose(value);else {if(required)input.setCustomValidity('请选择目标');hint.textContent=contactDirectoryMessage;}
  return el('label',{class:'contact-label'},label,picker);
}

function operationArea(item) {
  if(!item.operations?.length)return null;
  const selector=field('选择要执行的操作','operationChoice',{value:commandOperationSelections[item.id]||item.operations[0].id,options:item.operations.map(operation=>[operation.id,operation.label])});
  const body=el('div',{class:'operation-form-area'}),cache=new Map();
  function build(operation){
    const fields=operation.fields.map(f=>f.type==='target'?contactField(f.label,f.name,{kind:f.kind,allowed:f.allowed,required:!f.optional,value:f.allowed?(f.kind==='group'?overview.scopes.find(key=>key.startsWith('group:'))||'':overview.ownerKey):''}):field(f.label,f.name,{type:f.type==='number'?'number':f.type==='text'&&f.max>=500?'textarea':'text',value:f.value||'',options:f.options,required:!f.optional,max:f.max||1000}));
    const n=form('command.run',fields,operation.risk==='read'?'查询':'执行操作',operation.risk==='read'?undefined:values=>{
      const risk=operation.risk==='danger'?'此操作可能删除或改变已有资料，请核对目标与参数。':operation.risk==='model'?'此操作可能调用模型、产生费用或向 QQ 发消息。':operation.risk==='send'?'此操作可能向 QQ 或 QQ空间发送、发布或互动。':'此操作会保存设置或修改原有记录。';
      return `执行「${operation.label}」？\n${risk}\n\n`+operation.fields.map(f=>f.label+'：'+(f.type==='target'?contactLabel(values[f.name]||''):values[f.name]||'（未填）')).join('\n');
    },{commandId:operation.id});
    n.classList.add('operator-form');
    n.prepend(el('p',{class:'operation-purpose'},operation.delivery==='qq'?'聊天记录会合并转发到管理员 QQ；网页显示回执。':operation.risk==='read'?'点击查询后，结果显示在网页。':'填写参数后执行；原有权限、额度和确认要求继续生效。'));
    return n;
  }
  function choose(){const id=selector.querySelector('select').value;commandOperationSelections[item.id]=id;const operation=item.operations.find(row=>row.id===id);if(!cache.has(id))cache.set(id,build(operation));body.replaceChildren(cache.get(id));}
  selector.querySelector('select').addEventListener('change',choose);choose();
  return el('section',{class:'operation-workspace'},selector,body);
}

async function request(path, body, method = body ? 'POST' : 'GET') {
  const res = await fetch('/api/workbench/' + path, {method, credentials: 'same-origin', headers: body ? {'content-type': 'application/json', 'x-workbench-csrf': csrf} : {}, ...(body ? {body: JSON.stringify(body)} : {}), signal: AbortSignal.timeout(30000)});
  const data = await res.json();
  if (res.status === 401) { showLogin(); throw Error('登录已过期，请重新登录'); }
  if (!res.ok || data.ok === false) throw Object.assign(Error(data.error || '请求未完成，请稍后重试'), {status: res.status});
  return data;
}
function showLogin() { window.WorkbenchControls.close();profileSection = 'capabilities';commandSelection = 'note';commandView = 'quick';commandCatalogSelection = '1';commandOperationSelections = {}; feedbackFilters = {status: 'all', kind: 'all', date: ''}; clearTimeout(serverAlarmTimer);serverPreview=null;listFilters={};selectedRole='';csrf = ''; overview = null; generation++; $('#app').hidden = true; $('#login-screen').hidden = false; $('#content').replaceChildren(); }
function showError(error) { $('#page-error').textContent = error.message || String(error); $('#page-error').hidden = false; }
async function confirmAction(message, trigger=document.activeElement) {
  const dialog = $('#confirm-dialog'),position={x:scrollX,y:scrollY,tab,sequence:generation}; $('#confirm-text').textContent = message; dialog.returnValue = '';
  return new Promise(resolve => { dialog.addEventListener('close', () => {
    const same=generation===position.sequence&&tab===position.tab;
    if(same)window.scrollTo({left:position.x,top:position.y,behavior:'instant'});
    resolve(dialog.returnValue === 'confirm');
    requestAnimationFrame(()=>{if(same&&generation===position.sequence&&trigger?.isConnected&&trigger!==document.body&&!trigger.disabled)trigger.focus({preventScroll:true});});
  }, {once: true}); dialog.showModal(); });
}
function operation(status, message) { const n = $('#operation'); n.hidden = false; n.dataset.status = status; n.textContent = message; }
async function pollJob(id) {
  busy = true;
  try {
    for (let i = 0; i < 750; i++) {
      const {job} = await request('job?id=' + encodeURIComponent(id));
      if (job.status !== 'running') {
        sessionStorage.removeItem('workbench-pending');
        if(job.action==='server.preview'&&job.status==='succeeded')serverPreview=job.result.preview;
        if(job.action==='server.cleanup')serverPreview=null;
        operation(job.status, job.status === 'failed' ? `操作未完成：${job.error}` : (job.action === 'command.run' ? '处理结果：' : '操作已完成。') + (job.result?.messages?.length ? '\n' + job.result.messages.map(m => m.text).join('\n') : ''));
        if (job.status === 'succeeded' && /^(scope\.|capability\.|service\.)/.test(job.action)) await enter();else await loadPage(); return;
      }
      operation('running', '正在执行，请等待结果。无需再次提交。');
      await new Promise(resolve => setTimeout(resolve, 800));
    }
    operation('running', '操作仍在执行；请刷新检查结果，不要重复发送。');
  } catch (error) {
    operation('failed', `${error.message}\n操作可能仍在执行。重新登录或刷新后检查结果，避免重复提交。`);
    if (error.status === 404) $('#operation').append(el('div', {class: 'actions'}, el('button', {type: 'button', onclick: async () => {
      if (await confirmAction('请先在对应页面或 QQ 核对操作是否完成。确认已核对后，解除待确认状态？')) {sessionStorage.removeItem('workbench-pending'); operation('succeeded', '已解除待确认状态。');}
    }}, '已核对结果，解除待确认状态')));
  }
  finally { busy = false; }
}
async function submitAction(body, confirmation, trigger) {
  if (busy || sessionStorage.getItem('workbench-pending')) { operation('running', '已有操作等待确认结果，请刷新检查。'); return; }
  if (confirmation && !await confirmAction(confirmation,trigger)) return;
  busy = true;
  const requestId = crypto.randomUUID();
  // Save before sending: a disconnected response must never trigger an automatic resubmission.
  sessionStorage.setItem('workbench-pending', requestId);
  try {
    const {job} = await request('action', {...body, requestId});
    await pollJob(job.id);
  } catch (error) {
    if (error.status && error.status < 500) sessionStorage.removeItem('workbench-pending');
    operation('failed', error.message + '\n请刷新检查操作结果，避免重复提交。');
  } finally { busy = false; }
}
function form(action, fields, label = '保存', confirmation, values = {}) {
  const n = el('form', {class: 'form-grid'}, fields, el('div', {class: 'actions'}, el('button', {type: 'submit', class: 'primary'}, label)));
  n.addEventListener('submit', async event => { event.preventDefault(); const button = n.querySelector('button[type=submit]'); button.disabled = true; let data = {action, ...values, ...Object.fromEntries(new FormData(n))}; if (action === 'command.run') data = {action, commandId: values.commandId, args: Object.fromEntries(new FormData(n)), confirmed: true}; if (action === 'video.enabled') data.enabled = data.enabled === 'true'; if (action === 'scope.video-limit') {data.dailyLimit = data.limitMode === 'default' ? null : Number(data.dailyLimit); delete data.limitMode;} try { await submitAction(data, typeof confirmation === 'function' ? confirmation(data.args || data) : confirmation,button); } finally { button.disabled = false; } });
  return n;
}
function actionButton(label, action, values, confirmation) { return el('button', {type: 'button', onclick: event => { const n = event.currentTarget; n.disabled = true; submitAction({action, ...values}, confirmation,n).finally(() => {n.disabled = false;}); }}, label); }
function record(title, at, key, body, badges = [], kind = '') { const id=badges.filter(Boolean).map(v=>v.textContent||'').find(v=>/^[nmrt]_[a-f0-9]+$/.test(v))||'';return el('article', {class: `record ${kind}`,'data-view-key':[key||'',at||'',title||'',id].join('|')}, el('div', {class: 'record-meta'}, time(at), key ? tag(scopeName(key)) : null, badges), title ? el('h3', {}, title) : null, body); }
function videoEvents(events) {
  return events.length ? events.map(r => record(r.bvid || '选片记录', r.at, r.key, [text(r.detail), r.candidates?.length ? details('查看候选与来源', r.candidates) : null], [tag(statusName(r.status), 'blue')])) : empty('还没有选片过程记录', '工作台启用后记录真实搜索与选择；旧记录不补造。');
}

// Segments summarize actual counts; they never represent invented skill levels.
function segments(value, total) {
  const filled = total > 0 ? Math.floor(Math.min(value / total, 1) * 10) : 0;
  return el('span', {class: 'skill-track', 'aria-hidden': 'true'}, Array.from({length: 10}, (_, i) => el('i', {class: i < filled ? 'filled' : ''})));
}
function attribute(icon, label, value, state = '') {
  return el('div', {class: 'attribute-row', ...(state ? {'data-state': state} : {})}, pixelIcon(icon), el('dt', {}, label), el('dd', {}, value));
}

// Original still-life drawings on a 96×48 grid; decoration only, no external assets.
function paperArt(kind = 'desk') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 96 48');svg.setAttribute('shape-rendering', 'crispEdges');svg.setAttribute('aria-hidden', 'true');
  const paths = kind === 'branch' ? [
    ['#a28d75','M10 42h12v-4h12v-4h12v-4h12v-6h10v-8h4v-8h2v10h-4v8H60v6H48v4H36v4H24v4H10z'],
    ['#97aa83','M20 30h8v4h4v4h-8v-2h-4zM36 22h8v4h4v6h-6v-4h-6zM58 10h6v4h4v6h-6v-4h-4z'],
    ['#b6c39f','M24 30h4v4h-4zM40 22h4v4h-4zM60 10h4v4h-4z'],
    ['#c9909e','M38 8h6v2h4v6h-2v4h-6v-2h-4v-6h2zM68 24h6v2h4v6h-2v4h-6v-2h-4v-6h2zM80 6h6v2h4v6h-2v4h-6v-2h-4v-6h2z'],
    ['#e9bcc5','M40 10h4v4h-4zM70 26h4v4h-4zM82 8h4v4h-4z'],
    ['#fff0cc','M42 14h2v2h-2zM72 30h2v2h-2zM84 12h2v2h-2z'],
    ['#b1a6bc','M52 40h4v2h-4zM84 30h4v2h-4z']
  ] : [
    ['#ddd5bd','M6 42h84v2H6z'],
    ['#b5906c','M4 38h88v4H4z'],['#d7b58b','M6 38h84v2H6z'],
    ['#8e807a','M16 28h28v2h4v8H16z'],['#b09ab1','M18 28h24v2h4v6H18z'],
    ['#f4e5c8','M20 30h24v4H20z'],['#9b7b87','M12 22h28v6H12z'],['#c990a0','M14 22h24v2H14z'],
    ['#f9eed6','M14 24h24v2H14z'],['#a99a73','M34 22h2v10l-2-2-2 2V22z'],
    ['#8e9590','M54 28h16v2h4v6h-4v2H56v-2h-2z'],['#cfdbcc','M56 28h12v8H56zM70 30h2v4h-2z'],
    ['#fff2d7','M56 28h12v2H56z'],['#b2bfa8','M58 34h8v2h-8z'],
    ['#b3a6ad','M60 16h2v4h-2v4h-2v-4h2zM66 12h2v4h-2v4h-2v-4h2z'],
    ['#89996d','M80 14h2v14h-2zM76 18h4v2h-4zM82 22h4v2h-4z'],
    ['#c9909e','M76 6h8v2h2v6h-2v2h-8v-2h-2V8h2z'],['#e9bcc5','M76 8h4v4h-4z'],
    ['#fff0cc','M80 10h2v2h-2z'],['#b09ab1','M76 26h10v2h2v8h-2v2H76v-2h-2v-8h2z'],
    ['#d8c6d6','M76 28h8v4h-8z'],['#e9dcc0','M8 12h2v2H8zM48 8h2v2h-2z']
  ];
  for (const [fill, d] of paths) {const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');path.setAttribute('fill', fill);path.setAttribute('d', d);svg.append(path);}
  return el('div', {class: 'paper-art paper-art-' + kind, 'aria-hidden': 'true'}, svg);
}

let listFilters={},serverPreview=null,serverAlarmTimer=null;
const listTabs=['activity','diaries','videos','memory','feedback'];
const currentFilters=()=>listFilters[tab]||{from:'',to:'',q:'',kind:'all',state:'all',page:1,size:12};
function pagedList(d,kinds,render,{before=[],after=[],states}={}) {
  const list=d.listing||{items:[],total:0,page:1,pages:1,size:12},values=currentFilters();
  const filters=el('form',{class:'record-filters','aria-label':'记录筛选'},
    field('开始日期 · 北京时间','from',{type:'date',required:false,value:values.from}),
    field('结束日期 · 北京时间','to',{type:'date',required:false,value:values.to}),
    field('查找记录','q',{required:false,value:values.q,max:120,placeholder:'输入正文关键词'}),
    field('分类','kind',{options:[['all','全部分类'],...kinds],value:values.kind}),
    states?field('处理状态','state',{options:[['all','全部状态'],...states],value:values.state}):null,
    field('每页条数','size',{options:[['6','6 条'],['12','12 条'],['24','24 条']],value:String(values.size)}),
    el('div',{class:'actions'},el('button',{type:'submit',class:'primary'},'查找'),el('button',{type:'button',class:'quiet',onclick:()=>{delete listFilters[tab];loadPage();}},'清空筛选')));
  filters.addEventListener('submit',event=>{event.preventDefault();listFilters[tab]={...Object.fromEntries(new FormData(filters)),page:1};loadPage();});
  filters.querySelector('[name=size]').addEventListener('change',()=>filters.requestSubmit());
  const go=page=>{listFilters[tab]={...currentFilters(),page};loadPage();};
  const pager=()=>el('nav',{class:'record-pagination','aria-label':'记录分页'},
    el('span',{role:'status'},`共 ${list.total} 条 · 第 ${list.page} / ${list.pages} 页`),
    el('div',{class:'actions'},el('button',{type:'button',...(list.page<=1?{disabled:''}:{}),onclick:()=>go(list.page-1)},'上一页'),el('button',{type:'button',...(list.page>=list.pages?{disabled:''}:{}),onclick:()=>go(list.page+1)},'下一页')));
  return el('div',{class:'paged-records'},filters,before,pager(),
    el('div',{class:'paged-record-list'},list.items.length?list.items.map(render):empty('没有符合条件的记录','换一个日期、分类或关键词，或清空筛选。')),
    pager(),list.undated?el('p',{class:'muted small'},`${list.undated} 条旧记录没有日期；设置日期范围时会排除这些记录。`):null,after);
}
function activityCard(r){return record(r.title,r.at||0,r.key,r.text.length>360?[text(r.text.slice(0,240)+'…'),details('展开她的完整记录',r.text)]:text(r.text),[tag(({reflection:'她的独白',qzone:'QQ 空间',private:'私聊消息',group:'群聊消息',arrangement:'提醒与安排',feedback:'反馈'})[r.kind]||'活动'),r.notSent?tag('未发送到 QQ'):null],`activity-record activity-${r.kind}`);}
function renderActivity(d) {
  return pagedList(d,[['reflection','樱良的独白'],['qzone','QQ 空间动态'],['private','私聊互动'],['group','群聊互动'],['arrangement','提醒与安排'],['feedback','她的反馈']],activityCard,{before:[el('p',{class:'muted small'},'只收录角色感想与实际行动，工具流水不在这里展示。新活动最多保留最近 30 天的 500 条。')],after:[el('p',{class:'muted small'},d.legacyNote)]});
}
function renderDiaries(d) {
  return el('div',{class:'layout diary-page'},pagedList(d,[['diary','日记'],['weekly','周记']],r=>record(r.kind==='weekly'?'樱良的本周回忆':r.source==='manual'?'历史手写记录':'樱良的日记',r.at,'',text(r.text.replace(/^【管理员私有周记｜不入聊天记忆】\s*/,'')),[tag('管理员私有'),tag(r.source==='manual'?'历史手动保存':'她整理的回忆')],'diary-record')),
    el('aside',{},panel('樱良的一本日记',el('p',{class:'muted'},'由樱良整理当天真实活动，以她的口吻写下感受。所有对话共用一本，每天最多生成一篇，不按私聊和群聊分别写。'),el('p',{class:'small muted'},'点击时才调用模型；资料不足会提示，刷新和翻页不会生成。只在工作台保存，不发 QQ，也不写回聊天记忆。'),actionButton('整理今天的日记','diary.generate',{},'用今天已有活动生成樱良的一篇私人日记？会调用一次现有文本模型，可能产生费用；今天已有日记时直接打开原稿。')),panel('这一周的回忆',el('p',{class:'small muted'},'按明确保存的回忆和完成事项整理一份私人周记，同样不按会话分别写。'),actionButton('整理本周回忆','weekly.generate',{},'按现有周记生成器整理并保存本周回忆，可能调用模型；不会发往 QQ。')),paperArt('desk')));
}

async function loadRole(name, container) {
  const pageGeneration = generation, ticket = ++roleRequest;
  const {data: r} = await request('view?tab=role&name=' + encodeURIComponent(name));
  if (pageGeneration !== generation || ticket !== roleRequest || tab !== 'roles') return;
  const n = form('role.save', [field('人物卡正文', 'content', {type: 'textarea', value: r.content, max: 200000})], '保存人物卡', '保存后，原人物卡内容会更新，并在后续对话中使用。', {name});
  n.querySelector('textarea').classList.add('role-editor');
  const sectionRows = (r.sections?.[overview.status.mode === 'reserved' ? 'v1' : 'v2'] || []).map(s => el('tr', {}, el('td', {}, s.heading), el('td', {}, s.chars), el('td', {}, tag(s.injected ? '会注入' : '不注入此模式', s.injected ? 'good' : ''))));
  const retained=container.isConnected?captureView():null;
  container.replaceChildren(panel(name, tag(name === overview.status.role ? '当前人物卡' : '可切换'), el('p', {class: 'small muted'}, `${r.chars || r.content.length} 字符；注入上限 ${r.limits?.injectMaxChars ?? '按原配置'}。超出上限的内容仍受原有截断规则约束。`), n, el('div', {class: 'actions'}, actionButton('设为当前人物卡', 'role.select', {name}, `将当前人物卡切换为「${name}」？`))), panel('当前模式的小节生效情况', el('div', {class: 'table-wrap'}, el('table', {}, el('thead', {}, el('tr', {}, ['小节', '字符', '生效情况'].map(s => el('th', {}, s)))), el('tbody', {}, sectionRows))), r.warnings?.length ? details('人物卡提示', r.warnings) : null));
  await new Promise(resolve=>requestAnimationFrame(resolve));if(ticket===roleRequest)restoreView(retained,pageGeneration);
}
let selectedRole='';
async function renderRoles(d) {
  const area = el('div', {}, empty('选择人物卡', '读取原文和当前模式的生效小节。'));
  const chosen=d.roles.includes(selectedRole)?selectedRole:d.current||d.roles[0];
  const select = field('人物卡', 'role', {value: chosen, options: d.roles.map(name => [name, name + (name === d.current ? '（当前）' : '')])});
  select.querySelector('select').addEventListener('change', event => {selectedRole=event.target.value;loadRole(selectedRole,area).catch(showError);});
  if (d.roles.length) {selectedRole=chosen;await loadRole(chosen,area);}
  return el('div', {}, panel('人物卡管理', select), area);
}
function videoForms() {
  return [panel('指定一个视频', form('video.share', [targetField(), field('视频链接或 BV 号', 'video', {placeholder: 'https://www.bilibili.com/video/BV…'})], '分享图文到 QQ', '将指定视频以普通图文发送到所选 QQ 会话。不会自动重发。'), el('p', {class: 'small muted'}, '仅分享标题、封面和链接。需要先分析再分享时，使用下方入口。'), form('video.watch', [targetField(), field('先观看的视频', 'video')], '观看后分享到 QQ', '将采样分析视频并分享到所选 QQ 会话，可能产生模型费用并占用原有额度。')),
    panel('主动浏览', form('video.enabled', [targetField(), field('自动浏览', 'enabled', {options: [['false', '关闭'], ['true', '开启']]})], '更新浏览开关', '更改所选会话的自动浏览设置？'), form('video.interval', [targetField(), field('间隔分钟（30–1440）', 'minutes', {type: 'number', value: '180'})], '设置间隔'), form('video.hours', [targetField(), field('北京时间整点时段', 'hours', {value: '20:00-24:00'})], '设置时段'))];
}
function videoScopeSwitch(scope) {
  return el('div', {class: 'scope-setting'}, el('span', {}, '主动发视频'), switchControl(contactLabel(scope.key) + '的主动视频', scope.video.enabled, enabled => submitAction({action: 'scope.video', key: scope.key, revision: scope.revision, enabled}), !scope.enabled));
}
function videoScopeSettings(scopes) {
  const rows = scopes.filter(scope => scope.video?.available).map(scope => {
    const mode = field('每日上限方式', 'limitMode', {value: scope.video.dailyLimit === null ? 'default' : 'custom', options: [['default', '跟随私聊／群聊默认值'], ['custom', '单独设置此会话']]});
    const count = field('每日主动视频上限（0–100）', 'dailyLimit', {type: 'number', value: String(scope.video.dailyLimit ?? scope.video.effectiveLimit)});
    const input = count.querySelector('input'); input.min = '0'; input.max = '100'; input.step = '1';
    const editor = form('scope.video-limit', [mode, count], '保存每日上限', undefined, {key: scope.key, revision: scope.revision});
    const updateMode = () => {input.disabled = mode.querySelector('select').value === 'default' || !scope.enabled;};
    mode.querySelector('select').addEventListener('change', updateMode); updateMode();
    if (!scope.enabled) editor.querySelectorAll('select,button').forEach(n => n.disabled = true);
    return el('article', {class: 'scope-card video-scope', 'data-key': scope.key}, el('h3', {}, scope.owner ? '管理员本人' : contactLabel(scope.key)), videoScopeSwitch(scope), el('p', {class: 'muted small'}, '今日已用 ' + scope.video.used + ' / ' + scope.video.effectiveLimit + ' 条 · ' + scope.video.status), editor);
  });
  return panel('每个会话的主动视频', el('p', {class: 'muted small'}, '与档案中的会话开关同步。北京时间每日计数，0 暂停；手动指定分享不占主动额度。上限不是发送次数承诺，仍受选片、时段和全局每日深读最多6条约束。'), rows.length ? rows : empty('暂无可管理会话', '请先在樱良档案加入白名单会话。'));
}
function renderVideos(d) {
  const item=r=>{
    if(r.kind==='watched')return record(r.title||r.ref,r.at,r.key,[r.cover?el('img',{src:r.cover,alt:'',class:'video-cover',loading:'lazy',referrerpolicy:'no-referrer'}):null,text(r.coverage),r.summary?details('观看资料',r.summary):text('未留存观看正文。'),el('a',{href:'https://www.bilibili.com/video/'+r.ref.split(':')[0],target:'_blank',rel:'noopener noreferrer'},'查看原视频')],[tag('观看资料'),tag('保留至 '+time(r.expiresAt))],'video-record');
    if(r.kind==='indexed')return record(r.ref,r.at,'',text('观看正文已过期，只保留视频编号、分 P 与索引时间。'),[tag('历史视频索引')]);
    if(r.kind==='shared')return record(r.bvid,r.at,r.key,text(r.automatic?'主动分享':'手动指定分享'),[tag('分享记录'),tag(statusName(r.status),r.status==='sent'?'good':'warn')]);
    return record('选片与感想',r.at,r.key,[text(r.detail||statusName(r.status)),(r.candidates||[]).map(c=>text(c.title||c.bvid))],[tag('选片记录')],'video-record');
  };
  const preferences=form('preferences.save',[field('想多看什么','include',{type:'textarea',required:false,value:d.preferences.include,max:300}),field('少看什么','avoid',{type:'textarea',required:false,value:d.preferences.avoid,max:300})],'保存选片偏好');
  return el('div',{class:'layout video-page'},el('div', {}, videoScopeSettings(d.videoScopes || []), pagedList(d,[['watched','观看资料'],['shared','分享记录'],['selection','选片与感想'],['indexed','历史视频索引']],item,{before:[el('p',{class:'muted small'},'按实际分析或分享时间筛选；观看正文保留 72 小时，翻页不会重新分析视频。')]})),el('aside',{},panel('引导她选片',preferences),panel('当前设置',details('计划与限额',{targets:d.targets,limits:d.limits})),el('details',{class:'video-actions'},el('summary',{},'分享与浏览操作'),videoForms())));
}
function renderMemory(d) {
  const types={note:'私人待办',todo:'截图待办',task:'提醒与定时任务',saved:'明确保存的回忆',conversation:'会话记忆'};
  const item=r=>{
    let editor=null;const body=r.correction||r.text||'';
    if(['note','todo','saved'].includes(r.kind))editor=form('record.edit',[field(r.kind==='saved'?'更正说明（保留原始引用）':'修改内容','text',{type:'textarea',max:500,value:body})],'保存修改','保存此项修改？旧页面或并发更新会拒绝覆盖。',{kind:r.kind,id:r.id,revision:r.revision});
    if(r.kind==='conversation')editor=form('memory.update',[field('修改记忆内容','text',{type:'textarea',max:200,value:r.text})],'保存记忆','修改此会话的这一条记忆？会影响之后的对话。',{key:r.key,category:r.category,original:r.text,target:r.target||'',revision:r.revision});
    if(r.kind==='task'&&['ownerTask','ownerMemo'].includes(r.kind))editor=el('div',{},form('task.edit',[field('新的任务内容','text',{type:'textarea',max:500,value:r.text})],'保存任务内容','修改这个任务的内容？',{id:r.id,key:r.key,revision:r.revision,field:'text'}),form('task.edit',[field('新的执行时间','text',{placeholder:'明天9点 / 30分钟后',max:80})],'调整时间','调整这个任务的执行时间？',{id:r.id,key:r.key,revision:r.revision,field:'when'}));
    const actions=el('div',{class:'actions'},r.kind==='note'?actionButton(r.done?'恢复待办':'完成待办',r.done?'note.restore':'note.done',{id:r.id}):null,r.kind==='task'&&['ownerTask','ownerMemo'].includes(r.kind)?actionButton(r.paused?'恢复任务':'暂停任务',r.paused?'task.resume':'task.pause',{id:r.id},'更改此任务的暂停状态？'):null);
    return record(r.kind==='conversation'?(r.target||({activeTopic:'会话话题',pendingThought:'待说的话'})[r.category]):types[r.kind],r.at||0,r.key||overview.ownerKey,[text(body),r.kind==='saved'&&r.correction?details('原始引用',r.text):null,r.kind==='task'?text(r.paused?'已暂停':r.repeat||'等待到点执行'):null,actions,editor?el('details',{class:'record-editor'},el('summary',{},'编辑这一条'),editor):el('p',{class:'muted small'},'此类系统提醒暂只读。')],[r.id?tag(r.id):null]);
  };
  return el('div',{class:'layout memory-page'},pagedList(d,Object.entries(types),item,{before:[el('p',{class:'muted small'},'可修改待办、引用回忆的更正说明、会话记忆，以及管理员提醒和定时任务。任务日期按预定执行时间筛选。')]}),el('aside',{},panel('记一个待办',form('note.add',[field('待办内容','text',{type:'textarea',max:500})],'记下来')),panel('添加会话话题',form('memory.append',[targetField(),field('话题内容','text',{type:'textarea',max:200})],'保存到该会话','将内容追加到所选会话的话题记忆？')),taskForms()));
}
function taskForms() {
  return [panel('提醒我', form('reminder.create', [field('什么时候', 'when', {placeholder: '明天早上9点 / 30分钟后'}), field('提醒内容', 'text', {type: 'textarea'})], '创建私人提醒', '将在指定时间向管理员本人发送提醒。')), panel('安排定时任务', form('task.create', [targetField(), field('执行时间', 'when', {placeholder: '明天8点 / 每天20点'}), field('到时做什么', 'text', {type: 'textarea'})], '创建定时任务', '到时会向所选会话执行原有定时任务，可能调用模型并发送 QQ 消息。'))];
}
function renderFeedback(d) {
  const rows = d.entries;
  const counts = ['open', 'accepted', 'done', 'dismissed'].map(state => d.counts?.[state] ?? rows.filter(r => r.decision.status === state).length);
  const stats = el('div', {class: 'feedback-stats', 'aria-label': '反馈统计'}, [
    [counts[0], '待你看', 'open', 'feedback'],
    [counts[1], '已收到', 'accepted', 'envelope'],
    [counts[2], '已实现', 'done', 'check'],
    [counts[3], '不做', 'dismissed', 'archive']
  ].map(([count, label, kind, icon]) => el('div', {class: 'stat-box', 'data-kind': kind, 'aria-label': `${label} ${count} 条，当前范围共 ${(d.total ?? rows.length)} 条；分段表示占比`}, el('span', {class: 'skill-label'}, pixelIcon(icon), label), segments(count, (d.total ?? rows.length)), el('strong', {}, count))));
  const completion = el('aside', {class: 'bundle-progress', 'aria-label': '需求完成情况'},
    el('div', {class: 'bundle-emblem'}, pixelIcon('blossom')),
    el('div', {}, el('h2', {class: 'title-plaque'}, '需求收集册'), el('p', {class: 'muted'}, '每一条，都有回应'),
      el('div', {class: 'completion-count'}, el('strong', {}, counts[2]), ' / ', (d.total ?? rows.length), el('span', {}, ' 条已实现')),
      el('progress', {value: counts[2], max: Math.max((d.total ?? rows.length), 1), 'aria-label': `已实现 ${counts[2]} 条，共 ${(d.total ?? rows.length)} 条反馈`})));
  const names = {open: '待你看', accepted: '收到', done: '已实现', dismissed: '不做'};
  const cards = rows.map(r => {
    const state = r.decision.status;
    const level = r.level === 'error' ? '问题' : r.level === 'warning' ? '提醒' : '反馈';
    const lines = String(r.message || '').split('\n');
    const shortTitle = lines[0].length <= 100;
    const title = shortTitle ? lines[0] : (r.level === 'error' ? '需要处理的问题' : '她的反馈');
    const body = shortTitle ? lines.slice(1).join('\n') : r.message;
    const input = el('input', {name: 'note', type: 'text', maxlength: '1000', value: r.decision.note || '', placeholder: '给她一句说明（可选）', 'aria-label': '给她一句说明（可选）'});
    const buttons = [['accepted', '收到'], ['done', '已实现'], ['dismissed', '不做']].map(([status, label]) => el('button', {
      type: 'button', class: state === status ? 'selected' : '', 'data-status': status, 'aria-pressed': String(state === status),
      onclick: async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try { await submitAction({action: 'feedback.resolve', id: r.id, status, note: input.value}); }
        finally { button.disabled = false; }
      }
    }, label));
    return el('article', {class: 'record feedback-record', 'data-id': r.id, 'data-state': state, 'data-kind': ['error', 'warning'].includes(r.level) ? r.level : 'info', 'data-date': r.time ? new Date(r.time).toLocaleDateString('sv-SE', {timeZone: 'Asia/Shanghai'}) : ''},
      el('div', {class: 'record-meta'}, tag(level),
        el('span', {class: `tag status-${state} ${state === 'done' ? 'good' : ''}`}, names[state] || '待你看'), tag(scopeName(r.key)),
        el('time', {class: 'record-time', datetime: r.time}, time(r.time))),
      state === 'done' ? el('span', {class: 'completion-seal', 'aria-hidden': 'true'}, pixelIcon('blossom')) : null,
      el('h3', {class: 'feedback-title'}, title), body ? el('div', {class: 'body-text feedback-message'}, body) : null,
      r.decision.note ? el('p', {class: 'feedback-note'}, '你的说明：' + r.decision.note) : null,
      el('div', {class: 'feedback-actions'}, el('span', {class: 'control'}, input), buttons,
        el('span', {class: 'feedback-hint'}, r.decision.at ? `处理于 ${time(r.decision.at)}` : '选择处理状态，同时保存说明')));
  });
  return pagedList(d,[['error','问题'],['warning','提醒'],['info','反馈']],r=>cards[rows.findIndex(row=>row.id===r.id)],{before:[el('section',{class:'feedback-overview'},stats,completion)],states:[['open','待你看'],['accepted','已收到'],['done','已实现'],['dismissed','不做']]});
}

function commandBookBody(item) {
  const lines = item.body.split('\n');
  // Keep the original text for copying; lay out command and explanation as a readable entry.
  return el('div', {class: 'catalog-source'}, lines.slice(1).map(line => {
    const clean = line.trim();if (!clean) return el('div', {class: 'catalog-space', 'aria-hidden': 'true'});
    const parts = clean.split(/\s{2,}/), syntax = parts.shift();
    return /^[\[/]/.test(clean) ? el('div', {class: 'catalog-line'},
      el('span', {class: 'catalog-syntax'}, syntax), parts.length ? el('span', {class: 'catalog-explanation'}, parts.join(' ')) : null)
      : el('p', {class: 'catalog-note'}, clean);
  }));
}

function renderCommandCatalog(data) {
  if (!data?.sections?.length) return empty('暂时无法读取完整指令', '刷新后重试；常用网页操作仍可使用。');
  const all = [...data.sections, ...(data.manuals || [])];
  const search = field('搜索完整指令', 'commandSearch', {required: false, placeholder: '例如：好友申请、免打扰、任务改期'});
  const coverage = field('筛选网页入口', 'commandCoverage', {required: false, options: [['all', '全部指令组'], ['web', '可直接执行'], ['partial', '补充功能手册'] ]});
  const count = el('p', {class: 'small muted', role: 'status'});
  const list = el('div', {class: 'catalog-index', role: 'tablist', 'aria-label': '完整指令目录', 'aria-orientation': 'vertical'});
  const detail = el('section', {class: 'catalog-detail', role: 'tabpanel', id: 'catalog-detail'});
  const noResults = empty('没有匹配的指令组', '换一个关键词，或清空搜索与筛选。');noResults.hidden = true;
  const status = el('p', {class: 'catalog-copy-status small', role: 'status'});
  const operationCache = new Map();
  let selected = String(commandCatalogSelection || '1');
  const buttons = [];
  const matches = item => {
    const keyword = search.querySelector('input').value.trim().toLocaleLowerCase();
    const filter = coverage.querySelector('select').value;
    return (!keyword || (item.title + '\n' + item.body + '\n' + (item.operations || []).map(operation=>operation.label).join('\n')).toLocaleLowerCase().includes(keyword)) && (filter === 'all' || item.coverage === filter);
  };
  async function copyText(item) {
    try {
      if (!navigator.clipboard?.writeText) throw Error('clipboard unavailable');
      await navigator.clipboard.writeText(item.body);
      if (selected !== item.id) return;
      status.textContent = '本组用法已复制。填写实际参数后，在管理员 QQ 会话中使用。';
    } catch {
      if (selected !== item.id) return;
      const input = detail.querySelector('.catalog-copy-fallback');input.hidden = false;input.value = item.body;input.focus();input.select();
      status.textContent = '自动复制不可用，已选中原文，请手动复制。';
    }
  }
  function select(id, focus = false) {
    selected = id;commandCatalogSelection = id;
    const item = all.find(row => row.id === id);if (!item) return;
    buttons.forEach(button => {const current = button.dataset.id === id;button.setAttribute('aria-selected', String(current));button.tabIndex = current ? 0 : -1;});
    status.textContent = '';
    const name = item.title.replace(/^[一二三四五六七八九十百]+、/, '');
    const linkList = el('div', {class: 'catalog-web-links'}, (item.webEntries || []).filter(link => pages[link.page]).map(link => el('a', {href: '#' + link.page}, link.label)));
    detail.setAttribute('aria-labelledby', 'catalog-tab-' + id);
    detail.replaceChildren(el('div', {class: 'catalog-detail-heading'},
      el('div', {}, el('p', {class: 'catalog-chapter'}, item.number ? '指令 ' + item.number + ' / ' + data.sections.length : '补充手册'), el('h2', {class: 'catalog-book-title'}, pixelIcon('diaries'), name)),
      tag(item.coverage === 'web' ? '可网页执行' : '补充手册', item.coverage === 'web' ? 'good' : '')),
      el('p', {class: 'catalog-boundary'}, item.operations?.length ? '选操作、填参数后执行；复杂聊天记录继续在 QQ 查看。' : '可前往已有页面操作；其余扩展写法保留作参考。'),
      linkList, (() => {if (!operationCache.has(item.id)) operationCache.set(item.id, operationArea(item));return operationCache.get(item.id);})(), el('details', {class:'catalog-help'},el('summary',{},'查看原 QQ 指令写法'),commandBookBody(item)),
      el('div', {class: 'actions'}, el('button', {type: 'button', class: 'quiet', onclick: () => copyText(item)}, '复制本组用法')),
      el('textarea', {class: 'catalog-copy-fallback', readonly: '', hidden: '', 'aria-label': '手动复制指令用法'}), status);
    if (focus) buttons.find(button => button.dataset.id === id)?.focus();
  }
  all.forEach(item => {
    const button = el('button', {type: 'button', role: 'tab', class: 'catalog-tab', id: 'catalog-tab-' + item.id, 'data-id': item.id, 'aria-controls': 'catalog-detail', onclick: () => select(item.id), onkeydown: event => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();const visible = buttons.filter(b => !b.hidden);const current = visible.indexOf(event.currentTarget);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? visible.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + visible.length) % visible.length;
      if (visible[next]) select(visible[next].dataset.id, true);
    }}, el('span', {class: 'catalog-number', 'aria-hidden': 'true'}, item.number || '+'),
      el('span', {class: 'catalog-tab-label'}, item.title.replace(/^[一二三四五六七八九十百]+、/, '')),
      el('span', {class: 'catalog-coverage'}, item.coverage === 'web' ? '执行' : '手册'));
    buttons.push(button);list.append(button);
  });
  function update() {
    const visible = all.filter(matches);
    buttons.forEach(button => {button.hidden = !visible.some(item => item.id === button.dataset.id);});
    count.textContent = visible.length + ' / ' + all.length + ' 项（' + data.sections.length + ' 组总览 + ' + (data.manuals || []).length + ' 份补充手册）';
    noResults.hidden = visible.length > 0;detail.hidden = visible.length === 0;
    if (visible.length) select(visible.some(item => item.id === selected) ? selected : visible[0].id);
  }
  search.querySelector('input').addEventListener('input', update);coverage.querySelector('select').addEventListener('change', update);
  const reset = el('button', {type: 'button', class: 'quiet', onclick: () => {search.querySelector('input').value = '';coverage.querySelector('select').value = 'all';update();window.WorkbenchControls.sync();}}, '清空搜索');
  update();
  return el('section', {class: 'catalog-page'},
    el('p', {class: 'catalog-intro'}, '13 组原指令均提供操作入口。先选操作再填参数；查看目录不会执行，复杂记录会在 QQ 展示。'),
    el('div', {class: 'catalog-toolbar'}, search, coverage, reset), count,
    el('div', {class: 'catalog-workspace'}, list, detail, noResults));
}


function renderCommands(data) {
  const reminders = taskForms(), videos = videoForms();
  const groups = [
    ['note', 'note', '记录待办', '把要做的事记下来', () => panel('记录待办', form('note.add', [field('待办', 'text', {type: 'textarea', placeholder: '接下来想完成什么？'})], '保存待办'))],
    ['reminder', 'clock', '私人提醒', '在约好的时间提醒你', () => reminders[0]],
    ['task', 'calendar', '定时任务', '安排下一次会话行动', () => reminders[1]],
    ['share', 'videos', '分享视频', '指定链接或 BV 号', () => videos[0]],
    ['browse', 'compass', '浏览视频', '查看状态，或刷一轮', () => panel('浏览视频', el('p', {class: 'muted'}, '查询状态不会开始浏览。主动浏览仍按原有额度执行。'), el('div', {class: 'actions'}, actionButton('查询 B 站状态', 'video.status', {})), form('video.browse', [targetField()], '现在刷一轮 B 站', '立即浏览并尝试分享到所选 QQ 会话，会使用原有模型调用和每日额度。'))],
    ['schedule', 'runtime', '浏览计划', '开关、间隔和时段', () => videos[1]],
    ['limit', 'pouch', '分享限额', '管理每天的分享上限', () => panel('主动分享限额', form('video.limit', [field('类型', 'kind', {options: [['私聊主动', '每私聊主动分享'], ['群聊主动', '每群主动分享'], ['每日浏览', '每日浏览深读']]}), field('每日上限（浏览最高6条）', 'count', {type: 'number', value: '1'})], '更新限额', '将更新原 B 站业务的对应全局每日上限？'))]
  ];
  const picker = el('div', {class: 'command-picker', role: 'tablist', 'aria-label': '选择指令'});
  const area = el('div', {class: 'command-panels'}), buttons = [], panels = [];
  const select = index => {
    commandSelection = groups[index][0];
    buttons.forEach((button, i) => {button.setAttribute('aria-selected', String(i === index)); button.tabIndex = i === index ? 0 : -1; panels[i].hidden = i !== index;});
  };
  groups.forEach(([id, icon, title, hint, build], index) => {
    const button = el('button', {type: 'button', class: 'command-choice', role: 'tab', id: 'command-tab-' + id, 'aria-controls': 'command-panel-' + id, onclick: () => select(index), onkeydown: event => {
      let next;
      if (['ArrowRight', 'ArrowDown'].includes(event.key)) next = (index + 1) % groups.length;
      else if (['ArrowLeft', 'ArrowUp'].includes(event.key)) next = (index - 1 + groups.length) % groups.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = groups.length - 1;
      if (next !== undefined) {event.preventDefault(); select(next); buttons[next].focus();}
    }}, el('span', {class: 'selection-cursor', 'aria-hidden': 'true'}, pixelIcon('pointer')), el('span', {class: 'command-icon'}, pixelIcon(icon)), el('strong', {}, title), el('span', {class: 'command-hint'}, hint));
    const content = build(); content.classList.add('command-detail'); content.querySelector('h2').classList.add('title-plaque'); content.id = 'command-panel-' + id;
    content.setAttribute('role', 'tabpanel'); content.setAttribute('aria-labelledby', 'command-tab-' + id);
    buttons.push(button); panels.push(content); picker.append(button); area.append(content);
  });
  select(Math.max(0, groups.findIndex(group => group[0] === commandSelection)));
  const quick = el('section', {role: 'tabpanel', id: 'command-view-quick', 'aria-labelledby': 'command-view-tab-quick'},
    el('div', {class: 'section-heading'}, el('h2', {}, '常用网页操作'), el('p', {}, '7 类表单入口；完整指令见手册。')),
    el('div', {class: 'command-workspace'}, picker, area));
  const catalog = el('section', {role: 'tabpanel', id: 'command-view-catalog', 'aria-labelledby': 'command-view-tab-catalog'}, renderCommandCatalog(data));
  const views = [quick, catalog], viewTabs = el('div', {class: 'command-view-tabs', role: 'tablist', 'aria-label': '指令查看方式'});
  const selectView = index => {commandView = index ? 'catalog' : 'quick';views.forEach((view, i) => {view.hidden = i !== index;viewButtons[i].setAttribute('aria-selected', String(i === index));viewButtons[i].tabIndex = i === index ? 0 : -1;});};
  const viewButtons = ['常用操作', '完整指令 · ' + (data?.sections?.length || 0) + ' 组'].map((label, index) => {
    const button = el('button', {type: 'button', role: 'tab', id: 'command-view-tab-' + (index ? 'catalog' : 'quick'), 'aria-controls': views[index].id, onclick: () => selectView(index), onkeydown: event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();const next = event.key === 'Home' ? 0 : event.key === 'End' ? 1 : 1 - index;selectView(next);viewButtons[next].focus();
    }}, label);viewTabs.append(button);return button;
  });
  selectView(commandView === 'catalog' ? 1 : 0);
  return el('div', {class: 'command-page'}, viewTabs, quick, catalog);
}
let profileSection = 'capabilities';
function switchControl(label, checked, onChange, disabled = false) {
  return el('button', {type: 'button', class: 'pixel-switch', role: 'switch', 'aria-label': label, 'aria-checked': String(checked), ...(disabled ? {disabled: ''} : {}), onclick: async event => {
    const button = event.currentTarget;button.disabled = true;
    try { await onChange(!checked); } finally {if (button.isConnected) button.disabled = disabled;}
  }}, el('span', {class: 'switch-rail', 'aria-hidden': 'true'}, el('i')), el('span', {}, checked ? '开启' : '关闭'));
}
function applyPortrait(portrait) {
  const image=$('#character-image'),placeholder=$('#character-placeholder');
  if(!portrait){image.hidden=true;image.removeAttribute('src');placeholder.hidden=false;return;}
  const url='/api/workbench/portrait/image?v='+encodeURIComponent(portrait.updatedAt);
  image.onerror=()=>{image.hidden=true;placeholder.hidden=false;};
  if(image.getAttribute('src')!==url)image.src=url;
  image.hidden=false;placeholder.hidden=true;
}
function portraitEditor(data, portrait) {
  const status=el('p',{class:'portrait-upload-status small',role:'status'});
  const input=el('input',{type:'file',accept:'image/png,image/jpeg,image/gif,image/webp','aria-label':'选择樱良形象图片',hidden:'',...(data.portraitUploadAvailable?{}:{disabled:''})});
  const preview=el('img',{class:'portrait-upload-preview',alt:'新形象上传前预览',hidden:''});
  const upload=el('button',{type:'button',class:'primary',disabled:'',hidden:''},'保存人物头像');
  const choose=el('button',{type:'button',class:'portrait-choose',...(data.portraitUploadAvailable?{}:{disabled:''}),onclick:()=>input.click()},data.portrait?'更换人物头像':'上传人物头像');
  const hitarea=el('button',{type:'button',class:'portrait-edit-hitarea','aria-label':data.portrait?'更换樱良人物头像':'上传樱良人物头像',...(data.portraitUploadAvailable?{}:{disabled:''}),onclick:()=>input.click()},el('span',{},data.portrait?'点击更换头像':'点击上传头像'));
  portrait.querySelector('.portrait-slot').append(hitarea);
  input.addEventListener('change',()=>{
    const file=input.files?.[0];preview.hidden=true;upload.disabled=true;upload.hidden=true;status.textContent='';
    if(!file)return;if(file.size>3*1024*1024){status.textContent='图片最大3MB，请先压缩后选择。';return;}
    const reader=new FileReader();reader.onload=()=>{if(input.files?.[0]!==file)return;preview.src=String(reader.result);preview.hidden=false;upload.hidden=false;upload.disabled=false;status.textContent='预览已就绪，点击「保存人物头像」完成设置。';};reader.onerror=()=>{status.textContent='图片读取失败，请重新选择。';};reader.readAsDataURL(file);
  });
  upload.addEventListener('click',async()=>{
    const file=input.files?.[0];if(!file||upload.disabled)return;
    upload.disabled=true;input.disabled=true;choose.disabled=true;hitarea.disabled=true;status.textContent='正在上传到博客OSS，请稍候。';
    try {
      const response=await fetch('/api/workbench/portrait/upload',{method:'POST',credentials:'same-origin',headers:{'content-type':file.type||'application/octet-stream','x-workbench-csrf':csrf,'x-workbench-upload-id':crypto.randomUUID()},body:file,signal:AbortSignal.timeout(30000)});
      const result=await response.json();if(response.status===401){showLogin();throw Error('登录已过期，请重新登录。');}if(!response.ok||!result.ok)throw Error(result.error||'上传未完成');
      await enter();operation('succeeded','樱良的形象已保存。');
    } catch(error){status.textContent=error.message+' 如遇网络中断，请先刷新查看结果，避免重复上传。';}
    finally {input.disabled=false;upload.disabled=false;choose.disabled=false;hitarea.disabled=false;}
  });
  return el('section',{class:'portrait-editor','aria-label':'人物头像设置'},choose,input,
    el('p',{class:'muted small'},data.portraitUploadAvailable?'PNG / JPG / GIF / WebP · 最大 3MB':'头像上传暂不可用，请检查博客 OSS 连接。'),preview,el('div',{class:'actions'},upload,
      data.portrait?actionButton('移除当前头像','portrait.clear',{},'移除工作台当前头像？OSS中的原图会保留。'):null),status);
}

function renderProfile(data) {
  applyPortrait(data.portrait);
  const globalValues = {revision: data.revision};
  const portrait = $('#character-window').cloneNode(true);
  portrait.removeAttribute('id');portrait.classList.add('profile-portrait');portrait.setAttribute('aria-label', '樱良的人物头像');
  portrait.querySelectorAll('[id]').forEach(n => n.removeAttribute('id'));
  const portraitGroup=el('div',{class:'character-portrait-group'},portrait,portraitEditor(data,portrait));
  const identity = el('aside', {class: 'character-sheet'}, portraitGroup,
    el('h2', {class: 'character-name'}, data.name), el('p', {class: 'muted'}, '日常里的陪伴者'),
    el('dl', {class: 'character-facts'},
      attribute('roles', '人物卡', data.role), attribute('runtime', '当前状态', data.paused ? '已暂停' : '运行中', data.paused ? '' : 'ready'),
      attribute('feedback', '私聊', data.scopes.filter(s => s.kind === 'private' && s.enabled).length + ' 个已启用'),
      attribute('memory', '群聊', data.scopes.filter(s => s.kind === 'group' && s.enabled).length + ' 个已启用')),
    Object.assign(paperArt('desk'), {className: 'paper-art paper-art-desk character-vignette'}),
    el('p', {class: 'character-note'}, '在这里整理她的能力，也照看每一段对话。'));
  const capabilityCards = data.capabilities.map(cap => {
    const state = !cap.enabled ? '已关闭' : cap.configured ? '已配置' : '待配置';
    return el('article', {class: 'capability-slot', 'data-ready': String(cap.enabled && cap.configured)},
      el('div', {class: 'capability-top'}, el('span', {class: 'capability-icon'}, pixelIcon(cap.icon)),
        el('div', {}, el('h3', {}, cap.label), el('span', {class: 'capability-state'}, cap.id === 'live' ? '尚未接入' : state))),
      el('p', {class: 'muted'}, cap.detail),
      cap.editable ? switchControl(cap.label + '开关', cap.switchValue, enabled => submitAction({action: 'capability.toggle', id: cap.id, enabled, ...globalValues}, `确定${enabled ? '开启' : '关闭'}「${cap.label}」？此设置会影响后续请求。`)) : el('span', {class: 'capability-follow'}, cap.id === 'live' ? '区别于语音条和视频理解' : '随现有服务与权限生效'));
  });
  const capabilities = el('section', {class: 'capability-collection'},
    ['感知与表达', '观看、创作与生活', '日常互动'].map((title, index) =>
      el('section', {class: 'capability-group'}, el('h3', {class: 'group-heading'}, title),
        el('div', {class: 'capability-grid'}, capabilityCards.slice(index * 3, index * 3 + 3)))));
  const scopeRows = data.scopes.map(scope => {
    const label = scope.owner ? '管理员本人' : contactLabel(scope.key);
    const values = {key: scope.key, revision: scope.revision};
    const voice = form('scope.voice', [field(label + '的声线', 'profile', {value: scope.voiceProfile, options: [['default', '跟随默认声线'], ...data.voices.filter(v => v.id !== 'default').map(v => [v.id, v.label])]})], '保存声线', undefined, values);
    if (!scope.enabled) voice.querySelectorAll('select,button').forEach(n => n.disabled = true);
    const talk = el('details', {class: 'scope-talk'}, el('summary', {}, '主动发起一次对话'),
      el('p', {class: 'muted small'}, '主动问候开关管理自动问候；这里是你现在指定她说什么、做什么。'),
      form('conversation.talk', [field('给' + label + '的对话安排', 'text', {type: 'textarea', max: 500, placeholder: '例如：问问今天他心情怎么样（AI 会结合此会话记忆和当前人设自然开口）'})], '发起对话', '将立即调用主模型向「' + label + '」发起对话，可能产生费用并发送 QQ 消息。', {key: scope.key}));
    if (!scope.enabled) talk.querySelectorAll('textarea,button').forEach(n => n.disabled = true);
    return el('article', {class: 'scope-card', 'data-key': scope.key, 'data-kind': scope.kind, 'data-search':contactText(scope.key)},
      el('div', {class: 'scope-card-heading'}, pixelIcon(scope.kind === 'private' ? 'roles' : 'memory'),
        el('div', {}, el('h3', {}, label), el('p', {class: 'muted small'}, scope.key)),
        el('span', {class: 'scope-enabled-label'}, scope.enabled ? '已启用' : '已停用')),
      el('div', {class: 'scope-settings'},
        el('div', {class: 'scope-setting'}, el('span', {}, '白名单会话'), switchControl(label + '的会话开关', scope.enabled, enabled => submitAction({action: 'scope.enabled', enabled, ...values}, `确定${enabled ? '启用' : '停用'}「${label}」？记忆与记录会保留。`), scope.owner && scope.enabled)),
        el('div', {class: 'scope-setting'}, el('span', {}, '自动主动问候'), switchControl(label + '的主动问候', scope.proactive, enabled => submitAction({action: 'scope.proactive', enabled, ...values}), !scope.enabled)),
        scope.video?.available ? videoScopeSwitch(scope) : null),
      scope.video?.available ? el('p', {class: 'muted small'}, '主动视频：今日 ' + scope.video.used + ' / ' + scope.video.effectiveLimit + ' 条 · ' + scope.video.status + '；每日上限可在视频页调整。') : null,
      el('p', {class: 'scope-policy muted small'}, scope.proactiveStatus), voice,
      el('p', {class: 'muted small'}, '当前声线：' + scope.voiceLabel + ' · 主模型沿用全局配置'), talk);
  });
  const scopeFilter = field('筛选会话类型', 'scopeKind', {options: [['all', '全部会话'], ['private', '私聊白名单'], ['group', '群聊白名单']]});
  const scopeSearch = field('搜索好友、群名或号码', 'scopeSearch', {required: false, placeholder: '昵称、备注、群名、别名、QQ号'});
  const scopesEmpty = empty('没有匹配的会话', '调整筛选或搜索号码。');scopesEmpty.hidden = true;
  const filterScopes = () => {let visible = 0;const kind = scopeFilter.querySelector('select').value, query = scopeSearch.querySelector('input').value.trim().toLocaleLowerCase();
    for (const row of scopeRows) {row.hidden = !(kind === 'all' || row.dataset.kind === kind) || !row.dataset.search.includes(query);if (!row.hidden) visible++;}scopesEmpty.hidden = visible > 0;};
  scopeFilter.querySelector('select').addEventListener('input', filterScopes);scopeSearch.querySelector('input').addEventListener('input', filterScopes);
  const addKind = field('会话类型', 'kind', {options: [['private', '私聊'], ['group', '群聊']]});
  const addContact = contactField('搜索要加入的好友或群聊', 'id', {kind:()=>addKind.querySelector('select').value,format:'id'});
  addKind.querySelector('select').addEventListener('change',()=>addContact.querySelector('.contact-picker').resetSelection());
  const scopes = el('section', {}, el('div', {class: 'scope-filter-row'}, scopeFilter, scopeSearch), el('div', {class: 'scope-list'}, scopeRows, scopesEmpty),
    el('details', {class: 'scope-add'}, el('summary', {}, '加入新的白名单会话'), form('scope.add', [addKind,addContact], '加入白名单', '将允许此会话使用机器人；不会自动发送消息。')));
  const voiceSettings = panel('默认声线', form('service.voice-default', [field('默认声线', 'profile', {value: data.defaultVoice, options: data.voices.map(v => [v.id, v.label + ' · ' + v.voice])})], '保存默认声线', '将更新默认声线；独立选择过声线的会话保留原设置。', globalValues));
  const visionSettings = panel('视觉模型', form('service.vision', [field('图片与视频理解模型', 'model', {value: data.services.find(s => s.id === 'vision')?.model || '', max: 120})], '保存视觉模型', '后续图片兜底和视频理解将使用此模型，请确认该模型已在当前服务账号开通。', globalValues));
  const serviceRow = service => el('article', {class: 'service-row'},
    pixelIcon(service.id.includes('image') || service.id === 'vision' ? 'picture' : service.id === 'tts' || service.id === 'asr' ? 'voice' : service.id === 'maps' ? 'compass' : 'commands'),
    el('div', {class: 'service-info'}, el('h3', {}, service.label), el('p', {}, service.provider), el('p', {class: 'service-model'}, service.model), el('p', {class: 'small muted'}, service.note)), tag(service.configured ? '已配置' : '待配置', service.configured ? 'good' : ''));
  const services = el('section', {class: 'service-inventory'},
    el('p', {class: 'muted'}, '这里展示当前接入的 API 与模型。服务凭据留在服务器端；已配置表示存在配置，连通性以实际请求结果为准。'),
    el('div', {class: 'service-list'}, [
      ['对话与感知', ['chat', 'vision', 'tts', 'asr']],
      ['创作', ['image', 'image-edit']],
      ['生活服务', ['maps']]
    ].map(([title, ids], index) => el('section', {class: 'service-group'},
      el('h2', {class: 'group-heading'}, title),
      el('div', {class: 'service-group-rows'}, data.services.filter(service => ids.includes(service.id)).map(serviceRow)),
      index === 0 ? el('div', {class: 'service-settings'}, voiceSettings, visionSettings) : null))));
  const tabs = el('div', {class: 'profile-tabs', role: 'tablist', 'aria-label': '樱良档案分类'}), panes = [];
  const choices = [['capabilities', '能力栏', capabilities], ['scopes', '会话开关', scopes], ['services', 'API 与模型', services]];
  const buttons = choices.map(([id, label, body], index) => {
    const pane = el('section', {class: 'profile-section', role: 'tabpanel', id: 'profile-section-' + id, 'aria-labelledby': 'profile-tab-' + id}, body);panes.push(pane);
    const button = el('button', {type: 'button', role: 'tab', id: 'profile-tab-' + id, 'aria-controls': pane.id, onclick: () => select(index), onkeydown: event => {
      let next;if (event.key === 'ArrowRight') next = (index + 1) % choices.length;else if (event.key === 'ArrowLeft') next = (index - 1 + choices.length) % choices.length;else if (event.key === 'Home') next = 0;else if (event.key === 'End') next = choices.length - 1;
      if (next !== undefined) {event.preventDefault();select(next);buttons[next].focus();}
    }}, label);tabs.append(button);return button;
  });
  function select(index) {profileSection = choices[index][0];buttons.forEach((button, i) => {button.setAttribute('aria-selected', String(i === index));button.tabIndex = i === index ? 0 : -1;panes[i].hidden = i !== index;});}
  select(Math.max(0, choices.findIndex(c => c[0] === profileSection)));
  return el('div', {class: 'profile-layout'}, identity, el('div', {class: 'profile-main'}, tabs, panes));
}

function balanceView(balance){
  const rows=balance?.rows||[];return el('div',{class:'balance-block'},el('dl',{class:'attribute-list'},attribute('pouch','DeepSeek 余额',rows.length?rows.map(r=>(r.currency==='CNY'?'¥':'$')+r.total+(balance.stale?'（上次数据）':'')).join(' / '):'暂未读取')),
    balance?.error?el('p',{class:'muted small'},balance.error):el('p',{class:'muted small'},rows.map(r=>`充值 ${r.toppedUp} · 赠送 ${r.granted} ${r.currency}`).join(' / ')+(balance?.at?' · '+time(balance.at):'')),actionButton('刷新余额','balance.refresh',{}));
}
function renderRuntime(d) {
  const totals=d.usage.totals;
  return el('div',{class:'layout'},el('div',{},panel('连接状态',el('dl',{class:'attribute-list'},attribute('feedback','QQ 连接',d.status.snowluma?.accountOnline?'在线':'未在线'),attribute('commands','DSH',d.status.dshReady?'就绪':'未就绪'),attribute('roles','人物卡',d.status.role||'未设置'),attribute('runtime','AI 状态',d.status.socialV2Paused?'已暂停':'运行中')),balanceView(d.balance)),panel('用量与费用账本',totals?text(`账本累计：${d.usage.symbol||''}${Number(totals.cost||0).toFixed(4)}${totals.estimated?'（含估算）':''}\n累计 Token：${Number(totals.totalTokens||0).toLocaleString('zh-CN')}\n对话回合：${totals.turns??'未记录'}`):text('暂未记录用量。'))),el('aside',{},panel('私人管理',text('私人日记和周记不发送到 QQ，不写入聊天记忆。'),text('工具流水不再展示；资源与维护请到「服务器」页。'))));
}
const gib=n=>(Number(n||0)/1024**3).toFixed(2)+' GiB';
function renderServer(d){
  const serviceNames={active:'运行中',inactive:'未运行',failed:'异常',unknown:'未确认'};
  const stat=(label,value,percent)=>el('article',{class:'resource-card'},el('h3',{},label),el('strong',{},value),Number.isFinite(percent)?el('progress',{max:100,value:percent,'aria-label':label+' '+percent+'%'}):null);
  const preview=serverPreview&&serverPreview.expiresAt>Date.now()?serverPreview:null;
  if(d.alerts?.length)serverAlarmTimer=setTimeout(()=>{if(tab==='server'&&!document.hidden&&!busy)loadPage();},60000);
  return el('div',{class:'layout server-page'},el('div',{},panel('此刻的服务器',el('div',{class:'resource-grid'},stat('系统负载',d.cpu.load.map(v=>v.toFixed(2)).join(' / ')),stat('可用内存',gib(d.memory.available)+' / '+gib(d.memory.total),Math.round(100*(1-d.memory.available/Math.max(1,d.memory.total)))),stat('系统盘',d.disk.percent+'% · 可用 '+gib(d.disk.available),d.disk.percent),stat('交换空间',gib(d.memory.swapTotal-d.memory.swapFree)+' / '+gib(d.memory.swapTotal))),el('p',{class:'muted small'},`${d.cpu.cores} 核 · 连续运行 ${Math.floor(d.uptime/3600)} 小时 · 检测于 ${time(d.at)}${d.cached?'（缓存）':''}`),actionButton('刷新服务器状态','server.refresh',{})),panel('资源提醒',d.alerts?.length?d.alerts.map(a=>el('p',{class:'notice server-alert',role:'alert'},a.text)):text('当前没有达到告警阈值。'),el('p',{class:'muted small'},'正常时只手动刷新。此页出现告警时，每分钟复查一次；离开此页或隐藏网页即暂停。没有新增常驻监控进程。')),panel('关键服务',d.services.map(r=>el('div',{class:'list-row'},text(r.name),tag(serviceNames[r.state]||'未确认',r.state==='active'?'good':'warn'))))),el('aside',{},panel('安全磁盘维护',el('p',{class:'muted'},'先预览，再确认清理。只复用已审查的过期孤立快照和系统日志保留规则，不扫描删除个人资料。'),actionButton('预览安全清理','server.preview',{}),preview?el('div',{class:'cleanup-preview'},text(preview.description),el('p',{class:'small muted'},'预览 5 分钟内有效。执行时会重新检查安全范围和服务器资源。'),actionButton('确认执行安全清理','server.cleanup',{token:preview.token,confirmed:true},'确认按预览执行已有安全维护脚本？仅清理符合条件的过期孤立快照和系统日志；不删除博客、数据库、QQ登录、记忆、配置、备份或依赖。')):el('p',{class:'small muted'},'预览后才会出现确认清理按钮。'),el('p',{class:'small muted'},'不会调用模型、安装软件、重启服务或运行任意命令。资源紧张时拒绝扫描和清理；安全范围不足时保留告警，不扩大删除范围。'))));
}
// Refresh the data without collapsing the document or moving the user's place.
function viewBlock(node) {
  const block=node?.closest('[data-id],[data-key],[data-view-key]');
  if(!block||!$('#content').contains(block))return null;
  const attr=block.hasAttribute('data-id')?'data-id':block.hasAttribute('data-key')?'data-key':'data-view-key';
  return {attr,value:block.getAttribute(attr)};
}
function findViewBlock(key) {return key?$('#content').querySelector('['+key.attr+'="'+CSS.escape(key.value)+'"]'):$('#content');}
function captureView() {
  const content=$('#content'),active=document.activeElement;
  const identity={tab,scope:$('#scope').value,filters:JSON.stringify(currentFilters())};
  const expanded=[...content.querySelectorAll('details')].map(node=>{const block=viewBlock(node),root=findViewBlock(block);return {block,index:[...root.querySelectorAll('details')].indexOf(node),open:node.open};});
  const anchors=[...content.querySelectorAll('[data-id],[data-key],[data-view-key]')].filter(node=>{const r=node.getBoundingClientRect();return r.height&&r.bottom>0&&r.top<innerHeight;}).map(node=>({key:viewBlock(node),top:node.getBoundingClientRect().top}));
  const filters=[...content.querySelectorAll('.scope-filter-row input,.scope-filter-row select')].map(node=>({name:node.name,label:node.getAttribute('aria-label'),value:node.value}));
  const focus=content.contains(active)?{block:viewBlock(active),name:active.name,label:active.getAttribute('aria-label'),tag:active.tagName,text:active.tagName==='BUTTON'?active.textContent:''}:null;
  return {identity,x:scrollX,y:scrollY,expanded,anchors,filters,focus};
}
function restoreView(state,sequence) {
  if(!state||generation!==sequence||tab!==state.identity.tab||$('#scope').value!==state.identity.scope||JSON.stringify(currentFilters())!==state.identity.filters)return;
  for(const saved of state.filters){const node=[...$('#content').querySelectorAll('.scope-filter-row input,.scope-filter-row select')].find(n=>n.name===saved.name&&n.getAttribute('aria-label')===saved.label);if(node){node.value=saved.value;node.dispatchEvent(new Event('input',{bubbles:true}));node.dispatchEvent(new Event('change',{bubbles:true}));}}
  for(const saved of state.expanded){const root=findViewBlock(saved.block);const node=root?.querySelectorAll('details')[saved.index];if(node)node.open=saved.open;}
  window.WorkbenchControls.sync();
  let y=state.y;
  for(const anchor of state.anchors){const node=findViewBlock(anchor.key);if(node&&node.getBoundingClientRect().height){y=scrollY+node.getBoundingClientRect().top-anchor.top;break;}}
  window.scrollTo({left:state.x,top:Math.max(0,y),behavior:'instant'});
  const saved=state.focus,root=saved?findViewBlock(saved.block):null;
  const focus=root?[...root.querySelectorAll('button,input,select,textarea')].find(n=>n.tagName===saved.tag&&(saved.name?n.name===saved.name:saved.label?n.getAttribute('aria-label')===saved.label:n.textContent===saved.text)):null;
  if(focus&&!focus.disabled&&!focus.hidden)focus.focus({preventScroll:true});
}
async function loadPage({preserve=true} = {}) {
  if (!overview) return;
  clearTimeout(serverAlarmTimer);serverAlarmTimer=null;
  const sequence = ++generation, current = tab;
  const keep=preserve&&!$('#app').hidden&&$('#content').childElementCount>0;
  $('#page-error').hidden = true; $('#content').setAttribute('aria-busy', 'true');
  try {
    const scope = ['diaries','runtime','server'].includes(current)?'all':$('#scope').value;
    if(!keep)$('#content').replaceChildren(empty('正在读取记录', '请稍候。'));
    const query=listTabs.includes(current)?'&'+new URLSearchParams(currentFilters()).toString():'';
    const data = (await request(`view?tab=${current}&scope=${encodeURIComponent(scope)}${query}`)).data;
    if (sequence !== generation || current !== tab) return;
    const render = {profile: renderProfile, activity: renderActivity, diaries: renderDiaries, roles: renderRoles, videos: renderVideos, memory: renderMemory, feedback: renderFeedback, commands: renderCommands, runtime: renderRuntime,server:renderServer}[current];
    const next=await render(data);
    if(sequence!==generation||current!==tab)return;
    const retained=keep?captureView():null;
    $('#content').replaceChildren(next);
    await new Promise(resolve=>requestAnimationFrame(resolve));
    restoreView(retained,sequence);
  } catch (error) { if (sequence === generation) { if(!keep)$('#content').replaceChildren(empty('这一页暂时无法读取', '可以点击刷新重试；未触发任何业务动作。')); showError(error); } }
  finally { if (sequence === generation) $('#content').setAttribute('aria-busy', 'false'); }
}
function navigate() {
  window.WorkbenchControls.close();
  tab = location.hash.slice(1); if (!pages[tab]) tab = 'profile';
  $('#app').dataset.page = tab;
  $('#page-title').textContent = pages[tab][1]; $('#page-description').textContent = pages[tab][2];
  for (const n of $('#nav').children) { if (n.hash === '#' + tab) n.setAttribute('aria-current', 'page'); else n.removeAttribute('aria-current'); }
  const nav = $('#nav'), active = nav.querySelector('[aria-current=page]');
  if (active) {
    const bounds = nav.getBoundingClientRect(), item = active.getBoundingClientRect();
    if (item.right > bounds.right) nav.scrollLeft += item.right - bounds.right + 4;
    else if (item.left < bounds.left) nav.scrollLeft -= bounds.left - item.left + 4;
  }
  $('#scope').closest('label').hidden=['diaries','runtime','server'].includes(tab);
  $('#scope').disabled = ['profile', 'roles', 'runtime', 'commands','diaries','server'].includes(tab);
  return loadPage({preserve:false});
}
async function enter({preserve=!$('#app').hidden} = {}) {
  const s = await request('session'); csrf = s.csrf;
  overview = (await request('view?tab=overview')).data;
  applyPortrait(overview.portrait);
  const directory = await request('view?tab=contacts').then(value=>value.data).catch(()=>({entries:[]}));
  if (!overview || !csrf) return;
  contactDirectoryMessage = directory.message || (directory.available === false ? '联系人暂未读取，可输入号码或刷新。' : '');
  contactEntries = directory.entries || [];contactLookup = new Map(contactEntries.map(row=>[row.key,row]));
  const retainedScope=preserve?$('#scope').value:'all';
  $('#scope').replaceChildren(el('option', {value: 'all'}, '全部活动'), ...overview.scopes.map(k => el('option', {value: k}, scopeName(k))));
  if([...$('#scope').options].some(option=>option.value===retainedScope))$('#scope').value=retainedScope;
  const st = overview.status;
  $('#health').replaceChildren(el('span', {}, el('i', {class: 'dot' + (st.snowluma?.accountOnline ? '' : ' off')}), 'QQ', el('strong', {}, st.snowluma?.accountOnline ? '在线' : '未确认在线')), el('span', {}, '当前人物卡', el('strong', {}, st.role || '未设置')), el('span', {}, 'DSH', el('strong', {}, st.dshReady ? '已就绪' : '未就绪')), el('span', {}, 'AI', el('strong', {}, st.socialV2Paused ? '已暂停' : '运行中')));
  $('#preview-banner').hidden = !overview.preview;
  $('#login-screen').hidden = true; $('#app').hidden = false; if(preserve)await loadPage();else await navigate();
  const pending = sessionStorage.getItem('workbench-pending'); if (pending) pollJob(pending);
}
// Original 16×16 object icons. Integer coordinates and 16/32/48px slots keep pixel weights consistent.
const iconPalette = {k: '#73513e', w: '#fff0d0', y: '#d3b173', h: '#f4d795', p: '#ac879e', l: '#d6b5c4', b: '#8da9bb', c: '#c3d5d9', g: '#8d9b6d', s: '#bbc895', r: '#bd7c8e', t: '#e8b5ba'};
const iconArt = {
  profile: [['k','M3 1h10v14H3z'],['w','M4 2h8v12H4z'],['p','M6 3h4v1h1v4h-1v1H6V8H5V4h1z'],['l','M6 4h3v3H6z'],['g','M5 10h6v1h1v2H4v-2h1z']],
  voice: [['k','M6 1h4v1h1v7h-1v1H6V9H5V2h1zM3 6h1v4h1v1h6v-1h1V6h1v5h-2v1H9v2h3v1H4v-1h3v-2H5v-1H3z'],['p','M6 2h4v6H6z'],['w','M7 2h1v4H7z']],
  picture: [['k','M1 2h14v12H1z'],['w','M2 3h12v10H2z'],['b','M3 4h10v7H3z'],['y','M10 4h2v2h-2z'],['g','M3 10h2V8h2v2h2V9h2v2h2v1H3z']],
  brush: [['k','M11 1h3v3h-1v2h-2v2H9v2H7v2H5v2H2v-3h2V9h2V7h2V5h2V3h1z'],['y','M11 2h2v1h-1v2h-2v2H9V5h1V3h1z'],['p','M6 8h2v2H6z'],['l','M3 11h2v1H4v1H3z']],
  blossom: [['r','M4 1h3v2h2V1h3v2h2v3h-2v3h2v3h-2v2H9v-2H7v2H4v-2H2V9h2V6H2V3h2z'],['t','M4 3h3v3H4zm5 0h3v3H9zM4 9h3v3H4zm5 0h3v3H9z'],['w','M6 6h4v4H6z'],['y','M7 7h2v2H7z'],['g','M7 13h2v3H7z']],
  leaf: [['g','M2 2h6v2h4v2h2v6H8v-2H4V8H2z'],['s','M4 3h4v2h4v2h1v2H9V7H5V5H4z'],['k','M4 5h1v2h2v2h2v2h3v1h2v2h-2v-1H9v-2H7V9H5V7H4z']],
  diaries: [['k','M3 1h10v14H3z'],['y','M4 2h2v12H4z'],['p','M6 2h6v11H6z'],['w','M7 4h4v1H7zm0 3h4v1H7zm-1 6h6v1H6z'],['r','M9 10h2v5h-1v-1H9z']],
  note: [['k','M3 1h8v1h1v1h1v12H3z'],['w','M4 2h6v3h2v9H4z'],['y','M10 2h1v1h1v1h-2z'],['p','M6 7h4v1H6zm0 3h4v1H6z'],['g','M4 7h1v1H4zm0 3h1v1H4z']],
  clock: [['k','M5 1h6v2h2v2h2v6h-2v2h-2v2H5v-2H3v-2H1V5h2V3h2z'],['w','M5 3h6v2h2v6h-2v2H5v-2H3V5h2z'],['y','M7 3h1v1H7zM11 7h1v1h-1zM7 11h1v1H7zM3 7h1v1H3z'],['k','M7 5h1v4h3v1H7z']],
  calendar: [['k','M2 3h12v12H2zM4 1h2v4H4zm6 0h2v4h-2z'],['r','M3 4h10v3H3z'],['w','M3 7h10v7H3z'],['y','M4 8h2v2H4zm3 0h2v2H7zm3 0h2v2h-2zM4 11h2v2H4zm3 0h2v2H7z'],['g','M10 11h2v2h-2z']],
  videos: [['k','M3 2h10v12H3z'],['b','M4 3h8v10H4z'],['c','M5 4h6v1H5z'],['w','M6 6h2v1h1v1h1v1H9v1H8v1H6z'],['y','M2 4h1v2H2zm0 4h1v2H2zm0 4h1v1H2zm11-8h1v2h-1zm0 4h1v2h-1zm0 4h1v1h-1z']],
  memory: [['k','M2 2h11v5H2zM3 8h11v6H3z'],['g','M3 3h8v3H3z'],['w','M4 4h8v1H4zM5 10h8v2H5z'],['p','M4 9h2v4H4zm2 3h7v1H6z'],['y','M2 14h12v1H2z']],
  feedback: [['k','M2 3h12v10H2z'],['w','M3 4h10v8H3z'],['b','M3 5h2v1h1v1h4V6h1V5h2v2h-2v1h-1v1H6V8H5V7H3z'],['y','M10 10h2v1h-2z']],
  envelope: [['k','M2 3h12v10H2z'],['c','M3 4h10v8H3z'],['b','M3 5h2v1h1v1h4V6h1V5h2v2h-2v1h-1v1H6V8H5V7H3z'],['w','M3 4h10v1H3z']],
  roles: [['k','M3 1h10v14H3z'],['w','M4 2h8v12H4z'],['p','M6 3h4v1h1v4h-1v1H6V8H5V4h1z'],['l','M6 4h3v3H6z'],['g','M5 10h6v1h1v2H4v-2h1z']],
  commands: [['k','M2 2h12v9H2zM1 12h14v3H1z'],['b','M3 3h10v7H3z'],['w','M4 4h3v1H4zm1 1h2v1H5zM4 6h2v1H4zm4 1h3v1H8zM3 13h1v1H3zm2 0h1v1H5zm2 0h1v1H7zm2 0h4v1H9z'],['y','M6 11h4v1H6z']],
  server: [['k','M2 1h12v14H2z'],['b','M3 2h10v5H3zM3 8h10v6H3z'],['g','M4 3h2v2H4zM4 10h2v2H4z'],['w','M8 3h4v1H8zM8 10h4v1H8z']],
  runtime: [['k','M6 1h4v2h2v1h1v2h2v4h-2v2h-1v1h-2v2H6v-2H4v-1H3v-2H1V6h2V4h1V3h2z'],['y','M6 3h4v2h2v1h1v4h-2v2h-1v1H6v-2H4v-1H3V6h2V4h1z'],['k','M6 6h4v4H6z'],['w','M7 7h2v2H7zM6 3h3v1H6z']],
  activity: [['k','M4 2h9v10H4z'],['w','M5 3h7v8H5z'],['b','M6 5h4v1H6zm0 3h4v1H6z'],['y','M1 8h3v6h6v1H1z'],['g','M2 9h2v4h5v1H2z']],
  compass: [['k','M5 1h6v2h2v2h2v6h-2v2h-2v2H5v-2H3v-2H1V5h2V3h2z'],['w','M5 3h6v2h2v6h-2v2H5v-2H3V5h2z'],['b','M8 4h3v2h-1v1H9v1H8z'],['r','M7 8h1v4H5v-2h1V9h1z'],['y','M7 7h2v2H7z']],
  archive: [['k','M2 3h12v4H2zM3 7h10v8H3z'],['y','M3 4h10v2H3z'],['h','M4 8h8v6H4z'],['k','M6 9h4v3H6z'],['w','M7 10h2v1H7z']],
  pouch: [['k','M4 1h8v3h-1v2h2v2h1v5h-2v2H4v-2H2V8h1V6h2V4H4z'],['y','M5 2h6v1H5zm1 3h4v2H6zM4 8h8v5h-1v1H5v-1H4z'],['h','M5 8h2v4H5z'],['k','M5 5h6v1H5z'],['w','M8 9h2v2H8z']],
  bulb: [['k','M5 1h6v1h2v2h1v5h-2v2h-2v4H6v-4H4V9H2V4h1V2h2z'],['h','M5 3h6v1h1v4h-2v2H6V8H4V4h1z'],['w','M5 4h2v3H5z'],['y','M7 11h2v2H7z']],
  bug: [['k','M4 2h2v2h4V2h2v3h1v6h-2v2H5v-2H3V5h1zM1 6h2v1H1zm0 4h2v1H1zm12-4h2v1h-2zm0 4h2v1h-2z'],['r','M5 5h6v6H5z'],['w','M6 6h1v1H6zm3 0h1v1H9z'],['k','M7 8h2v3H7z']],
  check: [['g','M2 7h2v2h2V7h2V5h2V3h3v2h-1v2h-2v2H8v2H6v2H4v-2H2z'],['s','M3 7h1v2h2v1H4V9H3zM9 5h1V4h2v1h-2v2H9z']],
  pointer: [['k','M4 2h2v2h2v2h2v4H8v2H6v2H4z'],['y','M5 4h1v2h2v4H6v2H5z']]
};
function pixelIcon(id) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('shape-rendering', 'crispEdges'); svg.setAttribute('aria-hidden', 'true');
  for (const [color, d] of iconArt[id]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('fill', iconPalette[color]); path.setAttribute('d', d); svg.append(path);
  }
  return el('span', {class: 'nav-icon', 'aria-hidden': 'true'}, svg);
}
const headingFlora = paperArt('branch');headingFlora.classList.add('heading-flora');document.querySelector('.page-heading').append(headingFlora);
document.querySelector('footer > span:first-child').prepend(el('span', {class: 'footer-leaf', 'aria-hidden': 'true'}, pixelIcon('leaf')));
document.querySelectorAll('.brand-symbol').forEach(n => n.replaceChildren(pixelIcon('blossom').firstChild));
for (const [id, p] of Object.entries(pages)) $('#nav').append(el('a', {href: '#' + id}, pixelIcon(id), p[0]));
$('#date-label').textContent = new Date().toLocaleDateString('zh-CN', {timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'});
$('#login-form').addEventListener('submit', async event => { event.preventDefault(); const form = event.currentTarget, button = form.querySelector('button'); button.disabled = true; $('#login-error').textContent = ''; try { await request('login', Object.fromEntries(new FormData(form))); form.elements.password.value = ''; await enter(); } catch (error) { $('#login-error').textContent = error.message; } finally { button.disabled = false; } });
$('#logout').addEventListener('click', async () => { try { await request('logout', {}); showLogin(); $('#login-form input[name=password]').focus(); } catch (error) { showError(error); } });
$('#scope').addEventListener('change',()=>{if(listFilters[tab])listFilters[tab].page=1;loadPage();});
$('#refresh').addEventListener('click', async () => { if (busy) return; const pending = sessionStorage.getItem('workbench-pending'); if (pending) await pollJob(pending); else { try { await enter(); } catch (error) { showError(error); } } });
window.addEventListener('hashchange', navigate);
enter().catch(error => { if (csrf) $('#login-error').textContent = error.message; });
