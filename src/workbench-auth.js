import {loadWorkbenchMysqlIdentity} from './workbench-mysql-auth.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {promisify} from 'node:util';
import {atomicUtilityJson} from './utility-store.js';
const scrypt = promisify(crypto.scrypt);
const PARAMS = {N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024};
const digest = v => crypto.createHash('sha256').update(v).digest('hex');
export async function setWorkbenchAccount(stateDir, username, password) {
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(username) || typeof password !== 'string' || password.length < 12 || password.length > 200) throw Error('账号3–40位，密码12–200位');
  const salt = crypto.randomBytes(24).toString('hex');
  const hash = (await scrypt(password, salt, 64, PARAMS)).toString('hex');
  atomicUtilityJson(path.join(stateDir, 'workbench-auth.json'), {version: 1, username, salt, hash});
}
export function createWorkbenchAuth({stateDir, now = Date.now, identity = loadWorkbenchMysqlIdentity()}) {
  const file = path.join(stateDir, 'workbench-auth.json'), sessions = new Map(), attempts = new Map();
  const ttl = 12 * 3600000;
  function account() {
    if (!fs.existsSync(file)) throw Error('工作台账号尚未初始化');
    let v;
    try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw Error('工作台账号不可用'); }
    if (v?.version !== 1 || !/^[a-zA-Z0-9_-]{3,40}$/.test(v.username) || !/^[a-f0-9]{48}$/.test(v.salt) || !/^[a-f0-9]{128}$/.test(v.hash)) throw Error('工作台账号不可用');
    return v;
  }
  function prune() {
    for (const [k, v] of sessions) if (v.expiresAt <= now()) sessions.delete(k);
    for (const [k, v] of attempts) if (now() - v.start >= 15 * 60000) attempts.delete(k);
  }
  async function login(username, password, ip) {
    prune();
    const bucket = attempts.get(ip) || {start: now(), count: 0};
    if (bucket.count >= 8 || attempts.size > 1000) throw Object.assign(Error('登录尝试过多，请15分钟后再试'), {statusCode: 429});
    bucket.count++; attempts.set(ip, bucket);
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 200) throw Object.assign(Error('账号或密码错误'), {statusCode: 401});
    let a;
    if (identity) a = await identity.authenticate(username, password);
    else {
      a = account();
      const computed = await scrypt(password, a.salt, 64, PARAMS);
      if (!crypto.timingSafeEqual(computed, Buffer.from(a.hash, 'hex')) || username !== a.username) throw Object.assign(Error('账号或密码错误'), {statusCode: 401});
    }
    if (sessions.size >= 20) sessions.delete(sessions.keys().next().value);
    const token = crypto.randomBytes(32).toString('base64url');
    const session = {username: a.username, ...(identity ? {userId: a.id} : {}), csrf: crypto.randomBytes(24).toString('base64url'), expiresAt: now() + ttl, revision: identity ? a.revision : digest(JSON.stringify(a))};
    sessions.set(digest(token), session);
    return {token, session};
  }
  function token(req) {
    const value = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith('qq_workbench='));
    return value?.slice('qq_workbench='.length) || '';
  }
  function session(req) {
    prune();
    const s = sessions.get(digest(token(req)));
    if (!s) return null;
    if (identity) return identity.account(s.userId).then(a => {
      if (!a || a.username !== s.username || a.revision !== s.revision) {logout(req); return null;}
      return s;
    });
    if (s.revision !== digest(JSON.stringify(account()))) { logout(req); return null; }
    return s;
  }
  function logout(req) { sessions.delete(digest(token(req))); }
  const cookie = (value, secure, age = ttl / 1000) => `qq_workbench=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure ? '; Secure' : ''}`;
  return {login, session, logout, cookie};
}
