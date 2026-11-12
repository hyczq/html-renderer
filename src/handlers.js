'use strict';

/**
 * 业务处理器：注册/登录、生成、读取、保存、重命名、删除、我的页面。
 * 所有错误统一遵循：HTTP 200 + { success:false, error }。
 */

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('./config');
const { sendJson, sendBodyError, readJson } = require('./http');
const { rateLimited } = require('./rate-limit');
const store = require('./store');
const auth = require('./auth');
const { fetchHtml } = require('./fetch-html');

const CODE_RE = /^[A-Za-z0-9]{4,32}$/;
const USERNAME_RE = /^[\p{L}\p{N}_-]{3,32}$/u;

function keyEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function handleRegister(req, res) {
  if (rateLimited(req, 'auth', 30, 15 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!USERNAME_RE.test(username)) {
    return sendJson(res, { success: false, error: '用户名需 3-32 位，仅限中英文、数字、下划线、短横线' });
  }
  if (password.length < 6 || password.length > 128) {
    return sendJson(res, { success: false, error: '密码长度需 6-128 位' });
  }
  try {
    const user = await auth.createUser(username, password);
    res.setHeader('Set-Cookie', auth.sessionCookie(req, auth.issueSession(user.id)));
    return sendJson(res, { success: true, user: auth.publicUser(user) });
  } catch (e) {
    return sendJson(res, { success: false, error: e.message || '注册失败' });
  }
}

async function handleLogin(req, res) {
  if (rateLimited(req, 'auth', 30, 15 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const user = await store.readUserByName(username);
  if (!(await auth.verifyUserPassword(user, password))) {
    return sendJson(res, { success: false, error: '用户名或密码错误' });
  }
  res.setHeader('Set-Cookie', auth.sessionCookie(req, auth.issueSession(user.id)));
  return sendJson(res, { success: true, user: auth.publicUser(user) });
}

async function handleMe(req, res) {
  const user = await auth.currentUser(req);
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  return sendJson(res, { success: true, user: auth.publicUser(user) });
}

async function handleMy(req, res, url, user) {
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  const offset = Math.max(0, Number(url.searchParams.get('offset') || 0) || 0);
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100) || 100));
  const idx = await store.readUserPastes(user.id);
  const items = [];
  let totalBytes = 0;
  for (const entry of idx) {
    const p = await store.readPaste(entry.code);
    if (!p || p.userId !== user.id) continue;
    totalBytes += Number(p.size || 0);
    items.push({
      code: p.code,
      editKey: p.editKey,
      name: p.name || '',
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      size: Number(p.size || 0),
      type: p.type || 'code',
      sourceUrl: p.sourceUrl || null,
      hash: p.hash,
    });
  }
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return sendJson(res, {
    success: true,
    total: items.length,
    stats: { count: items.length, bytes: totalBytes },
    items: items.slice(offset, offset + limit),
  });
}

async function handleDelete(req, res, user) {
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const code = String(body.code || '');
  if (!CODE_RE.test(code)) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  const paste = await store.readPaste(code);
  if (!paste) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  if (paste.userId !== user.id) return sendJson(res, { success: false, error: '无权删除该页面' });

  await store.withLock(async () => {
    await fsp.rm(store.pasteFile(code), { force: true });
    const idx = await store.readUserPastes(user.id);
    await store.writeUserPastes(
      user.id,
      idx.filter((x) => x.code !== code)
    );
  });
  await store.cleanupBlob(paste.hash);
  return sendJson(res, { success: true });
}

async function findAnonPaste(anonId, hash) {
  if (!anonId) return null;
  const files = await fsp.readdir(config.PASTE_DIR).catch(() => []);
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    try {
      const p = JSON.parse(await fsp.readFile(path.join(config.PASTE_DIR, f), 'utf8'));
      if (!p.userId && p.anonId === anonId && p.hash === hash) return p;
    } catch {}
  }
  return null;
}

async function updateUserIndexName(paste, name) {
  if (!paste.userId) return;
  const idx = await store.readUserPastes(paste.userId);
  const entry = idx.find((x) => x.code === paste.code);
  if (!entry) return;
  entry.name = name;
  entry.updatedAt = paste.updatedAt;
  await store.writeUserPastes(paste.userId, idx);
}

