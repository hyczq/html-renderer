'use strict';

/**
 * HTTP 路由：页面、预览、编辑页与 JSON API。
 */

const http = require('node:http');
const crypto = require('node:crypto');
const config = require('./config');
const { sendJson, sendText, sendHtml, sameOrigin } = require('./http');
const auth = require('./auth');
const handlers = require('./handlers');
const store = require('./store');

const CSP_PAGE =
  "default-src 'self' 'unsafe-inline'; img-src * data:; connect-src 'self'; frame-ancestors 'none'";
const CSP_EDIT =
  "default-src 'self' 'unsafe-inline'; img-src * data:; connect-src 'self'; frame-ancestors 'none'";
const CSP_PREVIEW = "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; frame-ancestors 'none'";

function createServer() {
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    let pathname = u.pathname;
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return sendText(res, 'Bad Request', 400);
    }

    try {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') {
          if (!auth.anonIdFrom(req)) {
            res.setHeader('Set-Cookie', auth.anonCookie(req, crypto.randomBytes(16).toString('hex')));
          }
          return sendHtml(res, config.render(config.templates.index, { BRAND: config.BRAND }), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/login') {
          return sendHtml(res, config.render(config.templates.login, { BRAND: config.BRAND }), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/my') {
          return sendHtml(res, config.render(config.templates.my, { BRAND: config.BRAND }), {
            'Content-Security-Policy': CSP_PAGE,
          });
        }
        if (pathname === '/avatar.svg') {
          res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
          return res.end(config.avatarSvg);
        }
        if (pathname === '/healthz') return sendText(res, 'ok');

        const m = pathname.match(/^\/p\/([A-Za-z0-9]{4,32})\/?$/);
        if (m) {
          const paste = await store.readPaste(m[1]);
          if (!paste) return sendText(res, '页面不存在或已过期', 404);
          const html = await store.pasteContent(paste);
          return sendHtml(res, html, {
            'Content-Security-Policy': CSP_PREVIEW,
            'Referrer-Policy': 'no-referrer',
            'X-Frame-Options': 'DENY',
            'X-Robots-Tag': 'noindex, nofollow',
            'Cache-Control': 'no-cache',
          });
        }

        const e = pathname.match(/^\/edit\/([A-Za-z0-9]{4,32})\/?$/);
        if (e) {
          return sendHtml(res, config.render(config.templates.edit, { BRAND: config.BRAND, CODE: e[1] }), {
            'Content-Security-Policy': CSP_EDIT,
          });
        }

        if (pathname === '/api/get') return handlers.handleGet(req, res, u);
        if (pathname === '/api/me') return handlers.handleMe(req, res);
        if (pathname === '/api/my') {
          return handlers.handleMy(req, res, u, await auth.currentUser(req));
        }

        return sendText(res, pathname.startsWith('/p/') ? '页面不存在或已过期' : 'Not Found', 404);
      }

      if (req.method === 'POST') {
        if (!sameOrigin(req)) {
          return sendJson(res, { success: false, error: '非法请求来源' }, 403);
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
        if (pathname === '/api/logout') {
          res.setHeader('Set-Cookie', auth.clearSessionCookie());
          return sendJson(res, { success: true });
        }
        if (pathname === '/api/delete') {
          return handlers.handleDelete(req, res, await auth.currentUser(req));
        }
        if (pathname === '/api/rename') {
          return handlers.handleRename(req, res, await auth.currentUser(req));
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
