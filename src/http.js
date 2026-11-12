'use strict';

/**
 * HTTP 请求/响应工具：JSON、文本、HTML 输出与请求体读取。
 */

const { MAX_BODY, MAX_BYTES, TRUST_PROXY } = require('./config');

function sendJson(res, obj, status = 200, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function sendText(res, text, status = 200, type = 'text/plain;charset=UTF-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(text),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function sendHtml(res, html, extra = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/html;charset=UTF-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    ...extra,
  });
  res.end(html);
}

/** 读取请求体，超过 limit 时抛出 code=TOO_LARGE。 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared && declared > limit) {
      req.pause();
      reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
      return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(Object.assign(new Error('body too large'), { code: 'TOO_LARGE' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
    req.on('aborted', () => reject(Object.assign(new Error('request aborted'), { code: 'ABORTED' })));
  });
}

function sendBodyError(res, req, err) {
  const maxMb = Math.round((MAX_BYTES / 1024 / 1024) * 10) / 10;
  sendJson(
    res,
    {
      success: false,
      error: err && err.code === 'TOO_LARGE' ? `内容过大，最大 ${maxMb}MB` : '请求格式错误',
    },
    200,
    { Connection: 'close' }
  );
  setTimeout(() => {
    try {
      req.destroy();
    } catch {}
  }, 50);
}

async function readJson(req) {
  const buf = await readBody(req, MAX_BODY);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid json'), { code: 'BAD_JSON' });
  }
}

/** 代理场景下优先取 CF / XFF 首个地址，否则取 socket 地址。 */
function clientIp(req) {
  if (TRUST_PROXY) {
    const cf = req.headers['cf-connecting-ip'];
    if (cf) return String(cf).trim();
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',')[0].trim();
  }
  return req.socket.remoteAddress || '0.0.0.0';
}

/** 有 Origin 时必须与 Host 同源（防御基础 CSRF）。 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.host === (req.headers.host || '');
  } catch {
    return false;
  }
}

module.exports = {
  sendJson,
  sendText,
  sendHtml,
  readBody,
  sendBodyError,
  readJson,
  clientIp,
  sameOrigin,
};
