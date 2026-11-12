'use strict';

/**
 * 远程 URL 抓取（防 SSRF）。
 *
 * 关键点：
 * - DNS 只解析一次，校验全部 A/AAAA，然后把连接固定到已校验的 IP，
 *   避免“校验时公网、连接时内网”的 DNS 重绑定。
 * - IPv4/IPv6 私网、链路本地、元数据、组播、NAT64、6to4、Teredo 等全部拦截。
 * - 只允许 http/https 和白名单端口；每一跳重定向都重新解析、校验、固定 IP。
 * - 支持 gzip/deflate/br 解压，并按解压后大小限制请求体。
 */

const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const {
  MAX_BYTES,
  FETCH_TIMEOUT_MS,
  FETCH_ALLOWED_PORTS,
} = require('./config');

const MAX_REDIRECTS = 5;
const MAX_COMPRESSED_BYTES = Math.max(MAX_BYTES * 4, 8 * 1024 * 1024);

const BLOCKED_HOST_SUFFIX = ['.local', '.internal', '.localhost', '.home.arpa', '.lan'];

function ipv4ToInt(ip) {
  const p = String(ip).split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function intToIpv4(n) {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
}

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, bits]) => {
  const b = ipv4ToInt(base);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return { base: b & mask, mask };
});

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return PRIVATE_V4.some(({ base, mask }) => (n & mask) === base);
}

function parseIpv6(ip) {
  let s = String(ip || '').toLowerCase();
  if (!s || s.includes('%')) return null;

  // 把末尾的 IPv4 字面量换成两个十六进制 group：::ffff:127.0.0.1 -> ::ffff:7f00:1
  if (s.includes('.')) {
    const idx = s.lastIndexOf(':');
    if (idx < 0) return null;
    const v4 = ipv4ToInt(s.slice(idx + 1));
    if (v4 === null) return null;
    s =
      s.slice(0, idx + 1) +
      ((v4 >>> 16) & 0xffff).toString(16) +
      ':' +
      (v4 & 0xffff).toString(16);
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;

  const groups = [
    ...left,
    ...new Array(8 - left.length - right.length).fill('0'),
    ...right,
  ];
  let value = 0n;
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    value = (value << 16n) | BigInt(parseInt(group, 16));
  }
  return value;
}

const IPV6_BLOCKED = [
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['100::', 64], // discard-only
  ['2001::', 32], // Teredo
  ['2001:2::', 48], // benchmarking
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4
  ['3fff::', 20], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
].map(([prefix, bits]) => ({ base: parseIpv6(prefix), bits }));

function inIpv6Range(value, base, bits) {
  const shift = 128n - BigInt(bits);
  return value >> shift === base >> shift;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (!net.isIPv6(ip)) return true;

  const value = parseIpv6(ip);
  if (value === null) return true;
  if (value === 0n || value === 1n) return true; // :: / ::1

  // IPv4-mapped IPv6：::ffff:a.b.c.d
  if (value >> 32n === 0xffffn) {
    return isPrivateV4(intToIpv4(Number(value & 0xffffffffn)));
  }

  // IPv4-compatible /96（已废弃），整体拦截
  if (value >> 32n === 0n) return true;

  return IPV6_BLOCKED.some(({ base, bits }) => inIpv6Range(value, base, bits));
}

function normalizeHostname(raw) {
  let host = String(raw || '').trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  host = host.replace(/\.$/, '');
  return host;
}

/** 解析并校验主机，返回全部已校验的地址；调用方必须使用这些地址连接。 */
async function resolvePublicHost(hostname) {
  const host = normalizeHostname(hostname);
  if (!host) throw new Error('URL 格式无效');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIX.some((s) => host.endsWith(s))) {
    throw new Error('不允许访问该地址');
  }

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问该地址');
    return [{ address: host, family: net.isIPv4(host) ? 4 : 6 }];
  }

  let records;
  try {
    records = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('无法解析该域名');
  }
  if (!records.length) throw new Error('无法解析该域名');
  for (const rec of records) {
    if (isPrivateIp(rec.address)) throw new Error('不允许访问该地址');
  }
  return records;
}

/** 兼容旧调用：只校验，不返回地址。 */
async function assertPublicHost(hostname) {
  await resolvePublicHost(hostname);
}

function isAllowedPort(url) {
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  return Number.isInteger(port) && FETCH_ALLOWED_PORTS.has(port);
}

