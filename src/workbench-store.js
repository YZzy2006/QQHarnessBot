import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {atomicUtilityJson} from './utility-store.js';

export const WORKBENCH_TTL = 72 * 3600000;
const text = (v, max) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
export function createWorkbenchStore({stateDir, now = Date.now, atomicWrite = atomicUtilityJson}) {
  const file = path.join(stateDir, 'workbench.json');
  function read() {
    if (!fs.existsSync(file)) return {version: 1, diaries: [], decisions: {}, preferences: {include: '', avoid: ''}, events: []};
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('工作台档案无法读取，已停止写入'); }
    if (s?.version !== 1 || !Array.isArray(s.diaries) || s.diaries.length > 1000 || !s.decisions || Array.isArray(s.decisions)
      || !s.preferences || !['include', 'avoid'].every(k => typeof s.preferences[k] === 'string' && s.preferences[k].length <= 300)
      || s.activities!==undefined&&(!Array.isArray(s.activities)||s.activities.length>500||s.activities.some(r=>!r||!Number.isFinite(r.at)||typeof r.text!=='string'||r.text.length>2000))
      || !Array.isArray(s.events) || s.events.length > 500 || JSON.stringify(s).length > 8_000_000
      || s.diaries.some(r => !r || typeof r.id !== 'string' || !['diary', 'weekly'].includes(r.kind) || typeof r.text !== 'string' || r.text.length > 10000 || !Number.isFinite(r.at))
      || s.events.some(r => !r || !Number.isFinite(r.at) || !Number.isFinite(r.expiresAt))) throw Error('工作台档案格式错误，已停止写入');
    return s;
  }
  function change(fn) {
    const s = read();
    s.events = s.events.filter(r => r.expiresAt > now());
    if(s.activities)s.activities=s.activities.filter(r=>r.at>now()-30*86400000);
    const result = fn(s);
    if (JSON.stringify(s).length > 8_000_000) throw Error('工作台档案已满，请先导出整理');
    atomicWrite(file, s);
    return result;
  }
  function archive(kind, body, {source = 'manual', at = now()} = {}) {
    const value = text(body, 10000);
    if (!['diary', 'weekly'].includes(kind) || !value) throw Error('档案正文不能为空');
    return change(s => {
      if (s.diaries.length >= 1000) throw Error('日记档案已满，请先导出整理');
      const old = s.diaries.find(r => r.kind === kind && r.text === value && now() - r.at < 60000);
      if (old) return old;
      const row = {id: crypto.randomUUID(), kind, text: value, source, at};
      s.diaries.push(row);
      return row;
    });
  }
  function preferences(value) {
    if (value === undefined) return read().preferences;
    if (!value || !['include', 'avoid'].every(k => typeof value[k] === 'string' && value[k].length <= 300)) throw Error('兴趣和减少推荐各限300字');
    return change(s => (s.preferences = {include: text(value.include, 300), avoid: text(value.avoid, 300)}));
  }
  function decision(id, value) {
    if (typeof id !== 'string' || !/^[\w-]{1,100}$/.test(id) || !['open', 'accepted', 'done', 'dismissed'].includes(value?.status)
      || typeof value.note !== 'string' || value.note.length > 1000) throw Error('反馈处理参数无效');
    return change(s => {
      if (!s.decisions[id] && Object.keys(s.decisions).length >= 1000) throw Error('反馈处理档案已满');
      return (s.decisions[id] = {status: value.status, note: text(value.note, 1000), at: now()});
    });
  }
  function event(kind, data, evidenceAt = now()) {
    if (!Number.isFinite(evidenceAt) || evidenceAt > now()) return;
    const expiresAt = evidenceAt + WORKBENCH_TTL;
    if (expiresAt <= now()) return;
    // Only explicitly supplied, bounded evidence. Never persist tokens or raw model responses.
    return change(s => {
      const row = {id: crypto.randomUUID(), kind: text(kind, 40), at: now(), expiresAt,
        key: text(data.key, 40), bvid: text(data.bvid, 16), status: text(data.status, 40),
        detail: text(data.detail, 3000), candidates: (data.candidates || []).slice(0, 6).map(v => ({bvid: text(v.bvid, 16), title: text(v.title, 180), origin: text(v.origin, 100)}))};
      s.events.push(row);
      s.events = s.events.slice(-500);
      return row;
    });
  }
  function activity(row){
    if(!row||!Number.isFinite(row.at)||!row.kind||!row.text)return;
    return change(s=>{s.activities=[...(s.activities||[]).filter(r=>r.at>now()-30*86400000),{...row,text:text(row.text,2000)}].slice(-500);});
  }
  function portrait(value) {
    if (value === undefined) return read().portrait || null;
    if (value !== null && (!/^botwork\/portraits\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(value.key || '') || !Number.isFinite(value.updatedAt))) throw Error('形象记录无效');
    return change(s => (s.portrait = value));
  }
  return {file, read, archive, preferences, decision, event, activity, portrait, prune: () => change(() => {})};
}
