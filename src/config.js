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
};
const avatarSvg = fs.readFileSync(path.join(PUBLIC_DIR, 'avatar.svg'), 'utf8');

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
  SESSION_TTL_MS,
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
  render,
};
