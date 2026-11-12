'use strict';

/**
 * 端到端冒烟测试：启动真实 HTTP 服务，覆盖主要 API 流程。
 * 运行：npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let i = 0; i < 120; i++) {
    try {
      const res = await fetch(baseUrl + '/healthz');
      if (res.ok && (await res.text()) === 'ok') return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('server did not become healthy');
}

async function stopServer(child) {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rawRequest(method, url, headers = {}, body) {
  return new Promise((resolve, reject) => {
    if (body !== undefined && headers['Content-Length'] === undefined) {
      headers = { ...headers, 'Content-Length': Buffer.byteLength(body) };
    }
    const req = http.request(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) })
      );
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error('request timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function rawGet(url, headers = {}) {
  return rawRequest('GET', url, headers);
}

function createClient(baseUrl) {
  const jar = new Map();

  function cookieHeader() {
    return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  function absorbCookies(res) {
    const list =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : (res.headers.get('set-cookie') || '').split(/,(?=[^;]+=)/);
    for (const item of list) {
      if (!item) continue;
      const pair = item.split(';')[0].trim();
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
  }

  async function request(method, pathname, body, raw = false) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (jar.size) headers.cookie = cookieHeader();
    const res = await fetch(baseUrl + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
    });
    absorbCookies(res);
    if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, text, json, headers: res.headers };
  }

  return {
    get: (p) => request('GET', p, undefined, true),
    post: (p, body) => request('POST', p, body),
    json: (p) => request('GET', p),
    cookieHeader,
  };
}

test('HTML 渲染器 API 冒烟测试', async (t) => {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-test-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      BRAND_NAME: '测试渲染器',
      TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);
  const client = createClient(baseUrl);
  const anon = createClient(baseUrl);

  await t.test('健康检查与首页', async () => {
    const health = await client.get('/healthz');
    assert.equal(health.status, 200);
    assert.equal(health.text, 'ok');

    const home = await client.get('/');
    assert.equal(home.status, 200);
    assert.match(home.text, /测试渲染器/);
    assert.match(home.text, /viewport-fit=cover/);
    assert.match(home.text, /@media\(max-width:600px\)/);

    for (const page of ['/login', '/my', '/settings', '/recover']) {
      const res = await client.get(page);
      assert.equal(res.status, 200, page);
      assert.match(res.text, /测试渲染器/, page);
      assert.match(res.text, /href="\/theme\.css"/, page);
      assert.match(res.text, /src="\/theme\.js"/, page);
    }
    // 首页与我的页面共用同一套页面骨架，避免布局再次分叉。
    for (const page of ['/', '/my', '/settings', '/recover']) {
      const res = await client.get(page);
      assert.match(res.text, /class="page"/, page);
      assert.match(res.text, /class="topbar"/, page);
      assert.match(res.text, /class="brand-name"/, page);
    }
    // 账号安全页使用侧边导航 + 单面板切换，而不是把所有表单堆在一屏。
    const settingsPage = await client.get('/settings');
    assert.match(settingsPage.text, /class="card security-nav"/);
    assert.match(settingsPage.text, /id="panel-password"/);
    assert.match(settingsPage.text, /id="panel-danger"[^>]*hidden/);

    // 删除确认使用站内样式化弹窗，而不是无法定制样式的原生 confirm。
    const myPage = await client.get('/my');
    assert.match(myPage.text, /id="delModal"/);
    assert.match(myPage.text, /btn-danger-solid/);
    assert.equal(myPage.text.includes('confirm('), false, 'my page should not use native confirm');
    const themeCss = await client.get('/theme.css');
    assert.equal(themeCss.status, 200);
    assert.match(String(themeCss.headers.get('content-type')), /text\/css/, 'theme.css content type');
    assert.match(themeCss.text, /\.topbar/);
    assert.match(themeCss.text, /\[data-theme="dark"\]/);
    assert.match(themeCss.text, /\.modal-danger/);
    assert.match(themeCss.text, /\.btn-danger-solid/);
    const themeJs = await client.get('/theme.js');
    assert.equal(themeJs.status, 200);
    assert.match(String(themeJs.headers.get('content-type')), /javascript/, 'theme.js content type');
    assert.match(themeJs.text, /localStorage\.setItem\("theme"/);
    const avatar = await client.get('/avatar.svg');
    assert.equal(avatar.status, 200);
    assert.match(avatar.text, /<svg/);
  });

  await t.test('文本响应支持 gzip 压缩', async () => {
    const compressed = await rawGet(baseUrl + '/', { 'Accept-Encoding': 'gzip' });
    assert.equal(compressed.status, 200);
    assert.equal(compressed.headers['content-encoding'], 'gzip');
    assert.match(String(compressed.headers.vary || ''), /Accept-Encoding/);
    const text = zlib.gunzipSync(compressed.body).toString('utf8');
    assert.match(text, /测试渲染器/);

    const plain = await rawGet(baseUrl + '/', { 'Accept-Encoding': 'identity' });
    assert.equal(plain.status, 200);
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.match(plain.body.toString('utf8'), /测试渲染器/);
    assert.ok(compressed.body.length < plain.body.length);

    const disabled = await rawGet(baseUrl + '/', { 'Accept-Encoding': 'gzip;q=0' });
    assert.equal(disabled.headers['content-encoding'], undefined);
  });

  const pageA =
    '<!doctype html><html><head><title>冒烟测试页面</title></head><body><h1>Hello</h1></body></html>';

  await t.test('匿名生成、预览与编辑读取', async () => {
    const gen = await anon.post('/generate', { type: 'code', code: pageA });
    assert.equal(gen.json.success, true, gen.text);
    assert.match(gen.json.code, /^[A-Za-z0-9]{8}$/);
    assert.match(gen.json.editKey, /^[A-Za-z0-9]{16}$/);
    assert.equal(gen.json.name, '冒烟测试页面');
    assert.equal(gen.json.reused, false);

    const preview = await anon.get('/p/' + gen.json.code);
    assert.equal(preview.status, 200);
    assert.equal(preview.text, pageA);
    const previewCsp = preview.headers.get('content-security-policy') || '';
    assert.match(previewCsp, /(?:^|;)\s*sandbox\b/);
    assert.doesNotMatch(previewCsp, /allow-same-origin/);
    assert.equal(preview.headers.get('set-cookie'), null);

    const etag = preview.headers.get('etag');
    assert.ok(etag, '预览响应应带 ETag');
    const notModified = await rawGet(baseUrl + '/p/' + gen.json.code, {
      'If-None-Match': etag,
    });
    assert.equal(notModified.status, 304);

    const editPage = await anon.get(`/edit/${gen.json.code}?key=${gen.json.editKey}`);
    assert.equal(editPage.status, 200);
    assert.match(editPage.text, new RegExp(gen.json.code));

    const wrong = await anon.json('/api/get?code=' + gen.json.code + '&key=wrong');
    assert.equal(wrong.json.success, false);

    const got = await anon.json(
      `/api/get?code=${gen.json.code}&key=${encodeURIComponent(gen.json.editKey)}`
    );
    assert.equal(got.json.success, true);
    assert.equal(got.json.html, pageA);

    const gotHeader = await rawGet(`${baseUrl}/api/get?code=${gen.json.code}`, {
      'X-Edit-Key': gen.json.editKey,
    });
    const gotHeaderJson = JSON.parse(gotHeader.body.toString('utf8'));
    assert.equal(gotHeaderJson.success, true);
    assert.equal(gotHeaderJson.html, pageA);
  });

  await t.test('同一匿名浏览器内容去重', async () => {
    const again = await anon.post('/generate', { type: 'code', code: pageA });
    assert.equal(again.json.success, true, again.text);
    assert.equal(again.json.reused, true);
    assert.match(again.json.code, /^[A-Za-z0-9]{8}$/);
  });

  await t.test('保存修改后预览更新', async () => {
    const gen = await anon.post('/generate', { type: 'code', code: pageA });
    const pageB = pageA.replace('Hello', 'Hello v2');
    const saved = await anon.post('/api/save', {
      code: gen.json.code,
      key: gen.json.editKey,
      html: pageB,
      name: '改名后',
    });
    assert.equal(saved.json.success, true, saved.text);

    const preview = await anon.get('/p/' + gen.json.code);
    assert.equal(preview.text, pageB);
  });

  const username = 'tester_' + Date.now().toString(36);
  const password = 'test-pass-123';

  await t.test('注册、登录态与我的页面', async () => {
    const reg = await client.post('/api/register', { username, password });
    assert.equal(reg.json.success, true, reg.text);
    assert.equal(reg.json.user.username, username);

    const me = await client.json('/api/me');
    assert.equal(me.json.success, true);
    assert.equal(me.json.user.username, username);

    const pageC = '<html><head><title>登录用户页面</title></head><body>C</body></html>';
    const gen = await client.post('/generate', { type: 'code', code: pageC });
    assert.equal(gen.json.success, true, gen.text);

    const my = await client.json('/api/my');
    assert.equal(my.json.success, true);
    assert.equal(my.json.total, 1);
    assert.equal(my.json.items[0].code, gen.json.code);

    const renamed = await client.post('/api/rename', { code: gen.json.code, name: '重命名页面' });
    assert.equal(renamed.json.success, true, renamed.text);

    const my2 = await client.json('/api/my');
    assert.equal(my2.json.items[0].name, '重命名页面');
  });

  await t.test('并发生成相同内容只创建一个链接', async () => {
    const pageD = '<html><head><title>并发测试</title></head><body>D</body></html>';
    const results = await Promise.all(
      Array.from({ length: 12 }, () => client.post('/generate', { type: 'code', code: pageD }))
    );
    assert.ok(results.every((r) => r.json && r.json.success));
    const codes = new Set(results.map((r) => r.json.code));
    assert.equal(codes.size, 1);
    assert.equal(results.filter((r) => r.json.reused === false).length, 1);
  });

  await t.test('退出与重新登录', async () => {    const out = await client.post('/api/logout', {});
    assert.equal(out.json.success, true);

    const me = await client.json('/api/me');
    assert.equal(me.json.success, false);
    assert.equal(me.json.needLogin, true);

    const login = await client.post('/api/login', { username, password });
    assert.equal(login.json.success, true, login.text);
  });

  await t.test('删除自己的页面', async () => {
    const my = await client.json('/api/my');
    const code = my.json.items[0].code;
    const del = await client.post('/api/delete', { code });
    assert.equal(del.json.success, true, del.text);

    const preview = await client.get('/p/' + code);
    assert.equal(preview.status, 404);
  });

  await t.test('URL 抓取拦截内网地址（SSRF）', async () => {
    const res = await anon.post('/generate', {
      type: 'url',
      url: 'http://127.0.0.1/healthz',
    });
    assert.equal(res.json.success, false);
    assert.match(res.json.error, /不允许访问该地址/);
  });

  await t.test('未知路径返回样式化 404', async () => {
    const res = await client.get('/nope');
    assert.equal(res.status, 404);
    assert.match(String(res.headers.get('content-type')), /text\/html/);
    assert.match(res.text, /class="card error-card"/);
    assert.match(res.text, /页面不存在或已过期/);
    assert.match(res.text, /href="\/theme\.css"/);

    const missing = await client.get('/p/ZZZZZZZZ');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /class="card error-card"/);
    assert.match(missing.text, /页面不存在或已过期/);

    const api = await client.json('/api/nope');
    assert.equal(api.status, 404);
    assert.equal(api.json.success, false);
  });

  assert.equal(stderr, '', '服务不应向 stderr 输出错误');
});

test('预览独立域名隔离', async (t) => {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-preview-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const previewHost = 'preview.example.test';
  const previewOrigin = `https://${previewHost}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TRUST_PROXY: '0',
      PREVIEW_ORIGIN: previewOrigin,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d;
  });

  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);
  const client = createClient(baseUrl);
  const username = 'preview_' + Date.now().toString(36);
  const reg = await client.post('/api/register', { username, password: 'test-pass-123' });
  assert.equal(reg.json.success, true, reg.text);

  const page =
    '<!doctype html><html><head><title>隔离测试</title></head><body>preview</body></html>';
  const gen = await client.post('/generate', { type: 'code', code: page });
  assert.equal(gen.json.success, true, gen.text);
  const code = gen.json.code;

  await t.test('主站 /p 只跳转，不再同源渲染', async () => {
    const res = await client.get('/p/' + code);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), `${previewOrigin}/p/${code}`);
  });

  await t.test('预览域只读渲染，不写 Cookie', async () => {
    const res = await rawGet(`${baseUrl}/p/${code}`, { Host: previewHost });
    assert.equal(res.status, 200);
    assert.equal(res.body.toString('utf8'), page);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.doesNotMatch(String(res.headers['content-security-policy'] || ''), /allow-same-origin/);
  });

  await t.test('预览域无法访问账号 API', async () => {
    const res = await rawGet(`${baseUrl}/api/my`, {
      Host: previewHost,
      Cookie: client.cookieHeader(),
    });
    assert.equal(res.status, 404);
    assert.equal(res.headers['set-cookie'], undefined);

    const home = await rawGet(`${baseUrl}/`, { Host: previewHost });
    assert.equal(home.status, 404);

    const post = await rawRequest(
      'POST',
      `${baseUrl}/generate`,
      { Host: previewHost, 'Content-Type': 'application/json' },
      JSON.stringify({ type: 'code', code: '<html></html>' })
    );
    assert.equal(post.status, 404);
  });

  await t.test('预览域链接失效时返回样式化 404', async () => {
    const res = await rawGet(`${baseUrl}/p/ZZZZZZZZ`, { Host: previewHost });
    assert.equal(res.status, 404);
    assert.match(String(res.headers['content-type']), /text\/html/);
    assert.match(res.body.toString('utf8'), /class="card error-card"/);
    assert.match(res.body.toString('utf8'), /页面不存在或已过期/);
    assert.equal(res.headers['set-cookie'], undefined);

    const css = await rawGet(`${baseUrl}/theme.css`, { Host: previewHost });
    assert.equal(css.status, 200);
    assert.match(String(css.headers['content-type']), /text\/css/);
    assert.equal(css.headers['set-cookie'], undefined);
  });

  await t.test('主站账号与页面仍正常，链接指向预览域', async () => {
    const me = await client.json('/api/me');
    assert.equal(me.json.success, true);
    assert.equal(me.json.user.username, username);

    const home = await client.get('/');
    assert.ok(home.text.includes(`content="${previewOrigin}"`), '首页应注入预览域');

    const edit = await client.get(`/edit/${code}?key=${encodeURIComponent(gen.json.editKey)}`);
    assert.ok(edit.text.includes(`${previewOrigin}/p/${code}`), '编辑页预览链接应指向预览域');
  });

  assert.equal(stderr, '', '服务不应向 stderr 输出错误');
});

test('旧版内嵌 HTML 数据自动迁移', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-migrate-'));
  const legacyHtml =
    '<!doctype html><html><head><title>旧版页面</title></head><body>legacy</body></html>';
  await fs.mkdir(path.join(dataDir, 'pastes'), { recursive: true });
  await fs.writeFile(
    path.join(dataDir, 'pastes', 'LEGACY01.json'),
    JSON.stringify({ code: 'LEGACY01', html: legacyHtml, createdAt: new Date().toISOString() })
  );

  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);
  const client = createClient(baseUrl);

  const preview = await client.get('/p/LEGACY01');
  assert.equal(preview.status, 200);
  assert.equal(preview.text, legacyHtml);

  const record = JSON.parse(await fs.readFile(path.join(dataDir, 'pastes', 'LEGACY01.json'), 'utf8'));
  assert.equal(record.html, undefined);
  assert.match(record.hash, /^[a-f0-9]{64}$/);
  assert.equal(record.name, '旧版页面');
  assert.match(record.editKey, /^[A-Za-z0-9]{16}$/);

  const blob = await fs.readFile(path.join(dataDir, 'blobs', record.hash + '.html'), 'utf8');
  assert.equal(blob, legacyHtml);

  const got = await client.json(`/api/get?code=LEGACY01&key=${record.editKey}`);
  assert.equal(got.json.success, true);
  assert.equal(got.json.html, legacyHtml);
});

test('未配置预览域名时禁止关闭 CSP sandbox', () => {
  const result = spawnSync(process.execPath, ['-e', "require('./src/config')"], {
    cwd: ROOT,
    env: { ...process.env, PREVIEW_ORIGIN: '', PREVIEW_SANDBOX: '0' },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PREVIEW_SANDBOX/);
});

test('HTTPS 代理下会话 Cookie 使用 __Host- 前缀', async (t) => {
  const port = await freePort();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-cookie-'));
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl);

  const body = JSON.stringify({
    username: 'host_' + Date.now().toString(36),
    password: 'test-pass-123',
  });
  const reg = await rawRequest(
    'POST',
    baseUrl + '/api/register',
    { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https' },
    body
  );
  assert.equal(reg.status, 200);
  assert.equal(JSON.parse(reg.body.toString('utf8')).success, true);
  const setCookies = reg.headers['set-cookie'] || [];
  assert.ok(
    setCookies.some((c) => c.startsWith('__Host-hr_session=')),
    'HTTPS 下应设置 __Host- 会话 Cookie'
  );

  const logout = await rawRequest('POST', baseUrl + '/api/logout', {
    'X-Forwarded-Proto': 'https',
  });
  const cleared = logout.headers['set-cookie'] || [];
  assert.ok(cleared.some((c) => c.startsWith('hr_session=')));
  assert.ok(cleared.some((c) => c.startsWith('__Host-hr_session=')));
});

test('SSRF：IPv6 私网覆盖与端口白名单', async () => {
  const { isPrivateIp, isAllowedPort, fetchHtml, resolvePublicHost } = require(
    path.join(ROOT, 'src/fetch-html.js')
  );

  const blocked = [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    '::1',
    '::',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '2002:7f00:1::',
    '64:ff9b::7f00:1',
    'fec0::1',
    'fe80::1',
    'fc00::1',
    'ff02::1',
    '2001:db8::1',
  ];
  for (const ip of blocked) assert.equal(isPrivateIp(ip), true, ip);

  for (const ip of ['8.8.8.8', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }

  assert.equal(isAllowedPort(new URL('http://example.com/')), true);
  assert.equal(isAllowedPort(new URL('https://example.com:443/')), true);
  assert.equal(isAllowedPort(new URL('http://example.com:22/')), false);

  await assert.rejects(resolvePublicHost('localhost'), /不允许访问该地址/);
  await assert.rejects(resolvePublicHost('127.0.0.1'), /不允许访问该地址/);
  await assert.rejects(fetchHtml('http://example.com:22/'), /端口不允许访问/);
  await assert.rejects(fetchHtml('ftp://example.com/'), /仅支持 http\/https/);
});

test('重启后从 pastes/ 重建索引', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-restart-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    DATA_DIR: dataDir,
    TRUST_PROXY: '0',
  };
  const start = () =>
    spawn(process.execPath, [path.join(ROOT, 'server.js')], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  let child = start();
  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl);

  const username = 'restart_' + Date.now().toString(36);
  const password = 'test-pass-123';
  const client = createClient(baseUrl);
  const reg = await client.post('/api/register', { username, password });
  assert.equal(reg.json.success, true, reg.text);
  const page = '<html><head><title>重启测试</title></head><body>restart</body></html>';
  const gen = await client.post('/generate', { type: 'code', code: page });
  assert.equal(gen.json.success, true, gen.text);
  const code = gen.json.code;

  await stopServer(child);
  child = start();
  await waitForHealth(baseUrl);

  const client2 = createClient(baseUrl);
  const login = await client2.post('/api/login', { username, password });
  assert.equal(login.json.success, true, login.text);
  const my = await client2.json('/api/my');
  assert.equal(my.json.success, true);
  assert.equal(my.json.total, 1);
  assert.equal(my.json.items[0].code, code);
  const preview = await client2.get('/p/' + code);
  assert.equal(preview.status, 200);
  assert.equal(preview.text, page);
});

test('blob 引用计数：删除一个引用不删正文，最后一个引用才回收', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-gc-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const page = '<html><head><title>GC 测试</title></head><body>shared</body></html>';
  const hash = crypto.createHash('sha256').update(page, 'utf8').digest('hex');
  const blobPath = path.join(dataDir, 'blobs', hash + '.html');
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TRUST_PROXY: '0',
      BLOB_GC_GRACE_MS: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl);

  const a = createClient(baseUrl);
  const b = createClient(baseUrl);
  const regA = await a.post('/api/register', {
    username: 'gc_a_' + Date.now().toString(36),
    password: 'test-pass-123',
  });
  const regB = await b.post('/api/register', {
    username: 'gc_b_' + Date.now().toString(36),
    password: 'test-pass-123',
  });
  assert.equal(regA.json.success, true, regA.text);
  assert.equal(regB.json.success, true, regB.text);

  const genA = await a.post('/generate', { type: 'code', code: page });
  const genB = await b.post('/generate', { type: 'code', code: page });
  assert.equal(genA.json.success, true, genA.text);
  assert.equal(genB.json.success, true, genB.text);
  assert.notEqual(genA.json.code, genB.json.code);
  assert.equal(await fs.readFile(blobPath, 'utf8'), page);

  const delA = await a.post('/api/delete', { code: genA.json.code });
  assert.equal(delA.json.success, true, delA.text);
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await fs.readFile(blobPath, 'utf8'), page, '仍有引用时不应删除 blob');

  const delB = await b.post('/api/delete', { code: genB.json.code });
  assert.equal(delB.json.success, true, delB.text);
  let gone = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fs.access(blobPath);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      gone = true;
      break;
    }
  }
  assert.equal(gone, true, '最后一个引用删除后应回收 blob');
});

test('账号安全：改密、退出所有设备、恢复码与注销', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'html-renderer-account-'));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      TRUST_PROXY: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    await stopServer(child);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await waitForHealth(baseUrl);

  const username = 'acct_' + Date.now().toString(36);
  const password = 'original-pass-123';
  const newPassword = 'rotated-pass-456';
  const recoveredPassword = 'recovered-pass-789';
  const a = createClient(baseUrl);
  const b = createClient(baseUrl);

  const reg = await a.post('/api/register', { username, password });
  assert.equal(reg.json.success, true, reg.text);
  const loginB = await b.post('/api/login', { username, password });
  assert.equal(loginB.json.success, true, loginB.text);

  await t.test('修改密码后旧会话失效、当前会话保持', async () => {
    const changed = await a.post('/api/password', {
      oldPassword: password,
      newPassword,
    });
    assert.equal(changed.json.success, true, changed.text);

    const meA = await a.json('/api/me');
    assert.equal(meA.json.success, true, '当前设备应获得新会话');
    const meB = await b.json('/api/me');
    assert.equal(meB.json.success, false);
    assert.equal(meB.json.needLogin, true, '其他设备旧会话应失效');

    const oldLogin = await b.post('/api/login', { username, password });
    assert.equal(oldLogin.json.success, false);
    const newLogin = await b.post('/api/login', { username, password: newPassword });
    assert.equal(newLogin.json.success, true, newLogin.text);
  });

  await t.test('退出所有设备会吊销全部会话', async () => {
    const out = await a.post('/api/logout-all', {});
    assert.equal(out.json.success, true, out.text);
    const meA = await a.json('/api/me');
    assert.equal(meA.json.success, false);
    const meB = await b.json('/api/me');
    assert.equal(meB.json.success, false);
  });

  await t.test('恢复码可重置密码且只能使用一次', async () => {
    const login = await a.post('/api/login', { username, password: newPassword });
    assert.equal(login.json.success, true, login.text);
    const codes = await a.post('/api/recovery-codes', { password: newPassword });
    assert.equal(codes.json.success, true, codes.text);
    assert.equal(codes.json.codes.length, 10);
    assert.match(codes.json.codes[0], /^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/);

    const logout = await a.post('/api/logout', {});
    assert.equal(logout.json.success, true);
    const recover = await a.post('/api/recover', {
      username,
      code: codes.json.codes[0],
      newPassword: recoveredPassword,
    });
    assert.equal(recover.json.success, true, recover.text);
    const me = await a.json('/api/me');
    assert.equal(me.json.success, true);

    await a.post('/api/logout', {});
    const reuse = await a.post('/api/recover', {
      username,
      code: codes.json.codes[0],
      newPassword: 'another-pass-000',
    });
    assert.equal(reuse.json.success, false, '恢复码只能使用一次');

    const oldLogin = await a.post('/api/login', { username, password: newPassword });
    assert.equal(oldLogin.json.success, false);
    const recoveredLogin = await a.post('/api/login', {
      username,
      password: recoveredPassword,
    });
    assert.equal(recoveredLogin.json.success, true, recoveredLogin.text);
  });

  await t.test('注销账号会删除页面并释放用户名', async () => {
    const page = '<html><head><title>注销测试</title></head><body>delete me</body></html>';
    const gen = await a.post('/generate', { type: 'code', code: page });
    assert.equal(gen.json.success, true, gen.text);
    const code = gen.json.code;

    const deleted = await a.post('/api/account/delete', {
      password: recoveredPassword,
      confirmUsername: username,
    });
    assert.equal(deleted.json.success, true, deleted.text);

    const me = await a.json('/api/me');
    assert.equal(me.json.success, false);
    const preview = await a.get('/p/' + code);
    assert.equal(preview.status, 404);
    const login = await a.post('/api/login', { username, password: recoveredPassword });
    assert.equal(login.json.success, false);

    const again = await a.post('/api/register', {
      username,
      password: recoveredPassword,
    });
    assert.equal(again.json.success, true, again.text);
  });
});
