'use strict';

/**
 * 远程 URL 抓取（防 SSRF）。
 *
 * 规则：仅 http/https；禁止回环、私网、链路本地、组播、IPv4 映射地址；
 * 每一跳重定向都重新校验；最多 5 跳、12 秒超时、2 MB 上限。
 */

const dns = require('node:dns').promises;
const net = require('node:net');
const { MAX_BYTES, FETCH_TIMEOUT_MS } = require('./config');

const PRIVATE_V4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
];

function ipv4ToInt(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function isPrivateV4(ip) {
  const n = ipv4ToInt(ip);
  if (n === null) return true;
  return PRIVATE_V4.some(([base, bits]) => {
    const b = ipv4ToInt(base);
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (n & mask) === (b & mask);
  });
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) return isPrivateV4(ip);
  if (!net.isIPv6(ip)) return true;
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::') return true;
  if (v.startsWith('::ffff:')) {
    const tail = v.slice(7);
    if (net.isIPv4(tail)) return isPrivateV4(tail);
  }
  if (v.startsWith('fc') || v.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(v)) return true;
  if (v.startsWith('ff')) return true;
  if (v.startsWith('2001:db8')) return true;
  return false;
}

const BLOCKED_HOST_SUFFIX = ['.local', '.internal', '.localhost', '.home.arpa'];

async function assertPublicHost(hostname) {
  const host = String(hostname || '')
    .toLowerCase()
    .replace(/\.$/, '');
  if (!host) throw new Error('URL 格式无效');
  if (host === 'localhost' || BLOCKED_HOST_SUFFIX.some((s) => host.endsWith(s))) {
    throw new Error('不允许访问该地址');
  }
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error('不允许访问该地址');
    return;
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
}

async function readLimited(res, max) {
  const chunks = [];
  let total = 0;
  if (!res.body) return '';
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > max) throw new Error('远程页面过大');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function fetchHtml(rawUrl) {
  let current;
  try {
    current = new URL(String(rawUrl).trim());
  } catch {
    throw new Error('Invalid URL: ' + rawUrl);
  }
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'http:' && current.protocol !== 'https:') {
      throw new Error('仅支持 http/https 链接');
    }
    if (current.username || current.password) throw new Error('URL 格式无效');
    await assertPublicHost(current.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
      });
    } catch (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('获取远程页面超时');
      throw new Error('获取远程页面失败');
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error('远程页面重定向失败');
      current = new URL(loc, current);
      try {
        await resp.body?.cancel();
      } catch {}
      continue;
    }
    if (!resp.ok) throw new Error('远程页面返回 ' + resp.status);

    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const allowed =
      !ct ||
      ct.includes('text/html') ||
      ct.includes('text/plain') ||
      ct.includes('application/xhtml') ||
      ct.includes('application/xml') ||
      ct.includes('text/xml');
    if (!allowed) {
      try {
        await resp.body?.cancel();
      } catch {}
      throw new Error('该链接不是 HTML 页面');
    }
    const len = Number(resp.headers.get('content-length') || 0);
    if (len && len > MAX_BYTES) throw new Error('远程页面过大');
    return await readLimited(resp, MAX_BYTES);
  }
  throw new Error('重定向次数过多');
}

module.exports = { fetchHtml, assertPublicHost, isPrivateIp };
