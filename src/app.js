'use strict';

/**
 * HTTP 路由：页面、预览、编辑页与 JSON API。
 *
 * 安全边界：
 * - 配置 PREVIEW_ORIGIN 后，预览域名只提供 GET/HEAD /p/:code 与密码解锁 POST /p/:code；
 *   不读账号会话、不暴露 API，仅密码链接写路径限定的短期解锁 Cookie。主站 /p/:code 只做 302 跳转。
 * - 未配置 PREVIEW_ORIGIN 时，预览页默认带 CSP sandbox（不透明源），
 *   避免预览页以主站同源身份读取 /api/my 等账号接口。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const { sendJson, sendText, sendHtml, sendRedirect, sameOrigin, readForm } = require('./http');
const { rateLimited } = require('./rate-limit');
const auth = require('./auth');
const handlers = require('./handlers');
const store = require('./store');

const CSP_PAGE =
  "default-src 'self' 'unsafe-inline'; img-src * data:; connect-src 'self'; frame-ancestors 'none'";
const CSP_EDIT =
  "default-src 'self' 'unsafe-inline'; img-src * data:; connect-src 'self'; frame-ancestors 'none'";
const CSP_PREVIEW_BASE =
  "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'none'";
// 永远不要加 allow-same-origin：否则 sandbox 会失去隔离意义。
const CSP_PREVIEW_SANDBOX =
  'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads ' +
  'allow-top-navigation-by-user-activation';
const CSP_PREVIEW = config.PREVIEW_SANDBOX
  ? CSP_PREVIEW_SANDBOX + '; ' + CSP_PREVIEW_BASE
  : CSP_PREVIEW_BASE;

function normalizeHost(host) {
  const value = String(host || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return value.replace(/\.(?=:\d+$|$)/, '');
}

function stripDefaultPort(host) {
  return host.replace(/:(?:80|443)$/, '');
}

function requestHost(req) {
  const forwarded = config.TRUST_PROXY ? req.headers['x-forwarded-host'] : '';
  return normalizeHost(forwarded || req.headers.host || '');
}

function isPreviewHost(req) {
  if (!config.PREVIEW_HOST) return false;
  const actual = requestHost(req);
  const expected = normalizeHost(config.PREVIEW_HOST);
  return actual === expected || stripDefaultPort(actual) === stripDefaultPort(expected);
}

function sendNotFound(req, res, preview) {
  return sendHtml(
    res,
    config.render(config.templates.notFound, renderVars()),
    {
      'Content-Security-Policy': preview ? CSP_PREVIEW : CSP_PAGE,
      'X-Robots-Tag': 'noindex, nofollow',
    },
    404
  );
}

/** 静态公共资源与品牌无关，预览域也可只读获取，供 404 / 页面外壳使用。 */
function serveStaticAsset(res, pathname) {
  if (pathname === '/avatar.svg') {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(config.avatarSvg);
    return true;
  }
  if (pathname === '/theme.css' || pathname === '/theme.js') {
    const isCss = pathname === '/theme.css';
    res.writeHead(200, {
      'Content-Type': isCss ? 'text/css;charset=UTF-8' : 'text/javascript;charset=UTF-8',
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Cross-Origin-Resource-Policy': 'same-origin',
    });
    res.end(isCss ? config.themeCss : config.themeJs);
    return true;
  }
  return false;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[ch]);
}

/** 密码解锁页：不套预览 sandbox，保证表单可正常提交。 */
function sendLockPage(res, code, error = '', status = 200) {
  const errorBlock = error
    ? '<div class="notice error" role="alert">' + escapeHtml(error) + '</div>'
    : '';
  return sendHtml(
    res,
    config.render(config.templates.lock, renderVars({ CODE: code, ERROR_BLOCK: errorBlock })),
    {
      'Content-Security-Policy': CSP_PAGE,
      'X-Robots-Tag': 'noindex, nofollow',
    },
    status
  );
}

