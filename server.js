'use strict';

/**
 * HTML 渲染器（自托管版）
 * 纯 Node.js 标准库实现，无第三方运行时依赖。
 *
 * 启动：node server.js
 * 配置见 README.md / .env.example。
 */

const config = require('./src/config');
const { init } = require('./src/bootstrap');
const { createServer } = require('./src/app');

async function main() {
  await init();
  const server = createServer();

  server.listen(config.PORT, config.HOST, () => {
    console.log(
      `[server] listening on http://${config.HOST}:${config.PORT}, data=${config.DATA_DIR}`
    );
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.log('[server] shutting down', sig);
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }
}

main().catch((e) => {
  console.error('[server] fatal', e);
  process.exit(1);
});