/** 调用方必须已持有 withLock，避免锁重入死锁。 */
async function applyNameLocked(paste, name) {
  if (!name || paste.name === name) return;
  paste.name = name;
  paste.updatedAt = new Date().toISOString();
  await store.writeJsonAtomic(store.pasteFile(paste.code), paste);
  await updateUserIndexName(paste, name);
}

async function applyName(paste, name) {
  if (!name || paste.name === name) return;
  await store.withLock(() => applyNameLocked(paste, name));
}

async function handleGenerate(req, res, user, anonId) {
  const limit = user ? 200 : 60;
  if (rateLimited(req, 'gen', limit, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const type = body.type;
  if (type !== 'url' && type !== 'code') {
    return sendJson(res, { success: false, error: '不支持的类型' });
  }

  let html;
  if (type === 'url') {
    if (!body.url || typeof body.url !== 'string') {
      return sendJson(res, { success: false, error: '请提供 URL' });
    }
    try {
      html = await fetchHtml(body.url);
    } catch (e) {
      return sendJson(res, { success: false, error: e.message || '获取远程页面失败' });
    }
  } else {
    html = typeof body.code === 'string' ? body.code : '';
  }

  const size = Buffer.byteLength(html, 'utf8');
  if (size > config.MAX_BYTES) {
    return sendJson(res, { success: false, error: '内容过大，最大 2MB' });
  }

  const hash = store.sha256(html);
  const explicitName = store.cleanName(body.name);
  const derivedName =
    explicitName || store.extractTitle(html) || (type === 'url' ? store.urlHost(body.url) : '');

  try {
    // SHA-256 去重：同一登录用户相同内容直接复用原链接
    if (user) {
      const idx = await store.readUserPastes(user.id);
      const hit = idx.find((x) => x.hash === hash);
      if (hit) {
        const existing = await store.readPaste(hit.code);
        if (existing && existing.userId === user.id) {
          if (explicitName) await applyName(existing, explicitName);
          return sendJson(res, {
            success: true,
            code: existing.code,
            editKey: existing.editKey,
            name: existing.name || '',
            reused: true,
            createdAt: existing.createdAt,
          });
        }
      }
    }

    if (!user) {
      const existingAnon = await findAnonPaste(anonId, hash);
      if (existingAnon) {
        return sendJson(res, {
          success: true,
          code: existingAnon.code,
          editKey: existingAnon.editKey,
          name: existingAnon.name || '',
          reused: true,
          createdAt: existingAnon.createdAt,
        });
      }
    }

    await store.ensureBlob(hash, html);

    const created = await store.withLock(async () => {
      // 锁内二次检查，避免并发重复生成
      if (user) {
        const idx2 = await store.readUserPastes(user.id);
        const hit2 = idx2.find((x) => x.hash === hash);
        if (hit2) {
          const existing2 = await store.readPaste(hit2.code);
          if (existing2 && existing2.userId === user.id) {
            if (explicitName) await applyNameLocked(existing2, explicitName);
            return { reused: existing2 };
          }
        }
      }
      if (!user) {
        const existingAnon2 = await findAnonPaste(anonId, hash);
        if (existingAnon2) return { reused: existingAnon2 };
      }
      const code = await store.uniqueCode();
      const editKey = store.newCode(16);
      const now = new Date().toISOString();
      const paste = {
        code,
        userId: user ? user.id : null,
        anonId: user ? undefined : anonId,
        name: derivedName,
        hash,
        editKey,
        type,
        sourceUrl: type === 'url' ? String(body.url) : undefined,
        size,
        createdAt: now,
        updatedAt: now,
      };
      await store.writeJsonAtomic(store.pasteFile(code), paste);
      if (user) {
        const idx = await store.readUserPastes(user.id);
        idx.unshift({ code, hash, size, type, name: derivedName, createdAt: now, updatedAt: now });
        await store.writeUserPastes(user.id, idx);
      }
      return { paste };
    });

    if (created.reused) {
      return sendJson(res, {
        success: true,
        code: created.reused.code,
        editKey: created.reused.editKey,
        name: created.reused.name || '',
        reused: true,
        createdAt: created.reused.createdAt,
      });
    }
    return sendJson(res, {
      success: true,
      code: created.paste.code,
      editKey: created.paste.editKey,
      name: created.paste.name || '',
      reused: false,
    });
  } catch (e) {
    console.error('[generate] failed', e);
    return sendJson(res, { success: false, error: '生成失败，请重试' });
  }
}

async function handleGet(req, res, url) {
  const code = url.searchParams.get('code') || '';
  // 优先从请求头读取，避免编辑密钥进入 URL / 访问日志；查询参数保留兼容。
  const key = String(req.headers['x-edit-key'] || url.searchParams.get('key') || '');
  if (!CODE_RE.test(code)) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  const paste = await store.readPaste(code);
  if (!paste) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  if (!keyEquals(key, paste.editKey)) return sendJson(res, { success: false, error: '密钥错误' });
  return sendJson(res, {
    success: true,
    html: await store.pasteContent(paste),
    name: paste.name || '',
  });
}

async function handleSave(req, res) {
  if (rateLimited(req, 'save', 300, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const code = String(body.code || '');
  const key = String(body.key || '');
  if (!CODE_RE.test(code)) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  const paste = await store.readPaste(code);
  if (!paste) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  if (!keyEquals(key, paste.editKey)) return sendJson(res, { success: false, error: '密钥错误' });

  const html = typeof body.html === 'string' ? body.html : '';
  const size = Buffer.byteLength(html, 'utf8');
  if (size > config.MAX_BYTES) {
    return sendJson(res, { success: false, error: '内容过大，最大 2MB' });
  }
  const hash = store.sha256(html);
  const oldHash = paste.hash;

  try {
    if (hash !== oldHash) await store.ensureBlob(hash, html);
    paste.hash = hash;
    paste.size = size;
    if (body.name !== undefined) paste.name = store.cleanName(body.name);
    paste.updatedAt = new Date().toISOString();
    delete paste.html;

    await store.withLock(async () => {
      await store.writeJsonAtomic(store.pasteFile(code), paste);
      if (paste.userId) {
        const idx = await store.readUserPastes(paste.userId);
        const entry = idx.find((x) => x.code === code);
        if (entry) {
          entry.hash = hash;
          entry.size = size;
          entry.name = paste.name || '';
          entry.updatedAt = paste.updatedAt;
          await store.writeUserPastes(paste.userId, idx);
        }
      }
    });

    if (oldHash && oldHash !== hash) await store.cleanupBlob(oldHash);
    return sendJson(res, { success: true, name: paste.name || '' });
  } catch (e) {
    console.error('[save] failed', e);
    return sendJson(res, { success: false, error: '保存失败，请重试' });
  }
}

async function handleRename(req, res, user) {
  if (rateLimited(req, 'rename', 300, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const code = String(body.code || '');
  const key = String(body.key || '');
  if (!CODE_RE.test(code)) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  const paste = await store.readPaste(code);
  if (!paste) return sendJson(res, { success: false, error: '页面不存在或已过期' });

  const byOwner = !!(user && paste.userId && paste.userId === user.id);
  const byKey = !!key && keyEquals(key, paste.editKey);
  if (!byOwner && !byKey) return sendJson(res, { success: false, error: '无权修改该页面' });

  const name = store.cleanName(body.name);
  paste.name = name;
  paste.updatedAt = new Date().toISOString();
  try {
    await store.withLock(async () => {
      await store.writeJsonAtomic(store.pasteFile(code), paste);
      await updateUserIndexName(paste, name);
    });
    return sendJson(res, { success: true, name });
  } catch (e) {
    console.error('[rename] failed', e);
    return sendJson(res, { success: false, error: '重命名失败，请重试' });
  }
}

module.exports = {
  handleRegister,
  handleLogin,
  handleMe,
  handleMy,
  handleDelete,
  handleGenerate,
  handleGet,
  handleSave,
  handleRename,
};