async function servePreview(req, res, code, preview = false) {
  let paste = store.getPaste(code);
  if (!store.isAvailable(paste)) return sendNotFound(req, res, preview);

  if (paste.passwordHash && !auth.hasUnlock(req, paste)) {
    return sendLockPage(res, code);
  }

  // hash 已知时先判断缓存，避免 304 还去读 2MB 正文。
  const hashEtag = paste.hash ? '"' + paste.hash + '"' : '';
  if (!paste.singleUse && hashEtag && String(req.headers['if-none-match'] || '').includes(hashEtag)) {
    res.writeHead(304, { ETag: hashEtag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  // 先确认正文可读，再原子消耗单次链接：避免 blob 异常时把链接白烧掉。
  // HEAD 只用于探测，不消耗链接。
  const html = await store.pasteContent(paste);
  if (html === null) {
    console.error('[preview] blob missing', code, paste.hash);
    return sendText(res, '页面内容不可用，请从备份恢复', 500);
  }
  if (paste.singleUse && req.method !== 'HEAD') {
    const consumed = await store.consumeSingleUse(code);
    if (!consumed) return sendNotFound(req, res, preview);
  }
  const etag = hashEtag || '"' + store.sha256(html) + '"';
  const headers = {
    'Content-Security-Policy': CSP_PREVIEW,
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'X-Robots-Tag': 'noindex, nofollow',
    'Cache-Control': paste.singleUse ? 'no-store' : 'no-cache',
    ETag: etag,
  };
  return sendHtml(res, html, headers);
}

/** 处理密码解锁表单：校验通过后写 HttpOnly 短期 Cookie，再 303 回预览页。 */
async function handleUnlock(req, res, code, preview = false) {
  if (rateLimited(req, 'unlock:' + code, 8, 10 * 60 * 1000)) {
    return sendLockPage(res, code, '尝试次数过多，请 10 分钟后再试', 429);
  }
  let form;
  try {
    form = await readForm(req, 4096);
  } catch {
    return sendLockPage(res, code, '请求格式错误', 400);
  }
  const paste = store.getPaste(code);
  if (!store.isAvailable(paste)) return sendNotFound(req, res, preview);
  if (!paste.passwordHash) return sendRedirect(res, '/p/' + code, 303);

  const password = String(form.get('password') || '');
  const ok = await auth.verifyLinkPassword(paste, password);
  if (!ok) return sendLockPage(res, code, '密码错误，请重试');

  const token = auth.issueUnlockToken(code, paste.passwordHash);
  res.setHeader('Set-Cookie', auth.unlockCookie(req, code, token));
  return sendRedirect(res, '/p/' + code, 303);
}

function renderVars(extra = {}) {
  return { BRAND: config.BRAND, PREVIEW_ORIGIN: config.PREVIEW_ORIGIN, DEFAULT_EXPIRY: config.DEFAULT_LINK_EXPIRY, ...extra };
}

function createServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 'Bad Request', 400);
    }

    const previewMatch = pathname.match(/^\/p\/([A-Za-z0-9]{4,32})\/?$/);

    try {
      const isGet = req.method === 'GET' || req.method === 'HEAD';
      if (isGet && serveStaticAsset(res, pathname)) return;

      // 预览域名是独立 origin：只允许只读预览，其他一律 404。
      if (isPreviewHost(req)) {
        if (isGet && previewMatch) {
          return servePreview(req, res, previewMatch[1], true);
        }
        // 预览域只额外接受“解锁密码”这一种 POST，不暴露任何账号或写入 API。
        if (req.method === 'POST' && previewMatch) {
          if (!sameOrigin(req)) {
            return sendJson(res, { success: false, error: '非法请求来源' }, 403);
          }
          return handleUnlock(req, res, previewMatch[1], true);
        }
        if (isGet) return sendNotFound(req, res, true);
        return sendText(res, 'Not Found', 404);
      }

      if (isGet) {
        if (pathname === '/' || pathname === '/index.html') {
          if (!auth.anonIdFrom(req)) {
            res.setHeader('Set-Cookie', auth.anonCookie(req, crypto.randomBytes(16).toString('hex')));
          }
          return sendHtml(res, config.render(config.templates.index, renderVars()), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/login') {
          return sendHtml(res, config.render(config.templates.login, renderVars()), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/my') {
          return sendHtml(res, config.render(config.templates.my, renderVars()), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/settings') {
          return sendHtml(res, config.render(config.templates.settings, renderVars()), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/recover') {
          return sendHtml(res, config.render(config.templates.recover, renderVars()), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/healthz') return sendText(res, 'ok');

        if (previewMatch) {
          // 主站不再渲染任意 HTML；跳转到独立预览域，避免旧链接形成同源执行。
          if (config.PREVIEW_ORIGIN) {
            return sendRedirect(res, config.PREVIEW_ORIGIN + '/p/' + encodeURIComponent(previewMatch[1]));
          }
          return servePreview(req, res, previewMatch[1]);
        }

        const e = pathname.match(/^\/edit\/([A-Za-z0-9]{4,32})\/?$/);
        if (e) {
          return sendHtml(res, config.render(config.templates.edit, renderVars({ CODE: e[1] })), {
            'Content-Security-Policy': CSP_EDIT,
          });
        }

        if (pathname === '/api/get') return handlers.handleGet(req, res, u);
        if (pathname === '/api/me') return handlers.handleMe(req, res);
        if (pathname === '/api/my') {
          return handlers.handleMy(req, res, u, await auth.currentUser(req));
        }

        if (pathname.startsWith('/api/')) {
          return sendJson(res, { success: false, error: 'Not Found' }, 404);
        }
        return sendNotFound(req, res, false);
      }

      if (req.method === 'POST') {
        if (!sameOrigin(req)) {
          return sendJson(res, { success: false, error: '非法请求来源' }, 403);
        }
        if (previewMatch) {
          if (config.PREVIEW_ORIGIN) {
            return sendRedirect(
              res,
              config.PREVIEW_ORIGIN + '/p/' + encodeURIComponent(previewMatch[1]),
              303
            );
          }
          return handleUnlock(req, res, previewMatch[1], false);
        }
        if (pathname === '/generate') {
          let aid = auth.anonIdFrom(req);
          if (!aid) {
            aid = crypto.randomBytes(16).toString('hex');
            res.setHeader('Set-Cookie', auth.anonCookie(req, aid));
          }
          return handlers.handleGenerate(req, res, await auth.currentUser(req), aid);
        }
        if (pathname === '/api/save') return handlers.handleSave(req, res);
        if (pathname === '/api/register') return handlers.handleRegister(req, res);
        if (pathname === '/api/login') return handlers.handleLogin(req, res);
        if (pathname === '/api/recover') return handlers.handleRecover(req, res);
        if (pathname === '/api/password') {
          return handlers.handleChangePassword(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/logout-all') {
          return handlers.handleLogoutAll(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/recovery-codes') {
          return handlers.handleGenerateRecoveryCodes(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/account/delete') {
          return handlers.handleDeleteAccount(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/logout') {
          res.setHeader('Set-Cookie', auth.clearSessionCookie(req));
          return sendJson(res, { success: true });
        }
        if (pathname === '/api/delete') {
          return handlers.handleDelete(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/rename') {
          return handlers.handleRename(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/link/password') {
          return handlers.handleLinkPassword(req, res, await auth.currentUser(req));
        }
        return sendJson(res, { success: false, error: 'Not Found' }, 404);
      }

      res.writeHead(405, { Allow: 'GET, POST' });
      res.end('Method Not Allowed');
    } catch (err) {
      console.error('[server] unhandled', err);
      if (!res.headersSent) sendText(res, 'Internal Server Error', 500);
      else res.end();
    }
  });

  server.keepAliveTimeout = 65000;
  server.headersTimeout = 70000;
  return server;
}

module.exports = { createServer };
