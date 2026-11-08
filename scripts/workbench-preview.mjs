// Isolated preview: no production config, QQ, DSH, databases or model calls.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createWorkbench, workbenchReply} from '../src/workbench-http.js';
import {createWorkbenchStore} from '../src/workbench-store.js';
import {createWorkbenchSettings, applyWorkbenchConfigPatch} from '../src/workbench-settings.js';
import {atomicUtilityJson} from '../src/utility-store.js';
const root = process.cwd(), stateDir = path.join(root, '.runtime/workbench-preview');
fs.mkdirSync(stateDir, {recursive: true, mode: 0o700});
const authFile = path.join(root, 'state/workbench-auth.json');
if (!fs.existsSync(authFile)) throw Error('请先通过 scripts/workbench-account.mjs 初始化本地工作台账号');
fs.copyFileSync(authFile, path.join(stateDir, 'workbench-auth.json'));
fs.chmodSync(path.join(stateDir, 'workbench-auth.json'), 0o600);
const store = createWorkbenchStore({stateDir});
const at = Date.now(), ownerKey = 'private:123456789', groupKey = 'group:987654321';
let roleText = '# 人物设定\n\n喜欢记录生活，也愿意认真听朋友说话。\n\n## 日常\n自然地聊天，根据实际经历回应。';
let role = '樱良（演示）';
const feedback = [{id: 'preview-feedback-1', key: groupKey, level: 'warning', time: new Date(at - 180000).toISOString(), message: '最近分享的几条视频题材有些相似，希望下次可以换一换。'}, {id: 'preview-feedback-2', key: ownerKey, level: 'info', time: new Date(at - 600000).toISOString(), message: '想把待办和回忆分开整理，这样回头找起来更方便。'}];
const facts = {ownerQQ: '123456789', scopes: [groupKey], notes: [{id: 'n_preview1', text: '周末整理读书笔记', createdAt: at - 3600000, done: false}], todos: [], memories: [{text: '完成了一次约好的散步。', createdAt: at - 7200000}], tasks: []};
fs.mkdirSync(path.join(stateDir, 'bilibili'), {recursive: true});
if (!fs.existsSync(path.join(stateDir, 'bilibili/video-results.json'))) fs.writeFileSync(path.join(stateDir, 'bilibili/video-results.json'), JSON.stringify({version: 1, rows: [{scope: groupKey + '|shared', ref: 'BV1100100004:1', role: 'preview', at: at - 1200000, analyzedAt: at - 1200000, title: '一段关于城市散步的短片（示例）', cover: '', summary: '这是供本地验收页面排版的示例资料，没有分析真实视频。', coverage: '隔离示例资料'}]}));
const status = () => ({mode: 'reserved2', role, dshReady: true, socialV2Paused: false, snowluma: {accountOnline: true, connected: true, good: true}, activity: `[${new Date(at - 100000).toISOString()}] ${groupKey} [视频] 分享结果已记录（示例）\n[${new Date(at - 400000).toISOString()}] ${ownerKey} [待办] 保存了一条待办（示例）`});
const api = async (route, method, body) => {
  if (route === '/api/status') return status();
  if (route.startsWith('/api/tokens/')) return {symbol: '¥', totalTokens: 0, totalCost: 0, note: '本地预览不调用模型'};
  if (route === '/api/roles') return {roles: ['樱良（演示）'], current: role, summaries: []};
  if (route.startsWith('/api/roles/content')) return {name: role, content: roleText, chars: roleText.length, limits: {injectMaxChars: 8000}, sections: {v2: [{heading: '人物设定', chars: roleText.length, injected: true}]}, warnings: []};
  if (route === '/api/roles/update') {roleText = body.content; return {ok: true};}
  if (route === '/api/role') {role = body.role; return {ok: true};}
  if (route === '/api/socialV2/feedback') return {entries: feedback};
  if (route.startsWith('/api/socialV2/tool-log')) return {entries: []};
  if (route.startsWith('/api/socialV2/memory?')) return {formatted: '当前没有会话记忆（隔离预览）。'};
  if (route === '/api/socialV2/memory-append') return {ok: true};
  throw Error('预览未实现该只读资料源');
};
// This preview has its own settings file; it never reads production config or provider secrets.
const settingsFile=path.join(stateDir,'workbench-settings-demo.json'), sessionsFile=path.join(stateDir,'workbench-session-demo.json');
const previewConfig=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{ownerQQ:'123456789',allow:{private:['123456789','100100004'],groups:['987654321']},deny:{private:[],groups:[]},dsh:{provider:'deepseek-official',model:'deepseek-flash'},vision:{fallbackEnabled:true,model:'qwen3-vl-plus'},socialV2:{enabled:true,proactive:{enabled:true,maxIdleDays:3},tools:{generateImage:true,lifeServices:true},voice:{ttsEnabled:true,defaultProfile:'gentle'},sticker:{enabled:true}},utilities:{enabled:true},companion:{enabled:true}};
const previewSessions=new Map(fs.existsSync(sessionsFile)?JSON.parse(fs.readFileSync(sessionsFile,'utf8')):[[ownerKey,{lastIncomingAt:Date.now(),voiceProfile:'',proactiveGreetingEnabled:true}],[groupKey,{lastIncomingAt:Date.now(),voiceProfile:'bright',proactiveGreetingEnabled:false}]]);
const previewVoices=[{id:'gentle',label:'轻柔（示例）',model:'qwen-audio-3.1-tts-flash',voice:'gentle-demo'},{id:'bright',label:'明亮（示例）',model:'qwen-audio-3.1-tts-flash',voice:'bright-demo'}];
const administration=createWorkbenchSettings({getConfig:()=>previewConfig,states:()=>previewSessions,getState:key=>{if(!previewSessions.has(key))previewSessions.set(key,{});return previewSessions.get(key);},saveStates:()=>atomicUtilityJson(sessionsFile,[...previewSessions]),voiceProfiles:()=>previewVoices,defaultVoice:()=>previewConfig.socialV2.voice.defaultProfile,environment:{QWEN_API_KEY:'isolated-demo-only',GAODE_WEB_API_KEY:'isolated-demo-only'},defaults:{doubaoImageModel:'doubao-seedream-5-0-flash-260915'},status,persist:async entries=>{const next=structuredClone(previewConfig);applyWorkbenchConfigPatch(next,entries);atomicUtilityJson(settingsFile,next);applyWorkbenchConfigPatch(previewConfig,entries);}});
const workbench = createWorkbench({contacts: async()=>({friends:[{user_id:'123456789',remark:'管理员本人',nickname:'演示主人'},{user_id:'100100004',remark:'小雨',nickname:'测试联系人'},{user_id:'100100005',nickname:'同名好友'},{user_id:'100100006',nickname:'同名好友'}],groups:[{group_id:'987654321',group_name:'测试群聊'}],aliases:[{name:'小群',key:groupKey},{name:'雨雨',key:'private:100100004'}]}),root, stateDir, store, administration, facts: () => ({...facts,scopes:[...previewConfig.allow.private.map(id=>'private:'+id),...previewConfig.allow.groups.map(id=>'group:'+id)].filter(key=>{const [kind,id]=key.split(':');return !(previewConfig.deny[kind==='group'?'groups':'private']||[]).map(String).includes(id);})}), api: async (...args) => {
  const v = await api(...args); return args[0] === '/api/status' ? {...v, preview: true} : v;
}, execute: async (family, text) => {
  if (family === 'operator') {await workbenchReply(null,ownerKey,'隔离预览已接收：'+text+'。此处未连接真实 QQ，实际执行由机器人原处理器完成。');return true;}
  if (family === 'weekly') return store.archive('weekly', '【管理员私有周记｜不入聊天记忆】\n这是一条本地预览周记，未调用模型。', {source: 'preview'});
  if (family === 'owner' && text.startsWith('[记一下]')) facts.notes.push({id: 'n_' + Date.now(), text: text.slice(5, -1), createdAt: Date.now(), done: false});
  if (family === 'owner' && text.startsWith('[完成待办]')) {const r = facts.notes.find(v => text.includes(v.id)); if (r) r.done = true;}
  if (family === 'owner' && text.startsWith('[恢复待办]')) {const r = facts.notes.find(v => text.includes(v.id)); if (r) r.done = false;}
  await new Promise(r => setTimeout(r, 650));
  await workbenchReply(() => {throw Error('preview must never send QQ');}, ownerKey, '本地预览操作已完成，未调用 QQ 或模型。');
  return true;
}});
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!/^127\.0\.0\.1:\d+$/.test(req.headers.host || '') && !/^localhost:\d+$/.test(req.headers.host || '')) {res.writeHead(403); res.end(); return;}
  if (url.pathname === '/favicon.ico') {res.writeHead(204); res.end(); return;}
  if (!await workbench.handle(req, res, url)) {res.writeHead(404); res.end();}
});
server.requestTimeout = 30000;
server.listen(Number(process.env.WORKBENCH_PREVIEW_PORT || 3188), '127.0.0.1', () => console.log('工作台隔离预览：http://127.0.0.1:' + server.address().port + '/workbench'));
