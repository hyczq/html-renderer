'use strict';

/**
 * 启动初始化：建目录、加载/生成会话密钥、迁移旧数据、补全页面名称。
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
  const files = await fsp.readdir(config.PASTE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    const file = path.join(config.PASTE_DIR, f);
    try {
      const p = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (typeof p.name === 'string') continue;
      p.name = store.extractTitle(await store.pasteContent(p));
      await store.writeJsonAtomic(file, p);
      if (p.name) console.log('[backfill] name', p.code, '=', p.name);
    } catch (e) {
      console.error('[backfill] failed', f, e && e.message);
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
  await backfillNames();
}

module.exports = { init };
