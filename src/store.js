'use strict';

/**
 * 文件存储层。
 *
 * 布局（DATA_DIR 下）：
 *   pastes/<code>.json         链接记录（code / editKey / hash / 大小 / 时间）
 *   blobs/<sha256>.html         HTML 正文，按内容哈希去重
 *   users/<id>.json             用户（scrypt 哈希 + salt）
 *   index/users.json            用户名 → userId
 *   index/user-pastes/<id>.json 用户历史记录索引
 *   secret.key                  会话签名密钥
 *
 * 所有写操作通过 writeJsonAtomic 落盘，并通过 withLock 串行化，
 * 避免并发注册/生成导致索引丢失。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  await fsp.writeFile(tmp, JSON.stringify(obj), { mode: 0o600 });
  await fsp.rename(tmp, file);
}

/** 串行化写操作：前一个任务无论成功失败，后一个都会继续。 */
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn, fn);
  lockChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function newCode(len) {
  let out = '';
  for (let i = 0; i < len; i++) out += config.ALPHABET[crypto.randomInt(config.ALPHABET.length)];
  return out;
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function cleanName(raw, max = 60) {
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 从 HTML 的 <title> 提取页面名称（做最小实体反转义）。 */
function extractTitle(html) {
  const m = String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!m) return '';
  return cleanName(
    m[1]
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;/g, "'")
      .replace(/&#x27;/gi, "'")
  );
}

function urlHost(raw) {
  try {
    return new URL(String(raw)).hostname.slice(0, 60);
  } catch {
    return '';
  }
}

function pasteFile(code) {
  return path.join(config.PASTE_DIR, code + '.json');
}

function blobFile(hash) {
  return path.join(config.BLOB_DIR, hash + '.html');
}

async function readPaste(code) {
  try {
    const obj = JSON.parse(await fsp.readFile(pasteFile(code), 'utf8'));
    if (!obj || typeof obj !== 'object' || typeof obj.code !== 'string') return null;
    if (typeof obj.hash !== 'string' && typeof obj.html !== 'string') return null;
    return obj;
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    console.error('[store] read paste failed', code, e && e.message);
    return null;
  }
}

async function pasteContent(paste) {
  if (paste.hash) {
    try {
      return await fsp.readFile(blobFile(paste.hash), 'utf8');
    } catch {
      return '';
    }
  }
  return typeof paste.html === 'string' ? paste.html : '';
}

async function ensureBlob(hash, html) {
  try {
    await fsp.writeFile(blobFile(hash), html, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
}

async function hashReferenced(hash) {
  const files = await fsp.readdir(config.PASTE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(await fsp.readFile(path.join(config.PASTE_DIR, f), 'utf8'));
      if (p.hash === hash) return true;
    } catch {}
  }
  return false;
}

async function cleanupBlob(hash) {
  if (!hash) return;
  try {
    if (await hashReferenced(hash)) return;
    await fsp.rm(blobFile(hash), { force: true });
  } catch (e) {
    console.error('[store] cleanup blob failed', e && e.message);
  }
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = newCode(8);
    const exists = await fsp
      .access(pasteFile(code))
      .then(() => true)
      .catch(() => false);
    if (!exists) return code;
  }
  throw new Error('code collision');
}

function userFile(userId) {
  return path.join(config.USER_DIR, userId + '.json');
}

async function readUserById(id) {
  if (!/^u_[a-f0-9]{16}$/.test(String(id || ''))) return null;
  try {
    return JSON.parse(await fsp.readFile(userFile(id), 'utf8'));
  } catch {
    return null;
  }
}

async function writeUser(user) {
  await writeJsonAtomic(userFile(user.id), user);
}

async function readUsersIndex() {
  return readJsonFile(config.USERS_INDEX, {});
}

async function writeUsersIndex(map) {
  await writeJsonAtomic(config.USERS_INDEX, map);
}

async function readUserByName(name) {
  const map = await readUsersIndex();
  const id = map[String(name || '').toLowerCase()];
  return id ? readUserById(id) : null;
}

async function readUserPastes(userId) {
  const arr = await readJsonFile(path.join(config.USER_PASTE_DIR, userId + '.json'), []);
  return Array.isArray(arr) ? arr : [];
}

async function writeUserPastes(userId, arr) {
  await writeJsonAtomic(path.join(config.USER_PASTE_DIR, userId + '.json'), arr);
}

module.exports = {
  readJsonFile,
  writeJsonAtomic,
  withLock,
  newCode,
  sha256,
  cleanName,
  extractTitle,
  urlHost,
  pasteFile,
  blobFile,
  readPaste,
  pasteContent,
  ensureBlob,
  cleanupBlob,
  uniqueCode,
  readUserById,
  writeUser,
  readUsersIndex,
  writeUsersIndex,
  readUserByName,
  readUserPastes,
  writeUserPastes,
};
