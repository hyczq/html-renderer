'use strict';

/**
 * 文件存储层。
 *
 * 布局（DATA_DIR 下）：
 *   pastes/<code>.json         链接记录（唯一事实来源）
 *   blobs/<sha256>.html        HTML 正文，按内容哈希去重
 *   users/<id>.json            用户（scrypt 哈希 + salt）
 *   index/users.json           用户名 → userId
 *   secret.key                 会话签名密钥
 *
 * 可靠性设计：
 * - 启动时扫描 pastes/ 重建内存索引；不再依赖 index/user-pastes（旧文件会被忽略）。
 * - 所有 paste 变更在同一个写锁内完成，索引与文件同步更新。
 * - blob 使用引用计数 + 延迟 GC，避免并发创建/删除时误删仍在引用的正文。
 * - writeJsonAtomic 对文件和目录做 fsync，降低掉电丢数据窗口。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');

const rawGrace = process.env.BLOB_GC_GRACE_MS;
const parsedGrace = rawGrace === undefined || rawGrace === '' ? NaN : Number(rawGrace);
const BLOB_GC_GRACE_MS =
  Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : 10 * 60 * 1000;

const state = {
  pastes: new Map(), // code -> paste metadata
  byUser: new Map(), // userId -> Set<code>
  byUserHash: new Map(), // userId\0hash -> Set<code>
  byAnonHash: new Map(), // anonId\0hash -> Set<code>
  blobRefs: new Map(), // hash -> reference count
};
const pendingBlobDeletes = new Map(); // hash -> deleteAfter timestamp
let gcTimer = null;

async function readJsonFile(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    throw e;
  }
}

/** 原子写：临时文件 fsync、rename、目录 fsync。 */
async function writeJsonAtomic(file, obj) {
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(JSON.stringify(obj));
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fsp.rename(tmp, file);
  try {
    const dir = await fsp.open(path.dirname(file), 'r');
    try {
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch {
    // 部分平台不支持目录 fsync；文件本身已 fsync。
  }
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

function userHashKey(userId, hash) {
  return userId + '\0' + hash;
}

function anonHashKey(anonId, hash) {
  return anonId + '\0' + hash;
}

function addToMap(map, key, code) {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(code);
}

function removeFromMap(map, key, code) {
  const set = map.get(key);
  if (!set) return;
  set.delete(code);
  if (!set.size) map.delete(key);
}

function retainHash(hash) {
  if (!hash) return;
  pendingBlobDeletes.delete(hash);
  state.blobRefs.set(hash, (state.blobRefs.get(hash) || 0) + 1);
}

function releaseHash(hash) {
  if (!hash) return;
  const next = (state.blobRefs.get(hash) || 0) - 1;
  if (next > 0) {
    state.blobRefs.set(hash, next);
    return;
  }
  state.blobRefs.delete(hash);
  pendingBlobDeletes.set(hash, Date.now() + BLOB_GC_GRACE_MS);
}

function indexPaste(paste) {
  state.pastes.set(paste.code, paste);
  if (paste.userId) {
    addToMap(state.byUser, paste.userId, paste.code);
    addToMap(state.byUserHash, userHashKey(paste.userId, paste.hash), paste.code);
  } else if (paste.anonId) {
    addToMap(state.byAnonHash, anonHashKey(paste.anonId, paste.hash), paste.code);
  }
  retainHash(paste.hash);
}

function unindexPaste(paste) {
  state.pastes.delete(paste.code);
  if (paste.userId) {
    removeFromMap(state.byUser, paste.userId, paste.code);
    removeFromMap(state.byUserHash, userHashKey(paste.userId, paste.hash), paste.code);
  } else if (paste.anonId) {
    removeFromMap(state.byAnonHash, anonHashKey(paste.anonId, paste.hash), paste.code);
  }
  releaseHash(paste.hash);
}

/** 启动时从 pastes/ 重建索引；旧版 index/user-pastes 会被忽略。 */
async function loadIndex() {
  state.pastes.clear();
  state.byUser.clear();
  state.byUserHash.clear();
  state.byAnonHash.clear();
  state.blobRefs.clear();
  pendingBlobDeletes.clear();

  const files = await fsp.readdir(config.PASTE_DIR).catch(() => []);
  let loaded = 0;
  let failed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = await fsp.readFile(path.join(config.PASTE_DIR, file), 'utf8');
      const paste = JSON.parse(raw);
      if (!paste || typeof paste !== 'object' || typeof paste.code !== 'string') {
        throw new Error('invalid paste record');
      }
      if (paste.code + '.json' !== file) throw new Error('code/file mismatch');
      if (typeof paste.hash !== 'string' && typeof paste.html !== 'string') {
        throw new Error('missing hash');
      }
      indexPaste(paste);
      loaded++;
    } catch (e) {
      failed++;
      console.error('[store] load paste failed', file, e && e.message);
    }
  }

  if (!gcTimer) {
    const interval = Math.max(1000, Math.min(60_000, BLOB_GC_GRACE_MS || 1000));
    gcTimer = setInterval(() => {
      sweepBlobs().catch((e) => console.error('[store] blob gc failed', e && e.message));
    }, interval);
    gcTimer.unref();
  }
  return { loaded, failed };
}

function readPaste(code) {
  const paste = state.pastes.get(code);
  return paste ? { ...paste } : null;
}

function getPaste(code) {
  return state.pastes.get(code) || null;
}

function allPastes() {
  return [...state.pastes.values()].map((paste) => ({ ...paste }));
}

function listUserPastes(userId) {
  const codes = state.byUser.get(userId);
  if (!codes) return [];
  const out = [];
  for (const code of codes) {
    const paste = state.pastes.get(code);
    if (paste) out.push({ ...paste });
  }
  return out;
}

function findUserPasteByHash(userId, hash) {
  const codes = state.byUserHash.get(userHashKey(userId, hash));
  if (!codes) return null;
  for (const code of codes) {
    const paste = state.pastes.get(code);
    if (paste) return { ...paste };
  }
  return null;
}

function findAnonPaste(anonId, hash) {
  const codes = state.byAnonHash.get(anonHashKey(anonId, hash));
  if (!codes) return null;
  for (const code of codes) {
    const paste = state.pastes.get(code);
    if (paste) return { ...paste };
  }
  return null;
}

async function pasteContent(paste) {
  if (!paste) return null;
  if (paste.hash) {
    try {
      return await fsp.readFile(blobFile(paste.hash), 'utf8');
    } catch {
      return null;
    }
  }
  return typeof paste.html === 'string' ? paste.html : null;
}

/** 低层写入：迁移旧数据时使用；正常创建请走 createPasteLocked。 */
async function ensureBlob(hash, html) {
  const file = blobFile(hash);
  try {
    await fsp.access(file);
    return;
  } catch {}

  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  const handle = await fsp.open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(html);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fsp.rename(tmp, file);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    if (e.code !== 'EEXIST') throw e;
  }
}

