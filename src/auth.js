'use strict';

/**
 * 账号与会话：scrypt 密码哈希 + HMAC-SHA256 签名 Cookie。
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { promisify } = require('node:util');
const config = require('./config');
const store = require('./store');

const scryptAsync = promisify(crypto.scrypt);
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

async function createUser(rawUsername, password) {
  return store.withLock(async () => {
    const username = String(rawUsername || '').trim();
    const lower = username.toLowerCase();
    const map = await store.readUsersIndex();
    if (map[lower]) throw new Error('用户名已存在');
    const id = 'u_' + crypto.randomBytes(8).toString('hex');
    const salt = crypto.randomBytes(16).toString('hex');
    const passHash = await scryptHash(password, salt);
    const user = {
      id,
      username,
      usernameLower: lower,
      salt,
      passHash,
      createdAt: new Date().toISOString(),
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

function issueSession(userId) {
  const exp = Date.now() + config.SESSION_TTL_MS;
  const payload = 'v1.' + userId + '.' + exp;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== 'v1') return null;
  const [, userId, expStr, sig] = parts;
  const exp = Number(expStr);
  if (!userId || !Number.isFinite(exp) || exp < Date.now()) return null;
  const payload = 'v1.' + userId + '.' + expStr;
  const expected = crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  return crypto.timingSafeEqual(a, b) ? userId : null;
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
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

function sessionCookie(req, token) {
  const parts = [
    'hr_session=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + Math.floor(config.SESSION_TTL_MS / 1000),
  ];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

function clearSessionCookie() {
  return 'hr_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

function anonIdFrom(req) {
  const v = parseCookies(req).hr_aid;
  return /^[a-f0-9]{32}$/.test(String(v || '')) ? v : '';
}

function anonCookie(req, id) {
  const parts = ['hr_aid=' + id, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=31536000'];
  if (isHttps(req)) parts.push('Secure');
  return parts.join('; ');
}

async function currentUser(req) {
  const token = parseCookies(req).hr_session;
  const userId = verifySession(token);
  if (!userId) return null;
  return store.readUserById(userId);
}

function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

module.exports = {
  loadSecret,
  createUser,
  verifyUserPassword,
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
