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
