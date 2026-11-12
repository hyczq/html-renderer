'use strict';

/**
 * 账号与会话：scrypt 密码哈希 + HMAC-SHA256 签名 Cookie。
 *
 * 会话模型：token 携带 sessionEpoch。改密、退出所有设备、恢复码重置时
 * 递增 epoch，使所有旧 token 立即失效（无需服务端 session 表）。
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { promisify } = require('node:util');
const config = require('./config');
const store = require('./store');

const scryptAsync = promisify(crypto.scrypt);
const RECOVERY_CODE_COUNT = 10;
let SECRET = null;

async function loadSecret() {
  try {
    const hex = (await fsp.readFile(config.SECRET_FILE, 'utf8')).trim();
    const buf = Buffer.from(hex, 'hex');
    if (buf.length < 32) throw new Error('secret.key 内容异常');
    SECRET = buf;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    SECRET = crypto.randomBytes(32);
    try {
      await fsp.writeFile(config.SECRET_FILE, SECRET.toString('hex'), { mode: 0o600, flag: 'wx' });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      SECRET = Buffer.from((await fsp.readFile(config.SECRET_FILE, 'utf8')).trim(), 'hex');
    }
  }
}

function scryptHash(password, salt) {
  return scryptAsync(password, salt, 64).then((buf) => buf.toString('hex'));
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

async function createUser(rawUsername, password) {
  const username = String(rawUsername || '').trim();
  const lower = username.toLowerCase();

  // 先做一次无锁快速检查；真正的一致性检查在锁内重做。
  const existing = await store.readUsersIndex();
  if (existing[lower]) throw new Error('用户名已存在');

  // scrypt 是 CPU/内存密集操作，放在全局写锁外，避免注册阻塞生成/保存。
  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = await scryptHash(password, salt);
  const id = 'u_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();

  return store.withLock(async () => {
    const map = await store.readUsersIndex();
    if (map[lower]) throw new Error('用户名已存在');
    const user = {
      id,
      username,
      usernameLower: lower,
      salt,
      passHash,
      sessionEpoch: 0,
      recoveryCodes: [],
      passwordUpdatedAt: now,
      createdAt: now,
    };
    await store.writeUser(user);
    map[lower] = id;
    await store.writeUsersIndex(map);
    return user;
  });
}

async function verifyUserPassword(user, password) {
  if (!user) {
    // 用户不存在时也做一次 scrypt，避免通过响应时间枚举用户名
    await scryptHash(password, '00'.repeat(16));
    return false;
  }
  const calc = await scryptHash(password, user.salt);
  const a = Buffer.from(calc, 'hex');
  const b = Buffer.from(String(user.passHash), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function issueSession(userId, sessionEpoch = 0) {
  const exp = Date.now() + config.SESSION_TTL_MS;
  const epoch = Number(sessionEpoch) || 0;
  const payload = 'v2.' + userId + '.' + exp + '.' + epoch;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  let userId;
  let expStr;
  let epochStr;
  let sig;
  let payload;

  if (parts[0] === 'v1' && parts.length === 4) {
    [, userId, expStr, sig] = parts;
    epochStr = '0';
    payload = 'v1.' + userId + '.' + expStr;
  } else if (parts[0] === 'v2' && parts.length === 5) {
    [, userId, expStr, epochStr, sig] = parts;
    payload = 'v2.' + userId + '.' + expStr + '.' + epochStr;
  } else {
    return null;
  }

  const exp = Number(expStr);
  const epoch = Number(epochStr);
  if (!userId || !Number.isFinite(exp) || exp < Date.now()) return null;
  if (!Number.isInteger(epoch) || epoch < 0) return null;

  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { userId, epoch };
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function isHttps(req) {
  if (req.socket && req.socket.encrypted) return true;
  if (!config.TRUST_PROXY) return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token) {
  const secure = isHttps(req);
  // HTTPS 使用 __Host- 前缀：禁止 Domain，避免预览子域写入父域同名 Cookie。
  const name = secure ? '__Host-hr_session' : 'hr_session';
  const parts = [
    name + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(config.SESSION_TTL_MS / 1000),
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie(req) {
  const parts = ['hr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'];
  if (isHttps(req)) {
    parts.push('__Host-hr_session=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0');
  }
  return parts;
}

function anonIdFrom(req) {
  const cookies = parseCookies(req);
  const v = cookies['__Host-hr_aid'] || cookies.hr_aid;
  return /^[a-f0-9]{32}$/.test(String(v || '')) ? v : '';
}

function anonCookie(req, id) {
  const secure = isHttps(req);
  const name = secure ? '__Host-hr_aid' : 'hr_aid';
  const parts = [name + '=' + id, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function currentUser(req) {
  const cookies = parseCookies(req);
  const token = cookies['__Host-hr_session'] || cookies.hr_session;
  const info = verifySession(token);
  if (!info) return null;
  const user = await store.readUserById(info.userId);
  if (!user) return null;
  if (Number(user.sessionEpoch || 0) !== info.epoch) return null;
  return user;
}

async function changePassword(userId, oldPassword, newPassword) {
  const current = await store.readUserById(userId);
  if (!current) throw new Error('账号不存在');
  if (!(await verifyUserPassword(current, oldPassword))) throw new Error('旧密码错误');

  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = await scryptHash(newPassword, salt);

  return store.withLock(async () => {
    const user = await store.readUserById(userId);
    if (!user || user.passHash !== current.passHash) {
      throw new Error('账号状态已变化，请重试');
    }
    user.salt = salt;
    user.passHash = passHash;
    user.sessionEpoch = Number(user.sessionEpoch || 0) + 1;
    user.recoveryCodes = [];
    user.passwordUpdatedAt = new Date().toISOString();
    await store.writeUser(user);
    return user;
  });
}

async function logoutAll(userId) {
  return store.withLock(async () => {
    const user = await store.readUserById(userId);
    if (!user) throw new Error('账号不存在');
    user.sessionEpoch = Number(user.sessionEpoch || 0) + 1;
    await store.writeUser(user);
    return user;
  });
}

function normalizeRecoveryCode(code) {
  return String(code || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

function hashRecoveryCode(code) {
  return store.sha256(normalizeRecoveryCode(code));
}

function formatRecoveryCode(code) {
  return String(code).toUpperCase().match(/.{4}/g).join('-');
}

async function createRecoveryCodes(userId) {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, () =>
    formatRecoveryCode(store.newCode(16))
  );
  const hashes = codes.map(hashRecoveryCode);
  await store.withLock(async () => {
    const user = await store.readUserById(userId);
    if (!user) throw new Error('账号不存在');
    user.recoveryCodes = hashes;
    user.recoveryUpdatedAt = new Date().toISOString();
    await store.writeUser(user);
  });
  return codes;
}

async function resetPasswordWithRecovery(username, code, newPassword) {
  const user = await store.readUserByName(username);
  if (!user) {
    await scryptHash(code, '00'.repeat(16));
    throw new Error('恢复码无效或已使用');
  }
  const matched = hashRecoveryCode(code);
  const stored = Array.isArray(user.recoveryCodes) ? user.recoveryCodes : [];
  if (!stored.some((h) => constantTimeEqual(h, matched))) {
    throw new Error('恢复码无效或已使用');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = await scryptHash(newPassword, salt);

  return store.withLock(async () => {
    const fresh = await store.readUserById(user.id);
    if (!fresh) throw new Error('恢复码无效或已使用');
    const currentCodes = Array.isArray(fresh.recoveryCodes) ? fresh.recoveryCodes : [];
    if (!currentCodes.some((h) => constantTimeEqual(h, matched))) {
      throw new Error('恢复码无效或已使用');
    }
    fresh.salt = salt;
    fresh.passHash = passHash;
    fresh.sessionEpoch = Number(fresh.sessionEpoch || 0) + 1;
    fresh.passwordUpdatedAt = new Date().toISOString();
    fresh.recoveryCodes = currentCodes.filter((h) => !constantTimeEqual(h, matched));
    await store.writeUser(fresh);
    return fresh;
  });
}

/** 调用方必须已持有 store.withLock。 */
async function deleteUserLocked(user) {
  const map = await store.readUsersIndex();
  for (const [name, id] of Object.entries(map)) {
    if (id === user.id) delete map[name];
  }
  await store.writeUsersIndex(map);
  await store.deleteUserFile(user.id);
  await store.deleteUserPastesIndex(user.id);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    createdAt: user.createdAt,
    recoveryCodeCount: Array.isArray(user.recoveryCodes) ? user.recoveryCodes.length : 0,
  };
}

module.exports = {
  loadSecret,
  createUser,
  verifyUserPassword,
  changePassword,
  logoutAll,
  createRecoveryCodes,
  resetPasswordWithRecovery,
  deleteUserLocked,
  issueSession,
  verifySession,
  parseCookies,
  sessionCookie,
  clearSessionCookie,
  anonIdFrom,
  anonCookie,
  currentUser,
  publicUser,
};
