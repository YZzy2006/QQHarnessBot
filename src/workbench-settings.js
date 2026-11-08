import crypto from 'node:crypto';
import {proactiveGreetingBlockReason, describeProactiveBlock} from './proactive-policy.js';

const reject = (message, statusCode = 400) => { throw Object.assign(Error(message), {statusCode}); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const short = (value, max = 120) => String(value ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, max);
const revision = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const pathValue = (object, path) => path.reduce((value, key) => value?.[key], object);
export function applyWorkbenchConfigPatch(target, entries) {
  for (const {path, value} of entries) {
    if (!Array.isArray(path) || path.some(key => ['__proto__', 'prototype', 'constructor'].includes(key))) reject('配置路径无效');
    let cursor = target;
    for (const key of path.slice(0, -1)) { if (!plain(cursor[key])) cursor[key] = {}; cursor = cursor[key]; }
    cursor[path.at(-1)] = structuredClone(value);
  }
}
const switches = {
  dialogue: ['socialV2', 'enabled'], voice: ['socialV2', 'voice', 'ttsEnabled'],
  vision: ['vision', 'fallbackEnabled'], drawing: ['socialV2', 'tools', 'generateImage'],
  proactive: ['socialV2', 'proactive', 'enabled'], stickers: ['socialV2', 'sticker', 'enabled']
};

// Administrator projection: never serialize config/state objects or provider credentials.
export function createWorkbenchSettings({getConfig, persist, states, getState, saveStates, voiceProfiles, defaultVoice,
  environment = {}, defaults = {}, status = () => ({}), videoState = null, getVideoTargets = () => [], isContactAbsent = async () => false, now = Date.now}) {
  const ids = list => [...new Set((Array.isArray(list) ? list : []).map(String).filter(id => /^[1-9]\d{0,11}$/.test(id)))];
  // Match allowed(): the singular field takes precedence if both spellings exist.
  const listField = (cfg, section, kind) => {
    const singular = kind === 'groups' ? 'group' : 'private', plural = kind === 'groups' ? 'groups' : 'privates';
    return cfg[section]?.[singular] != null ? singular : cfg[section]?.[plural] != null ? plural : kind;
  };
  const listPath = (cfg, section, kind) => [section, listField(cfg, section, kind)];
  const lists = cfg => ({private: ids(pathValue(cfg, listPath(cfg, 'allow', 'private'))), groups: ids(pathValue(cfg, listPath(cfg, 'allow', 'groups'))), deniedPrivate: ids(pathValue(cfg, listPath(cfg, 'deny', 'private'))), deniedGroups: ids(pathValue(cfg, listPath(cfg, 'deny', 'groups')))});
  async function saveSessionField(key, field, value) {
    const map = states(), existed = map.has(key), state = getState(key);
    const hadField = Object.hasOwn(state, field), previous = state[field];
    state[field] = value;
    try { await saveStates(); }
    catch (error) {
      if (!existed) map.delete(key);
      else if (hadField) state[field] = previous;
      else delete state[field];
      throw error;
    }
  }
  const voices = () => voiceProfiles().map(p => ({id: short(p.id, 32), label: short(p.label, 40), model: short(p.model), voice: short(p.voice)}));
  const flagValues = cfg => Object.fromEntries(Object.entries(switches).map(([name, path]) => [name, pathValue(cfg, path) !== false]));
  const globalRevision = cfg => revision({flags: flagValues(cfg), visionModel: cfg.vision?.model || defaults.visionModel, defaultVoice: defaultVoice()});
  function rows(cfg) {
    const video = videoState?.read(), selectedVideoKeys = new Set(getVideoTargets());
    const all = lists(cfg), owner = String(cfg.ownerQQ || ''), profiles = voices(), defaultId = defaultVoice();
    return [...new Set([...(owner ? ['private:' + owner] : []), ...all.private.map(id => 'private:' + id), ...all.groups.map(id => 'group:' + id), ...all.deniedPrivate.map(id => 'private:' + id), ...all.deniedGroups.map(id => 'group:' + id)])].map(key => {
      const [kind, id] = key.split(':'), state = states().get(key), denied = (kind === 'private' ? all.deniedPrivate : all.deniedGroups).includes(id);
      const explicit = (kind === 'private' ? all.private : all.groups).includes(id), isOwner = kind === 'private' && id === owner;
      const enabled = !denied && (explicit || isOwner);
      const voiceOverride = short(state?.voiceProfile, 32), selected = profiles.find(p => p.id === voiceOverride) || profiles.find(p => p.id === defaultId);
      const proactive = state?.proactiveGreetingEnabled !== false;
      const reason = proactiveGreetingBlockReason({enabled: proactive, lastIncomingAt: state?.lastIncomingAt, quietUntil: state?.proactiveQuietUntil, maxIdleDays: cfg.socialV2?.proactive?.maxIdleDays, now: now()});
      const target = video ? videoState.target(key, video) : null;
      const videoEnabled = !!target?.enabled, videoLimit = video ? videoState.shareLimit(key, video) : 0;
      const videoSelected = !video?.autoSelect || selectedVideoKeys.has(key) || target?.manualSelect === true;
      const videoStatus = !enabled ? '会话已停用' : !videoEnabled ? '主动视频已关闭' : videoLimit === 0 ? '每日限额为0，已暂停' : !videoSelected ? '等待自动选中此会话，可开启开关固定加入' : '按原浏览时段与计划运行';
      return {video: {available: !!video, enabled: videoEnabled, dailyLimit: target?.dailyLimit ?? null, effectiveLimit: videoLimit, used: video ? videoState.shareCount(key, video) : 0, status: videoStatus, selected: videoSelected}, key, id, kind, owner: isOwner, enabled, proactive, voiceProfile: voiceOverride || 'default', voiceLabel: selected?.label || '未配置',
        proactiveStatus: !enabled ? '会话已停用' : cfg.socialV2?.proactive?.enabled === false ? '全局主动问候已关闭' : describeProactiveBlock(reason),
        revision: revision({key, explicit, denied, proactive, voiceOverride, videoTarget: target, videoLimits: video?.limits, videoAutoSelect: video?.autoSelect})};
    }).filter(row => row.owner || row.enabled || !(cfg.workbench?.archivedScopes || []).includes(row.key));
  }
  function read() {
    const cfg = getConfig(), flags = flagValues(cfg), live = status();
    const qwen = !!(environment.QWEN_API_KEY || environment.BAILIAN_API_KEY || environment.DASHSCOPE_API_KEY);
    const doubao = !!environment.DOUBAO_API_KEY;
    const maps = [['高德地图', 'GAODE_WEB_API_KEY'], ['腾讯地图', 'TENGXUNDITU_API_KEY'], ['天地图', 'TIANDITU_API_KEY'], ['百度地图', 'BAIDUDITU_API_KEY']].filter(([, key]) => !!environment[key]).map(([label]) => label);
    const profiles = voices(), defaultId = defaultVoice(), profile = profiles.find(p => p.id === defaultId);
    const visionModel = short(cfg.vision?.model || defaults.visionModel || '未配置');
    const mainModel = short(cfg.dsh?.model || defaults.chatModel || '未配置');
    const mediaEnabled = cfg.utilities?.enabled !== false && cfg.socialV2?.enabled !== false;
    const capabilities = [
      {id: 'dialogue', label: '文字对话', icon: 'feedback', enabled: flags.dialogue, configured: live.dshReady === true, detail: '主对话与会话上下文'},
      {id: 'voice', label: '语音合成', icon: 'voice', enabled: flags.voice && flags.dialogue, configured: qwen, detail: '合成语音条；语音转写独立工作'},
      {id: 'vision', label: '识图兜底', icon: 'picture', enabled: flags.vision, configured: qwen, detail: '主模型直读之外的视觉兜底'},
      {id: 'video', label: '视频理解', icon: 'videos', enabled: mediaEnabled && flags.vision, configured: qwen, detail: '采样画面、音轨与已有观看资料', editable: false},
      {id: 'drawing', label: '画图 / 改图', icon: 'brush', enabled: flags.drawing && mediaEnabled, configured: qwen || doubao, detail: '按请求生成或编辑图片'},
      {id: 'maps', label: '地图定位', icon: 'compass', enabled: cfg.socialV2?.tools?.lifeServices !== false && cfg.companion?.enabled !== false, configured: maps.length > 0, detail: maps.join('、') || '地点查询与位置卡片', editable: false},
      {id: 'proactive', label: '主动问候', icon: 'calendar', enabled: flags.proactive && flags.dialogue, configured: live.dshReady === true, detail: '仍受每会话开关、静默与限额约束'},
      {id: 'stickers', label: '表情互动', icon: 'blossom', enabled: flags.stickers, configured: true, detail: '现有表情收藏与发送体系'},
      {id: 'live', label: '实时音视频', icon: 'runtime', enabled: false, configured: false, editable: false, detail: '当前未接入实时通话'}
    ].map(c => ({...c, editable: c.editable ?? true, switchValue: flags[c.id] ?? c.enabled}));
    const services = [
      {id: 'chat', label: '主对话', provider: short(cfg.dsh?.provider || 'DSH'), model: mainModel, configured: live.dshReady === true, note: '由当前 DSH 模型配置管理'},
      {id: 'vision', label: '图片 / 视频理解', provider: '阿里云百炼 · 千问', model: visionModel, configured: qwen, note: '图片兜底与视频采样共用此视觉模型'},
      {id: 'tts', label: '语音合成', provider: '阿里云百炼', model: profile?.model || defaults.ttsModel || '未配置', configured: qwen, note: profile ? profile.label + ' · ' + profile.voice : '尚未配置声线'},
      {id: 'asr', label: '语音识别', provider: '阿里云百炼', model: defaults.asrModel || 'qwen3-asr-flash', configured: qwen, note: '收到的语音及视频音轨转写'},
      {id: 'image', label: '图片生成', provider: '千问 / 豆包回退', model: 'z-image-turbo / qwen-image-3.0 / ' + (defaults.doubaoImageModel || '未配置'), configured: qwen || doubao, note: '依现有质量档位和回退策略执行'},
      {id: 'image-edit', label: '图片编辑', provider: environment.QQ_IMAGE_EDIT_PROVIDER === 'doubao' ? '豆包' : '千问', model: short(environment.QQ_IMAGE_EDIT_MODEL || (environment.QQ_IMAGE_EDIT_PROVIDER === 'doubao' ? defaults.doubaoImageModel : 'qwen-image-2.0')), configured: environment.QQ_IMAGE_EDIT_PROVIDER === 'doubao' ? doubao : qwen, note: '使用服务端当前编辑路由'},
      {id: 'maps', label: '地图与地点', provider: maps.join(' / ') || '未配置', model: '地点检索 / 位置卡片', configured: maps.length > 0, note: '地点检索结果与位置卡片发送'}
    ];
    return {name: '樱良', role: short(live.role || '未设置', 120), mode: short(live.mode || ''), paused: live.socialV2Paused === true,
      capabilities, services, scopes: rows(cfg), voices: profiles, defaultVoice: defaultId, flags, revision: globalRevision(cfg),
      limits: {private: lists(cfg).private.length, groups: lists(cfg).groups.length}};
  }
  async function update(action, input) {
    const cfg = getConfig();
    if (!plain(input)) reject('设置参数无效');
    const fields = {'scope.add':['kind','id'],'scope.remove':['key','revision','confirmed'],'scope.enabled':['key','revision','enabled'],'scope.proactive':['key','revision','enabled'],'scope.video':['key','revision','enabled'],'scope.video-limit':['key','revision','dailyLimit'],'scope.voice':['key','revision','profile'],'capability.toggle':['revision','id','enabled'],'service.vision':['revision','model'],'service.voice-default':['revision','profile']}[action];
    if (!fields || Object.keys(input).some(key => !fields.includes(key))) reject('设置字段无效');
    if (action === 'scope.add') {
      if (!['private', 'group'].includes(input.kind) || !/^[1-9]\d{4,11}$/.test(String(input.id || ''))) reject('请填写5–12位QQ号或群号');
      const key = input.kind + ':' + input.id, all = lists(cfg), kind = input.kind === 'private' ? 'private' : 'groups';
      const denied = input.kind === 'private' ? 'deniedPrivate' : 'deniedGroups';
      await persist([{path: listPath(cfg, 'allow', kind), value: [...new Set([...all[kind], String(input.id)])].map(Number)}, {path: listPath(cfg, 'deny', kind), value: all[denied].filter(id => id !== String(input.id)).map(Number)}, {path:['workbench','archivedScopes'],value:(cfg.workbench?.archivedScopes || []).filter(k=>k!==key)}]);
      return {key, message: '已加入白名单'};
    }
    if (action.startsWith('scope.')) {
      const row = rows(cfg).find(r => r.key === input.key);
      if (!row) reject('该会话不在当前管理列表中', 403);
      if (input.revision !== row.revision) reject('该会话设置已变化，请刷新后重试', 409);
      if (action === 'scope.remove') {
        if (row.owner) reject('不能移除管理员本人的管理会话');
        if (input.confirmed !== true) reject('请确认移除旧会话条目');
        if (await isContactAbsent(row.key) !== true) reject('该联系人仍在好友或群聊列表中，不能按旧条目清理', 409);
        if (rows(getConfig()).find(r=>r.key===row.key)?.revision !== input.revision) reject('会话设置已变化，请刷新后重试', 409);
        const all = lists(cfg), kind = row.kind === 'private' ? 'private' : 'groups', denied = row.kind === 'private' ? 'deniedPrivate' : 'deniedGroups';
        const allow = all[kind].filter(id=>id!==row.id), deny = [...new Set([...all[denied],row.id])];
        if (cfg.allowAllWhenEmpty && all[kind].length && !allow.length) reject('不能移除最后一个白名单条目：当前空白名单会放行全部会话，请先关闭该模式');
        const archived = [...new Set([...(cfg.workbench?.archivedScopes || []),row.key])];
        if (archived.length > 10000) reject('旧会话管理索引已满');
        // Keep a deny guard so old agent tokens cannot regain access. Memories and ledgers remain intact.
        await persist([{path:listPath(cfg,'allow',kind),value:allow.map(Number)},{path:listPath(cfg,'deny',kind),value:deny.map(Number)},{path:['workbench','archivedScopes'],value:archived}]);
        return {key:row.key,message:'已移除旧会话管理条目，聊天记忆与历史记录保留'};
      }
      if (action === 'scope.enabled') {
        if (typeof input.enabled !== 'boolean') reject('开关必须是布尔值');
        if (row.owner && !input.enabled) reject('不能停用管理员本人的管理会话');
        const all = lists(cfg), kind = row.kind === 'private' ? 'private' : 'groups', denied = row.kind === 'private' ? 'deniedPrivate' : 'deniedGroups';
        const allow = [...all[kind]], deny = all[denied].filter(id => id !== row.id);
        if (input.enabled && !allow.includes(row.id)) allow.push(row.id);
        if (!input.enabled) deny.push(row.id);
        await persist([{path: listPath(cfg, 'allow', kind), value: allow.map(Number)}, {path: listPath(cfg, 'deny', kind), value: deny.map(Number)}]);
        return {key: row.key, message: input.enabled ? '已启用此会话' : '已停用此会话，记忆与记录保留'};
      }
      if (!row.enabled) reject('请先启用此会话', 403);
      if (action === 'scope.video' || action === 'scope.video-limit') {
        if (!videoState) reject('视频设置尚未连接', 503);
        if (action === 'scope.video' && typeof input.enabled !== 'boolean') reject('主动视频开关无效');
        if (action === 'scope.video-limit' && input.dailyLimit !== null && (!Number.isInteger(input.dailyLimit) || input.dailyLimit < 0 || input.dailyLimit > 100)) reject('每日限额须为0–100的整数，或跟随默认');
        videoState.update(s => {
          const target = {...videoState.target(row.key, s)};
          if (action === 'scope.video') {
            target.enabled = input.enabled; target.manualSelect = input.enabled;
            target.schedule = target.schedule || 'daily';
            target.dueAt = input.enabled ? now() + target.interval * 60000 : 0;
          } else if (input.dailyLimit === null) delete target.dailyLimit;
          else target.dailyLimit = input.dailyLimit;
          // Rebuild remaining slots later; never reset today's ledger or backfill old slots.
          delete target.plan;
          s.targets[row.key] = target;
        }, {settings: true});
        return {key: row.key, message: action === 'scope.video' ? (input.enabled ? '已开启此会话的主动视频，按原时段运行' : '已关闭此会话的主动视频') : '已保存此会话每日主动视频上限；今日已用量保留'};
      }
      if (action === 'scope.proactive') {
        if (typeof input.enabled !== 'boolean') reject('主动问候开关无效');
        await saveSessionField(row.key, 'proactiveGreetingEnabled', input.enabled);
        return {key: row.key, message: input.enabled ? '已开启此会话的主动问候' : '已关闭此会话的主动问候'};
      }
      if (action === 'scope.voice') {
        const id = String(input.profile || 'default');
        if (id !== 'default' && !voices().some(p => p.id === id)) reject('声线不在当前配置列表中');
        await saveSessionField(row.key, 'voiceProfile', id === 'default' || id === defaultVoice() ? '' : id);
        return {key: row.key, message: '已保存此会话声线'};
      }
      reject('未知会话设置');
    }
    if (input.revision !== globalRevision(cfg)) reject('全局配置已变化，请刷新后重试', 409);
    if (action === 'capability.toggle') {
      if (!Object.hasOwn(switches, input.id) || typeof input.enabled !== 'boolean') reject('功能开关无效');
      await persist([{path: switches[input.id], value: input.enabled}]);return {message: '已保存功能开关'};
    }
    if (action === 'service.vision') {
      if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(input.model)) reject('模型标识无效');
      await persist([{path: ['vision', 'model'], value: input.model}]);return {message: '已保存视觉模型，后续请求使用此模型'};
    }
    if (action === 'service.voice-default') {
      if (!voices().some(p => p.id === input.profile)) reject('请选择已配置的声线');
      await persist([{path: ['socialV2', 'voice', 'defaultProfile'], value: input.profile}]);return {message: '已保存默认声线，独立设置声线的会话不变'};
    }
    reject('未知设置操作');
  }
  return {read, update};
}
