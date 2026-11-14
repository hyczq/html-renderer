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

const EXPIRY_KEYS = new Set(Object.keys(config.LINK_EXPIRY));
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;

function normalizeExpiry(raw) {
  if (raw === undefined || raw === null || raw === '') return config.DEFAULT_LINK_EXPIRY;
  const key = String(raw);
  return EXPIRY_KEYS.has(key) ? key : null;
}

/** 系统生成的访问密码：6 位数字，允许前导零。 */
function generateLinkPassword() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/** 解析 passwordMode/password；返回 { mode, plain } 或 { error }。 */
function parsePasswordInput(body) {
  let mode = body.passwordMode;
  if (mode === undefined || mode === null || mode === '') {
    mode = body.password ? 'custom' : 'none';
  }
  mode = String(mode);
  if (mode === 'none') return { mode: 'none', plain: null };
  if (mode === 'auto') return { mode: 'auto', plain: generateLinkPassword() };
  if (mode !== 'custom') return { error: '不支持的密码模式' };
  const plain = String(body.password || '').trim();
  if (plain.length < PASSWORD_MIN || plain.length > PASSWORD_MAX) {
    return { error: `访问密码需 ${PASSWORD_MIN}-${PASSWORD_MAX} 位` };
  }
  if (/[\u0000-\u001f\u007f]/.test(plain)) return { error: '访问密码包含非法字符' };
  return { mode: 'custom', plain };
}

/** 链接返回给前端的公开字段（绝不包含密码哈希）。 */
function publicPasteMeta(paste) {
  return {
    expiry: paste.expiry || 'never',
    expiresAt: paste.expiresAt || null,
    singleUse: !!paste.singleUse,
    consumedAt: paste.consumedAt || null,
    views: Number(paste.views || 0),
    passwordProtected: !!paste.passwordHash,
  };
}

/**
 * 去重是否可复用：只有未设密码、非单次、有效期档位相同，且剩余时间不短于
 * 该档位的链接才复用。5 分钟容差用于覆盖“刚创建、剩余时间略短于整档”的情况。
 */
function canReusePaste(paste, expiry, now) {
  if (!store.isAvailable(paste)) return false;
  if (paste.singleUse || paste.passwordHash) return false;
  if ((paste.expiry || 'never') !== expiry) return false;
  const tier = config.LINK_EXPIRY[expiry];
  if (!tier || tier.ms === null) return true;
  const remaining = paste.expiresAt ? Date.parse(paste.expiresAt) - now : Infinity;
  if (!Number.isFinite(remaining)) return false;
  return remaining >= tier.ms - 5 * 60 * 1000;
}

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
    res.setHeader('Set-Cookie', auth.sessionCookie(req, auth.issueSession(user.id, user.sessionEpoch || 0)));
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
  res.setHeader('Set-Cookie', auth.sessionCookie(req, auth.issueSession(user.id, user.sessionEpoch || 0)));
  return sendJson(res, { success: true, user: auth.publicUser(user) });
}

async function handleMe(req, res) {
  const user = await auth.currentUser(req);
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  return sendJson(res, { success: true, user: auth.publicUser(user) });
}