function readLimited(res, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    res.on('data', (chunk) => {
      total += chunk.length;
      if (total > max) {
        res.destroy();
        reject(new Error('远程页面过大'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('error', reject);
    res.on('aborted', () => reject(new Error('远程页面读取中断')));
  });
}

function decodeContentEncoding(buf, encoding) {
  const enc = String(encoding || '').trim().toLowerCase();
  if (!enc || enc === 'identity') return buf;
  try {
    if (enc === 'gzip' || enc === 'x-gzip') {
      return zlib.gunzipSync(buf, { maxOutputLength: MAX_BYTES + 1 });
    }
    if (enc === 'deflate') {
      return zlib.inflateSync(buf, { maxOutputLength: MAX_BYTES + 1 });
    }
    if (enc === 'br') {
      return zlib.brotliDecompressSync(buf, { maxOutputLength: MAX_BYTES + 1 });
    }
  } catch (e) {
    if (e && e.code === 'ERR_BUFFER_TOO_LARGE') throw new Error('远程页面过大');
    throw new Error('远程页面解压失败');
  }
  throw new Error('不支持的远程压缩格式');
}

function decodeHtmlBody(buf, contentType) {
  let charset = '';
  const m = /charset\s*=\s*"?([^";\s]+)/i.exec(String(contentType || ''));
  if (m) charset = m[1];
  if (!charset) {
    const head = buf.subarray(0, 4096).toString('latin1');
    const meta = /<meta[^>]+charset\s*=\s*["']?\s*([^"'\s/>]+)/i.exec(head);
    if (meta) charset = meta[1];
  }
  if (!charset) return buf.toString('utf8');
  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return buf.toString('utf8');
  }
}

function requestOnce(url, address, timeoutMs) {
  return new Promise((resolve, reject) => {
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const hostname = normalizeHostname(url.hostname);
    const port = Number(url.port || (isHttps ? 443 : 80));
    const options = {
      method: 'GET',
      host: address,
      port,
      path: (url.pathname || '/') + url.search,
      headers: {
        Host: url.host,
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'close',
      },
      timeout: timeoutMs,
    };
    if (isHttps) {
      options.servername = hostname;
      options.rejectUnauthorized = true;
    }

    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };

    const req = lib.request(options, (res) => {
      const status = res.statusCode || 0;
      const headers = res.headers;
      if (status >= 300 && status < 400) {
        res.resume();
        return finish(resolve, {
          status,
          headers,
          location: headers.location || '',
          body: null,
        });
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return finish(resolve, { status, headers, body: null });
      }

      const contentType = String(headers['content-type'] || '').toLowerCase();
      const allowed =
        !contentType ||
        contentType.includes('text/html') ||
        contentType.includes('text/plain') ||
        contentType.includes('application/xhtml') ||
        contentType.includes('application/xml') ||
        contentType.includes('text/xml');
      if (!allowed) {
        res.destroy();
        return finish(reject, new Error('该链接不是 HTML 页面'));
      }

      const declared = Number(headers['content-length'] || 0);
      if (declared && declared > MAX_COMPRESSED_BYTES) {
        res.destroy();
        return finish(reject, new Error('远程页面过大'));
      }

      readLimited(res, MAX_COMPRESSED_BYTES)
        .then((raw) => decodeContentEncoding(raw, headers['content-encoding']))
        .then((body) => {
          if (body.length > MAX_BYTES) throw new Error('远程页面过大');
          return finish(resolve, { status, headers, body });
        })
        .catch((err) => finish(reject, err));
    });

    req.on('timeout', () => req.destroy(new Error('远程页面超时')));
    req.on('error', (err) => {
      const msg = err && err.message === '远程页面超时' ? '获取远程页面超时' : '获取远程页面失败';
      finish(reject, new Error(msg));
    });
    req.end();
  });
}

async function requestWithFallback(url, records) {
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let lastError = null;
  for (const rec of records) {
    const remaining = Math.max(500, deadline - Date.now());
    try {
      return await requestOnce(url, rec.address, remaining);
    } catch (err) {
      lastError = err;
      if (Date.now() >= deadline) break;
    }
  }
  throw lastError || new Error('获取远程页面失败');
}

async function fetchHtml(rawUrl) {
  let current;
  try {
    current = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('Invalid URL: ' + rawUrl);
  }

  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('仅支持 http/https 链接');
    }
    if (current.username || current.password) throw new Error('URL 格式无效');
    if (!isAllowedPort(current)) throw new Error('该端口不允许访问');

    const records = await resolvePublicHost(current.hostname);
    const resp = await requestWithFallback(current, records);

    if (resp.status >= 300 && resp.status < 400) {
      if (!resp.location) throw new Error('远程页面重定向失败');
      current = new URL(resp.location, current);
      continue;
    }
    if (resp.status < 200 || resp.status >= 300) {
      throw new Error('远程页面返回 ' + resp.status);
    }
    return decodeHtmlBody(resp.body, resp.headers['content-type']);
  }
  throw new Error('重定向次数过多');
}

module.exports = {
  fetchHtml,
  assertPublicHost,
  resolvePublicHost,
  isPrivateIp,
  isAllowedPort,
  parseIpv6,
  normalizeHostname,
};
