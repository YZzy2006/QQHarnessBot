import crypto from 'node:crypto';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const unavailable = () => Object.assign(Error('账号服务暂不可用，请稍后重试'), {statusCode: 503});
const denied = () => Object.assign(Error('账号或密码错误，或未开通工作台权限'), {statusCode: 401});
const columns = `CAST(id AS CHAR) AS id, username, password_hash,
  CAST(enabled AS UNSIGNED) AS enabled, CAST(bot_workbench_enabled AS UNSIGNED) AS workbench_enabled,
  CAST(lock_until AS CHAR) AS lock_until, (lock_until IS NOT NULL AND lock_until > NOW()) AS account_locked`;
const revision = row => crypto.createHash('sha256').update(JSON.stringify([
  row.id, row.username, row.password_hash, Number(row.enabled), Number(row.workbench_enabled), row.lock_until
])).digest('hex');
const eligible = row => row && Number(row.enabled) === 1 && Number(row.workbench_enabled) === 1 && !Number(row.account_locked)
  && /^\$2[aby]\$(?:0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/.test(row.password_hash);

// Queries are SELECT-only. IDs and usernames always use bound parameters.
export function createMysqlWorkbenchIdentity({pool, bcrypt}) {
  let dummyHash;
  async function read(kind, value) {
    try {
      const sql = `SELECT ${columns} FROM admin_user WHERE ${kind === 'id' ? 'id' : 'username'} = ? LIMIT 1`;
      const [rows] = await pool.execute({sql, timeout: 5000}, [value]);
      return rows[0] || null;
    } catch { throw unavailable(); }
  }
  function project(row) {
    return eligible(row) ? {id: String(row.id), username: row.username, revision: revision(row)} : null;
  }
  return {
    async authenticate(username, password) {
      if (typeof username !== 'string' || !username || username.length > 50 || typeof password !== 'string'
        || !password || Buffer.byteLength(password, 'utf8') > 72) throw denied();
      const row = await read('username', username);
      const valid = eligible(row) && row.username === username;
      dummyHash ||= bcrypt.hash(crypto.randomBytes(24).toString('hex'), 12);
      let matches;
      try { matches = await bcrypt.compare(password, valid ? row.password_hash : await dummyHash); }
      catch { throw unavailable(); }
      if (!valid || !matches) throw denied();
      // Recheck permissions after password verification, which may take several hundred ms.
      const current = project(await read('id', row.id));
      if (!current || current.revision !== revision(row)) throw denied();
      return current;
    },
    async account(id) {
      if (!/^\d{1,20}$/.test(String(id))) return null;
      return project(await read('id', id));
    }
  };
}

// Public deployments use their own protected database configuration, never the maintainer's blog.
export function readWorkbenchMysqlConfig(file) {
  try {
  const st = fs.lstatSync(file);
  if (!st.isFile() || (st.mode & 0o077) !== 0 || st.size > 32768) throw unavailable();
  const config = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof config.database !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(config.database)
    || !['127.0.0.1', 'localhost', '::1'].includes(config.host)
    || typeof config.user !== 'string' || !config.user || typeof config.password !== 'string'
    || config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) throw unavailable();
  return config;
  } catch { throw unavailable(); }
}

// Optional, lazy loading keeps a database outage confined to workbench authentication.
// No fallback to the local account when database authentication is configured.
export function loadWorkbenchMysqlIdentity() {
  const file = process.env.QQ_WORKBENCH_DB_FILE;
  if (!file) return null;
  let provider;
  function get() {
    if (provider) return provider;
    try {
      const config = readWorkbenchMysqlConfig(file);
      const require = createRequire(new URL('../.workbench-deps/package.json', import.meta.url));
      const mysql = require('mysql2/promise'), bcrypt = require('bcryptjs');
      const pool = mysql.createPool({host: config.host, port: Number(config.port) || 3306,
        user: config.user, password: config.password, database: config.database,
        connectionLimit: 2, maxIdle: 1, idleTimeout: 60000, waitForConnections: true, queueLimit: 8,
        connectTimeout: 5000, enableKeepAlive: true, dateStrings: true,
        supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false});
      provider = createMysqlWorkbenchIdentity({pool, bcrypt});
      return provider;
    } catch { throw unavailable(); }
  }
  return {authenticate: (...args) => get().authenticate(...args), account: (...args) => get().account(...args)};
}
