'use strict';

/**
 * 管理员重置密码（无恢复码、无法登录时的最后手段）。
 *
 * 用法：
 *   DATA_DIR=./data npm run reset-password -- <username> <newPassword>
 */

const crypto = require('node:crypto');
const { promisify } = require('node:util');
const store = require('../src/store');

const scryptAsync = promisify(crypto.scrypt);

async function main() {
  const username = String(process.argv[2] || '').trim();
  const newPassword = String(process.argv[3] || '');
  if (!username) throw new Error('用法: npm run reset-password -- <username> <newPassword>');
  if (newPassword.length < 6 || newPassword.length > 128) {
    throw new Error('新密码长度需 6-128 位');
  }

  const user = await store.readUserByName(username);
  if (!user) throw new Error('用户不存在: ' + username);

  const salt = crypto.randomBytes(16).toString('hex');
  const passHash = await scryptAsync(newPassword, salt, 64).then((buf) => buf.toString('hex'));

  await store.withLock(async () => {
    const fresh = await store.readUserById(user.id);
    if (!fresh) throw new Error('用户不存在: ' + username);
    fresh.salt = salt;
    fresh.passHash = passHash;
    fresh.sessionEpoch = Number(fresh.sessionEpoch || 0) + 1;
    fresh.recoveryCodes = [];
    fresh.passwordUpdatedAt = new Date().toISOString();
    await store.writeUser(fresh);
  });

  console.log(`[reset-password] 已重置 ${username} 的密码，并吊销其所有旧会话`);
}

main().catch((e) => {
  console.error('[reset-password]', e.message);
  process.exit(1);
});