/** 调用方必须已持有 withLock。 */
async function createPasteLocked(input) {
  await ensureBlob(input.hash, input.html);
  const now = new Date().toISOString();
  const paste = {
    code: input.code,
    userId: input.userId || null,
    anonId: input.userId ? undefined : input.anonId,
    name: input.name || '',
    hash: input.hash,
    editKey: input.editKey,
    type: input.type || 'code',
    sourceUrl: input.type === 'url' ? input.sourceUrl : undefined,
    size: input.size,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(pasteFile(paste.code), paste);
  indexPaste(paste);
  return { ...paste };
}

/** 调用方必须已持有 withLock。patch.html 仅用于新 hash 写 blob，不会落盘。 */
async function updatePasteLocked(code, patch) {
  const old = state.pastes.get(code);
  if (!old) throw new Error('页面不存在');
  const next = { ...old, ...patch, updatedAt: patch.updatedAt || new Date().toISOString() };
  delete next.html;
  if (patch.hash && patch.html !== undefined) {
    await ensureBlob(patch.hash, patch.html);
  }
  await writeJsonAtomic(pasteFile(code), next);
  unindexPaste(old);
  indexPaste(next);
  return { ...next };
}

/** 调用方必须已持有 withLock。 */
async function renamePasteLocked(code, name) {
  const old = state.pastes.get(code);
  if (!old) throw new Error('页面不存在');
  const next = { ...old, name, updatedAt: new Date().toISOString() };
  await writeJsonAtomic(pasteFile(code), next);
  state.pastes.set(code, next);
  return { ...next };
}

/** 调用方必须已持有 withLock。 */
async function deletePasteLocked(code) {
  const paste = state.pastes.get(code);
  if (!paste) return null;
  await fsp.rm(pasteFile(code), { force: true });
  unindexPaste(paste);
  return { ...paste };
}

async function uniqueCode() {
  for (let i = 0; i < 10; i++) {
    const code = newCode(8);
    if (!state.pastes.has(code)) return code;
  }
  throw new Error('code collision');
}

async function sweepBlobs() {
  await withLock(async () => {
    const now = Date.now();
    for (const [hash, due] of pendingBlobDeletes) {
      if (due > now) continue;
      if (state.blobRefs.has(hash)) {
        pendingBlobDeletes.delete(hash);
        continue;
      }
      try {
        await fsp.rm(blobFile(hash), { force: true });
        pendingBlobDeletes.delete(hash);
      } catch (e) {
        console.error('[store] sweep blob failed', hash, e && e.message);
      }
    }
  });
}

/** 启动/诊断用：列出没有被任何 paste 引用的 blob。 */
async function listOrphanBlobs() {
  const files = await fsp.readdir(config.BLOB_DIR).catch(() => []);
  return files
    .filter((file) => /^[a-f0-9]{64}\.html$/.test(file))
    .filter((file) => !state.blobRefs.has(file.slice(0, -5)));
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
  loadIndex,
  readPaste,
  getPaste,
  allPastes,
  listUserPastes,
  findUserPasteByHash,
  findAnonPaste,
  pasteContent,
  ensureBlob,
  createPasteLocked,
  updatePasteLocked,
  renamePasteLocked,
  deletePasteLocked,
  uniqueCode,
  sweepBlobs,
  listOrphanBlobs,
  readUserById,
  writeUser,
  readUsersIndex,
  writeUsersIndex,
  readUserByName,
};
