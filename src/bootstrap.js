'use strict';

/**
 * 启动初始化：建目录、加载/生成会话密钥、迁移旧数据、重建索引、补全页面名称。
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const store = require('./store');
const auth = require('./auth');

/** 旧版把 HTML 内嵌在 pastes/<code>.json，这里迁移到 blobs/。 */
async function migrateLegacy() {
  const files = await fsp.readdir(config.PASTE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(config.PASTE_DIR, f);
    try {
      const p = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (typeof p.html !== 'string') continue;
      const legacyHtml = p.html;
      const hash = store.sha256(legacyHtml);
      await store.ensureBlob(hash, legacyHtml);
      delete p.html;
      p.hash = hash;
      p.size = Buffer.byteLength(legacyHtml, 'utf8');
      if (!('userId' in p)) p.userId = null;
      if (!p.editKey) p.editKey = store.newCode(16);
      await store.writeJsonAtomic(file, p);
      console.log('[migrate] migrated paste', p.code);
    } catch (e) {
      console.error('[migrate] failed', f, e && e.message);
    }
  }
}

/** 为没有 name 字段的旧记录补上 <title>。 */
async function backfillNames() {
  for (const paste of store.allPastes()) {
    if (typeof paste.name === 'string') continue;
    try {
      const html = await store.pasteContent(paste);
      const name = store.extractTitle(html || '');
      await store.withLock(() => store.renamePasteLocked(paste.code, name));
      if (name) console.log('[backfill] name', paste.code, '=', name);
    } catch (e) {
      console.error('[backfill] failed', paste.code, e && e.message);
    }
  }
}

async function init() {
  await fsp.mkdir(config.PASTE_DIR, { recursive: true });
  await fsp.mkdir(config.BLOB_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(config.USER_DIR, { recursive: true, mode: 0o700 });
  await fsp.mkdir(config.USER_PASTE_DIR, { recursive: true, mode: 0o700 });
  await auth.loadSecret();
  await migrateLegacy();
  const index = await store.loadIndex();
  if (index.failed) {
    console.error(`[store] ${index.failed} paste record(s) failed to load`);
  }
  console.log(`[store] index loaded: ${index.loaded} paste(s)`);
  store.startExpirySweeper();
  const removed = await store.sweepExpired();
  if (removed) console.log(`[store] removed ${removed} expired paste(s)`);
  await backfillNames();
}

module.exports = { init };
