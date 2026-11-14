'use strict';

/**
 * 运行配置：环境变量、数据目录、页面模板。
 * 所有路径均相对于项目根目录解析，便于本地与容器内运行。
 */

const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || '/data';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const BRAND = process.env.BRAND_NAME || 'HTML 渲染器';
const MAX_BYTES = Number(process.env.MAX_PASTE_BYTES || 2 * 1024 * 1024);
const MAX_BODY = MAX_BYTES + 1024 * 1024;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 12000);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天
const URL_FETCH_ENABLED = process.env.URL_FETCH_ENABLED !== '0';

/**
 * 链接有效期档位。
 * - 单次：首次成功预览后立即失效；为避免长期占用空间，7 天内未访问也会过期。
 * - 其余档位从创建时开始计时；never 表示永久。
 * 过期记录由后台清扫任务删除，正文在最后一个引用释放后回收。
 */
const DAY_MS = 24 * 60 * 60 * 1000;
const LINK_EXPIRY = Object.freeze({
  once: Object.freeze({ ms: 7 * DAY_MS, singleUse: true }),
  '1d': Object.freeze({ ms: DAY_MS }),
  '7d': Object.freeze({ ms: 7 * DAY_MS }),
  '30d': Object.freeze({ ms: 30 * DAY_MS }),
  '1y': Object.freeze({ ms: 365 * DAY_MS }),
  never: Object.freeze({ ms: null }),
});
const DEFAULT_LINK_EXPIRY = String(process.env.LINK_DEFAULT_EXPIRY || '7d').trim();
if (!LINK_EXPIRY[DEFAULT_LINK_EXPIRY]) {
  throw new Error('LINK_DEFAULT_EXPIRY 必须是 once/1d/7d/30d/1y/never 之一');
}
const LINK_SWEEP_INTERVAL_MS = Number(process.env.LINK_SWEEP_INTERVAL_MS || 60_000);
if (!Number.isFinite(LINK_SWEEP_INTERVAL_MS) || LINK_SWEEP_INTERVAL_MS < 1000) {
  throw new Error('LINK_SWEEP_INTERVAL_MS 必须是大于等于 1000 的整数');
}
const LINK_UNLOCK_TTL_MS = 12 * 60 * 60 * 1000; // 密码解锁 Cookie 有效期 12 小时

if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('PORT 必须是 1-65535 的整数');
}
if (!Number.isInteger(MAX_BYTES) || MAX_BYTES < 1024) {
  throw new Error('MAX_PASTE_BYTES 必须是大于等于 1024 的整数');
}
if (!Number.isFinite(FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS < 100) {
  throw new Error('FETCH_TIMEOUT_MS 必须大于等于 100');
}

/** 解析逗号分隔的端口白名单，启动时校验，避免配置错误导致 SSRF 收口失效。 */
function parsePorts(raw) {
  const ports = new Set();
  for (const part of String(raw || '').split(',')) {
    const value = part.trim();
    if (!value) continue;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error('FETCH_ALLOWED_PORTS 必须是逗号分隔的 1-65535 端口');
    }
    ports.add(port);
  }
  if (!ports.size) throw new Error('FETCH_ALLOWED_PORTS 不能为空');
  return ports;
}

const FETCH_ALLOWED_PORTS = parsePorts(process.env.FETCH_ALLOWED_PORTS || '80,443');

/** 解析公开 Origin：只接受 http/https，且不能带路径、查询或片段。 */
function parseOrigin(raw, name) {
  const value = String(raw || '').trim();
  if (!value) return '';
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} 必须是完整 URL，例如 https://preview.example.com`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`${name} 仅支持 http/https`);
  }
  if (u.username || u.password) throw new Error(`${name} 不能包含用户名或密码`);
  if (u.search || u.hash) throw new Error(`${name} 不能包含查询参数或片段`);
  if (u.pathname && u.pathname !== '/') {
    throw new Error(`${name} 只能包含协议、域名和端口`);
  }
  return u.origin;
}