async function handleChangePassword(req, res, user) {
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  if (rateLimited(req, 'password', 10, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  if (newPassword.length < 6 || newPassword.length > 128) {
    return sendJson(res, { success: false, error: '新密码长度需 6-128 位' });
  }
  if (newPassword === oldPassword) {
    return sendJson(res, { success: false, error: '新密码不能与旧密码相同' });
  }
  try {
    const updated = await auth.changePassword(user.id, oldPassword, newPassword);
    res.setHeader(
      'Set-Cookie',
      auth.sessionCookie(req, auth.issueSession(user.id, updated.sessionEpoch || 0))
    );
    return sendJson(res, { success: true });
  } catch (e) {
    if (e.message === '旧密码错误') {
      return sendJson(res, { success: false, error: '旧密码错误' });
    }
    return sendJson(res, { success: false, error: '修改失败，请重试' });
  }
}

async function handleLogoutAll(req, res, user) {
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  if (rateLimited(req, 'logout-all', 20, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  try {
    await auth.logoutAll(user.id);
    res.setHeader('Set-Cookie', auth.clearSessionCookie(req));
    return sendJson(res, { success: true });
  } catch {
    return sendJson(res, { success: false, error: '操作失败，请重试' });
  }
}

async function handleGenerateRecoveryCodes(req, res, user) {
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  if (rateLimited(req, 'recovery-codes', 10, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const password = String(body.password || '');
  if (!(await auth.verifyUserPassword(user, password))) {
    return sendJson(res, { success: false, error: '密码错误' });
  }
  try {
    const codes = await auth.createRecoveryCodes(user.id);
    return sendJson(res, { success: true, codes });
  } catch {
    return sendJson(res, { success: false, error: '生成恢复码失败，请重试' });
  }
}

async function handleRecover(req, res) {
  if (rateLimited(req, 'recover', 10, 15 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const username = String(body.username || '').trim();
  const code = String(body.code || '');
  const newPassword = String(body.newPassword || '');
  if (!USERNAME_RE.test(username) || !code || newPassword.length < 6 || newPassword.length > 128) {
    return sendJson(res, { success: false, error: '恢复码无效或已使用' });
  }
  try {
    const user = await auth.resetPasswordWithRecovery(username, code, newPassword);
    res.setHeader(
      'Set-Cookie',
      auth.sessionCookie(req, auth.issueSession(user.id, user.sessionEpoch || 0))
    );
    return sendJson(res, { success: true });
  } catch {
    return sendJson(res, { success: false, error: '恢复码无效或已使用' });
  }
}

async function handleDeleteAccount(req, res, user) {
  if (!user) return sendJson(res, { success: false, error: '未登录', needLogin: true });
  if (rateLimited(req, 'account-delete', 5, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const password = String(body.password || '');
  if (!(await auth.verifyUserPassword(user, password))) {
    return sendJson(res, { success: false, error: '密码错误' });
  }
  if (String(body.confirmUsername || '').trim() !== user.username) {
    return sendJson(res, { success: false, error: '请输入完整用户名确认注销' });
  }
  try {
    await store.withLock(async () => {
      // 必须包含已过期/已消费的记录，否则注销后这些元数据会残留在 pastes/。
      const pages = store.allPastes().filter((paste) => paste.userId === user.id);
      for (const paste of pages) {
        await store.deletePasteLocked(paste.code);
      }
      await auth.deleteUserLocked(user);
    });
    res.setHeader('Set-Cookie', auth.clearSessionCookie(req));
    return sendJson(res, { success: true });
  } catch (e) {
    console.error('[account-delete] failed', e);
    return sendJson(res, { success: false, error: '注销失败，请重试' });
  }
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
    ...publicPasteMeta(p),
  }));
  items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // 同一 hash 的多个链接只占一份正文，统计时按 hash 去重。
  const seenHashes = new Set();
  let totalBytes = 0;
  for (const item of items) {
    const key = item.hash || 'code:' + item.code;
    if (seenHashes.has(key)) continue;
    seenHashes.add(key);
    totalBytes += Number(item.size || 0);
  }
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

  const expiry = normalizeExpiry(body.expiry);
  if (!expiry) return sendJson(res, { success: false, error: '有效期选项无效' });
  const password = parsePasswordInput(body);
  if (password.error) return sendJson(res, { success: false, error: password.error });

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

  const tier = config.LINK_EXPIRY[expiry];
  const now = Date.now();
  const expiresAt = tier.ms === null ? null : new Date(now + tier.ms).toISOString();

  let passwordInfo = null;
  if (password.plain) {
    try {
      passwordInfo = await auth.hashLinkPassword(password.plain);
    } catch (e) {
      console.error('[generate] hash password failed', e);
      return sendJson(res, { success: false, error: '生成失败，请重试' });
    }
  }

  // 密码链接与单次链接不复用；其余按剩余有效期判断，避免复用“快过期”的旧链接。
  function reusable(list) {
    if (password.plain || expiry === 'once') return null;
    return list.find((item) => canReusePaste(item, expiry, now)) || null;
  }

  function reusedResponse(paste) {
    return sendJson(res, {
      success: true,
      code: paste.code,
      editKey: paste.editKey,
      name: paste.name || '',
      reused: true,
      createdAt: paste.createdAt,
      ...publicPasteMeta(paste),
    });
  }

  try {
    if (user) {
      let existing = reusable(store.findUserPastesByHash(user.id, hash));
      if (existing) {
        if (explicitName) existing = await applyName(existing, explicitName);
        return reusedResponse(existing);
      }
    } else {
      const existing = reusable(store.findAnonPastesByHash(anonId, hash));
      if (existing) return reusedResponse(existing);
    }

    const created = await store.withLock(async () => {
      // 锁内二次检查，避免并发重复生成
      if (user) {
        let existing = reusable(store.findUserPastesByHash(user.id, hash));
        if (existing) {
          if (explicitName) existing = await applyNameLocked(existing, explicitName);
          return { reused: existing };
        }
      } else {
        const existing = reusable(store.findAnonPastesByHash(anonId, hash));
        if (existing) return { reused: existing };
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
        expiry,
        expiresAt,
        singleUse: !!tier.singleUse,
        passwordHash: passwordInfo ? passwordInfo.hash : null,
        passwordSalt: passwordInfo ? passwordInfo.salt : null,
        passwordUpdatedAt: passwordInfo ? new Date().toISOString() : null,
      });
      return { paste };
    });

    if (created.reused) return reusedResponse(created.reused);
    return sendJson(res, {
      success: true,
      code: created.paste.code,
      editKey: created.paste.editKey,
      name: created.paste.name || '',
      reused: false,
      createdAt: created.paste.createdAt,
      ...publicPasteMeta(created.paste),
      password: password.mode === 'auto' ? password.plain : undefined,
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
  return sendJson(res, {
    success: true,
    html,
    name: paste.name || '',
    ...publicPasteMeta(paste),
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

/** 设置/重置/移除链接访问密码：登录所有者或持有 editKey 均可操作。 */
async function handleLinkPassword(req, res, user) {
  if (rateLimited(req, 'link-password', 60, 60 * 60 * 1000)) {
    return sendJson(res, { success: false, error: '操作太频繁，请稍后再试' });
  }
  let body;
  try {
    body = await readJson(req);
  } catch (e) {
    return sendBodyError(res, req, e);
  }
  const code = String(body.code || '');
  const key = String(req.headers['x-edit-key'] || body.key || '');
  if (!CODE_RE.test(code)) return sendJson(res, { success: false, error: '页面不存在或已过期' });
  const paste = await store.readPaste(code);
  if (!paste) return sendJson(res, { success: false, error: '页面不存在或已过期' });

  const byOwner = !!(user && paste.userId && paste.userId === user.id);
  const byKey = !!key && keyEquals(key, paste.editKey);
  if (!byOwner && !byKey) return sendJson(res, { success: false, error: '无权修改该链接' });

  const action = String(body.action || '');
  let plain = null;
  if (action === 'generate') {
    plain = generateLinkPassword();
  } else if (action === 'set') {
    const parsed = parsePasswordInput({ passwordMode: 'custom', password: body.password });
    if (parsed.error) return sendJson(res, { success: false, error: parsed.error });
    plain = parsed.plain;
  } else if (action !== 'remove') {
    return sendJson(res, { success: false, error: '不支持的密码操作' });
  }

  let info = null;
  if (plain) {
    try {
      info = await auth.hashLinkPassword(plain);
    } catch (e) {
      console.error('[link-password] hash failed', e);
      return sendJson(res, { success: false, error: '操作失败，请重试' });
    }
  }

  try {
    const updated = await store.withLock(() =>
      store.updatePasteLocked(code, {
        passwordHash: info ? info.hash : null,
        passwordSalt: info ? info.salt : null,
        passwordUpdatedAt: info ? new Date().toISOString() : null,
      })
    );
    return sendJson(res, {
      success: true,
      passwordProtected: !!updated.passwordHash,
      password: action === 'generate' ? plain : undefined,
    });
  } catch (e) {
    console.error('[link-password] failed', e);
    return sendJson(res, { success: false, error: '操作失败，请重试' });
  }
}

module.exports = {
  handleRegister,
  handleLogin,
  handleMe,
  handleChangePassword,
  handleLogoutAll,
  handleGenerateRecoveryCodes,
  handleRecover,
  handleDeleteAccount,
  handleMy,
  handleDelete,
  handleGenerate,
  handleGet,
  handleSave,
  handleRename,
  handleLinkPassword,
};
