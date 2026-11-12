'use strict';

/**
 * 业务处理器：注册/登录、生成、读取、保存、重命名、删除、我的页面。
 * 所有错误统一遵循：HTTP 200 + { success:false, error }。
 */

const crypto = require('node:crypto');
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
  const items = store.listUserPastes(user.id).map((p) => ({
    code: p.code,
    editKey: p.editKey,
    name: p.name || '',
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
    size: Number(p.size || 0),
    type: p.type || 'code',
    sourceUrl: p.sourceUrl || null,
    hash: p.hash,
  }));
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  const totalBytes = items.reduce((sum, item) => sum + item.size, 0);
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

  await store.withLock(() => store.deletePasteLocked(code));
  return sendJson(res, { success: true });
}

/** 调用方必须已持有 withLock，避免锁重入死锁。 */
async function applyNameLocked(paste, name) {
  if (!name || paste.name === name) return paste;
  return store.renamePasteLocked(paste.code, name);
}

async function applyName(paste, name) {
  if (!name || paste.name === name) return paste;
  return store.withLock(() => store.renamePasteLocked(paste.code, name));
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
    if (!config.URL_FETCH_ENABLED) {
      return sendJson(res, { success: false, error: 'URL 抓取已关闭' });
    }
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
      let existing = store.findUserPasteByHash(user.id, hash);
      if (existing) {
        if (explicitName) existing = await applyName(existing, explicitName);
        return sendJson(res, {
          success: true,
          code: existing.code,
          editKey: existing.editKey,
          name: existing.name || '',
          reused: true,
          createdAt: existing.createdAt,
        });
      }
    } else {
      const existingAnon = store.findAnonPaste(anonId, hash);
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

    const created = await store.withLock(async () => {
      // 锁内二次检查，避免并发重复生成
      if (user) {
        let existing = store.findUserPasteByHash(user.id, hash);
        if (existing) {
          if (explicitName) existing = await applyNameLocked(existing, explicitName);
          return { reused: existing };
        }
      } else {
        const existingAnon = store.findAnonPaste(anonId, hash);
        if (existingAnon) return { reused: existingAnon };
      }
      const code = await store.uniqueCode();
      const editKey = store.newCode(16);
      const paste = await store.createPasteLocked({
        code,
        userId: user ? user.id : null,
        anonId,
        name: derivedName,
        hash,
        html,
        editKey,
        type,
        sourceUrl: type === 'url' ? String(body.url) : undefined,
        size,
      });
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
  const html = await store.pasteContent(paste);
  if (html === null) {
    console.error('[get] blob missing', code, paste.hash);
    return sendJson(res, { success: false, error: '页面内容不可用，请从备份恢复' });
  }
  return sendJson(res, { success: true, html, name: paste.name || '' });
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
  const patch = { hash, size, html };
  if (body.name !== undefined) patch.name = store.cleanName(body.name);

  try {
    const updated = await store.withLock(() => store.updatePasteLocked(code, patch));
    return sendJson(res, { success: true, name: updated.name || '' });
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
  try {
    await store.withLock(() => store.renamePasteLocked(code, name));
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
