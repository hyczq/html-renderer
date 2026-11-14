'use strict';

/**
 * 数据自检：校验 paste 记录、blob 是否存在、hash/大小是否一致，并列出孤儿 blob。
 *
 * 用法：
 *   DATA_DIR=./data npm run doctor
 *   DATA_DIR=./data npm run doctor -- --fix-orphans
 */

const fsp = require('node:fs/promises');
const path = require('node:path');
const config = require('../src/config');
const store = require('../src/store');

async function main() {
  const index = await store.loadIndex();
  const issues = [];
  if (index.failed) issues.push(`${index.failed} 条 paste 记录无法解析/加载`);
  if (index.expired) console.log(`[doctor] found ${index.expired} expired/consumed paste(s) (not deleted; server startup will clean)`);

  const pastes = store.allPastes();
  for (const paste of pastes) {
    const html = await store.pasteContent(paste);
    if (html === null) {
      issues.push(`${paste.code}: 缺少 blob ${paste.hash || '(legacy html)'}`);
      continue;
    }
    if (paste.hash) {
      const actual = store.sha256(html);
      if (actual !== paste.hash) {
        issues.push(`${paste.code}: blob hash 不匹配，记录 ${paste.hash}，实际 ${actual}`);
      }
    }
    const actualSize = Buffer.byteLength(html, 'utf8');
    if (paste.size !== undefined && Number(paste.size) !== actualSize) {
      issues.push(`${paste.code}: size 不匹配，记录 ${paste.size}，实际 ${actualSize}`);
    }
  }

  const orphans = await store.listOrphanBlobs();
  for (const file of orphans) issues.push(`孤儿 blob: ${file}`);

  if (process.argv.includes('--fix-orphans') && index.failed === 0) {
    for (const file of orphans) {
      await fsp.rm(path.join(config.BLOB_DIR, file), { force: true });
      console.log(`[doctor] removed orphan ${file}`);
    }
  } else if (process.argv.includes('--fix-orphans') && index.failed) {
    console.error('[doctor] 有记录加载失败，拒绝自动删除孤儿 blob；请先修复记录');
  }

  console.log(`[doctor] pastes=${pastes.length}, loaded=${index.loaded}, failed=${index.failed}, orphans=${orphans.length}`);
  if (issues.length) {
    for (const issue of issues) console.error('[doctor] ' + issue);
    process.exitCode = 1;
  } else {
    console.log('[doctor] OK');
  }
}

main().catch((e) => {
  console.error('[doctor] fatal', e);
  process.exit(1);
});
