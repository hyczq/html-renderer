'use strict';

/**
 * 端到端冒烟测试：启动真实 HTTP 服务，覆盖主要 API 流程。
 * 运行：npm test
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
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

    for (const page of ['/login', '/my']) {
      const res = await client.get(page);
      assert.equal(res.status, 200, page);
      assert.match(res.text, /测试渲染器/, page);
    }
    const avatar = await client.get('/avatar.svg');
    assert.equal(avatar.status, 200);
    assert.match(avatar.text, /<svg/);
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
      url: `http://127.0.0.1:${port}/healthz`,
    });
    assert.equal(res.json.success, false);
    assert.match(res.json.error, /不允许访问该地址/);
  });

  await t.test('未知路径返回 404', async () => {
    const res = await client.get('/nope');
    assert.equal(res.status, 404);
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
