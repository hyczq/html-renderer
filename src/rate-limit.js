'use strict';

/**
 * 进程内滑动窗口限流（按 操作名 + 客户端 IP）。
 * 单实例部署足够；多实例需换成共享存储（如 Redis）。
 */

const { clientIp } = require('./http');

const buckets = new Map();

function rateLimited(req, name, limit, windowMs) {
  const key = name + ':' + clientIp(req);
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return true;
  }
  arr.push(now);
  buckets.set(key, arr);
  // 简单清理，避免长期运行后 Map 无限增长
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
    }
  }
  return false;
}

module.exports = { rateLimited };