/**
 * 预览隔离：
 * - PREVIEW_ORIGIN 配置后，预览页只在独立域名下提供，主站 /p 只做跳转。
 * - 未配置时，预览页默认加 CSP sandbox（不透明源），避免同源读取账号 API。
 * - PREVIEW_SANDBOX=1/0 可显式覆盖；已有独立域名时默认关闭以保持页面兼容性。
 */
const PREVIEW_ORIGIN = parseOrigin(process.env.PREVIEW_ORIGIN, 'PREVIEW_ORIGIN');
const PREVIEW_HOST = PREVIEW_ORIGIN ? new URL(PREVIEW_ORIGIN).host.toLowerCase() : '';
const PREVIEW_SANDBOX_FLAG = String(process.env.PREVIEW_SANDBOX || '').trim().toLowerCase();
const PREVIEW_SANDBOX_DISABLED = ['0', 'false', 'no', 'off'].includes(PREVIEW_SANDBOX_FLAG);
const PREVIEW_SANDBOX = PREVIEW_SANDBOX_FLAG ? !PREVIEW_SANDBOX_DISABLED : !PREVIEW_ORIGIN;
if (!PREVIEW_ORIGIN && !PREVIEW_SANDBOX) {
  throw new Error(
    '未配置 PREVIEW_ORIGIN 时不能关闭 PREVIEW_SANDBOX：同源预览会把账号接口暴露给任意 HTML。' +
      '请配置 PREVIEW_ORIGIN，或移除 PREVIEW_SANDBOX=0。'
  );
}

const PASTE_DIR = path.join(DATA_DIR, 'pastes');
const BLOB_DIR = path.join(DATA_DIR, 'blobs');
const USER_DIR = path.join(DATA_DIR, 'users');
const INDEX_DIR = path.join(DATA_DIR, 'index');
const USER_PASTE_DIR = path.join(INDEX_DIR, 'user-pastes');
const USERS_INDEX = path.join(INDEX_DIR, 'users.json');
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

const templates = {
  index: fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'),
  edit: fs.readFileSync(path.join(PUBLIC_DIR, 'edit.html'), 'utf8'),
  login: fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'), 'utf8'),
  my: fs.readFileSync(path.join(PUBLIC_DIR, 'my.html'), 'utf8'),
  settings: fs.readFileSync(path.join(PUBLIC_DIR, 'settings.html'), 'utf8'),
  recover: fs.readFileSync(path.join(PUBLIC_DIR, 'recover.html'), 'utf8'),
  notFound: fs.readFileSync(path.join(PUBLIC_DIR, '404.html'), 'utf8'),
  lock: fs.readFileSync(path.join(PUBLIC_DIR, 'lock.html'), 'utf8'),
};
const avatarSvg = fs.readFileSync(path.join(PUBLIC_DIR, 'avatar.svg'), 'utf8');
const themeCss = fs.readFileSync(path.join(PUBLIC_DIR, 'theme.css'), 'utf8');
const themeJs = fs.readFileSync(path.join(PUBLIC_DIR, 'theme.js'), 'utf8');

/** 替换模板中的 {{UPPER_CASE}} 占位符；未知变量保持原样。 */
function render(tpl, vars) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
}

module.exports = {
  PORT,
  HOST,
  DATA_DIR,
  PUBLIC_DIR,
  BRAND,
  MAX_BYTES,
  MAX_BODY,
  TRUST_PROXY,
  FETCH_TIMEOUT_MS,
  FETCH_ALLOWED_PORTS,
  URL_FETCH_ENABLED,
  SESSION_TTL_MS,
  LINK_EXPIRY,
  DEFAULT_LINK_EXPIRY,
  LINK_SWEEP_INTERVAL_MS,
  LINK_UNLOCK_TTL_MS,
  PREVIEW_ORIGIN,
  PREVIEW_HOST,
  PREVIEW_SANDBOX,
  PASTE_DIR,
  BLOB_DIR,
  USER_DIR,
  INDEX_DIR,
  USER_PASTE_DIR,
  USERS_INDEX,
  SECRET_FILE,
  ALPHABET,
  templates,
  avatarSvg,
  themeCss,
  themeJs,
  render,
};
