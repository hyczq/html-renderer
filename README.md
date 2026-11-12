# HTML 渲染器（自托管版）

把一段 HTML（粘贴 / 上传文件 / 远程 URL 抓取）变成**永久预览链接**的自托管小服务，并提供凭密钥访问的编辑页、账号体系与历史记录。

**零第三方运行时依赖 · 文件即数据 · 内容级去重 · Docker 一键部署**

[![CI](https://github.com/hyczq/html-renderer/actions/workflows/ci.yml/badge.svg)](https://github.com/hyczq/html-renderer/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 项目特色

- **零第三方运行时依赖**：只用 Node.js 标准库，无需 `npm install`，没有数据库、Redis 或对象存储。
- **文件即数据**：页面、用户、索引全部是 JSON/HTML 文件；备份就是打包 `data/`，迁移就是复制目录。
- **内容级去重**：按 SHA-256 存储正文，多用户相同 HTML 只保留一份，链接与编辑密钥仍各自独立。
- **自托管可控**：数据完全留在自己的服务器；Docker Compose 一条命令启动，也可直接 `node server.js` 运行。
- **安全默认**：预览页独立域名隔离（可配置）、CSP sandbox 兜底、SSRF 防护、按 IP 限流、scrypt 密码哈希、HMAC 签名 Cookie、原子写与串行化写锁。
- **移动端友好**：响应式布局、刘海屏安全区域、触控尺寸与输入防缩放，文本响应 gzip 压缩省流量。
- **统一视觉**：首页、我的页面、登录与编辑页共享 `public/theme.css` 设计令牌与组件（顶栏 / 卡片 / 按钮 / 表单），布局不再各自分叉。
- **完整体验**：深色模式、编辑链接、我的页面、搜索/筛选/分页与快捷键。
- **可验证**：24 项测试覆盖核心流程、预览隔离、Cookie 安全、SSRF 边界、索引重建与 blob 回收，CI 在 Node 18/20/22/24 上回归。

## 功能

| 功能 | 说明 |
|---|---|
| 🌐 从 URL | 服务端抓取远程 HTML 并保存（GitHub raw / 任意静态页） |
| 📝 粘贴代码 | 直接保存粘贴的 HTML |
| 📤 上传文件 | 浏览器读取 `.html/.htm` 后提交（≤ 2 MB） |
| 🔗 永久链接 | `GET /p/<code>` 返回存储的 HTML；配置预览域后主站只做 302 跳转 |
| 🛡️ 预览隔离 | 独立预览域名只提供只读页面，不暴露 API、不写 Cookie；未配置时默认 CSP sandbox |
| 🧭 404 页面 | 不存在的链接返回与全站一致的样式化提示，支持返回首页 / 上一页 |
| ✏️ 编辑链接 | `GET /edit/<code>#key=<editKey>`，凭密钥读取/保存（查询参数 `?key=` 仍兼容） |
| 👤 注册/登录 | 用户名 + 密码，scrypt 哈希，30 天签名 Cookie 会话 |
| 📁 我的页面 | 登录后 `/my` 查看全部历史链接，支持搜索、复制、编辑、删除 |
| 🏷️ 页面命名 | 生成时可填名称（留空自动取 HTML `<title>` / URL 域名），之后可随时重命名 |
| ♻️ SHA-256 去重 | 同一用户相同内容直接复用原链接，不重复建记录 |
| 🧩 内容级存储 | HTML 按 hash 存 `blobs/<sha256>.html`，不同用户相同内容也只存一份 |
| 🌙 深色模式 | 跟随系统主题，记忆在 localStorage |
| 📱 移动端适配 | 响应式布局、安全区域、触控尺寸优化、输入不触发 iOS 缩放 |

### 去重规则

- **同一登录用户**重复生成相同内容 → 返回**同一个 code / editKey**（`reused: true`），不新增记录。
- **不同用户**生成相同内容 → 各自有独立的 code 与 editKey（编辑权限互不影响），但 HTML 正文在 `blobs/` 中**只存一份**。
- **匿名用户**：同一浏览器（`hr_aid` Cookie）重复生成相同内容 → 复用同一链接；不同浏览器之间不共享（避免泄露 editKey）。

## 快速开始

### 本地运行

要求 Node.js >= 18，无需 `npm install`（没有任何第三方依赖）。

```bash
DATA_DIR=./data PORT=3000 npm start
# 打开 http://localhost:3000
```

> `DATA_DIR` 默认是 `/data`（为容器设计）。本地运行请显式指定可写目录，否则可能因权限失败。

### Docker Compose

```bash
cp .env.example .env          # 可选：修改 BRAND_NAME、PREVIEW_ORIGIN 等
mkdir -p data/pastes
sudo chown -R 10001:10001 data   # 容器内以 uid 10001 运行
docker compose up -d --build
curl http://127.0.0.1:8899/healthz   # -> ok
```

默认映射 `8899:3000`，数据落在 `./data`（bind mount，随宿主机备份）。若修改 `docker-compose.yml` 中的端口映射，请同步调整访问地址。

服务器本地差异（如额外端口、资源限制）建议放在 `docker-compose.override.yml`：Compose 会自动合并，该文件已被 `.gitignore` 忽略，整目录部署也不会覆盖它。

### 反向代理

建议放在 Caddy / Nginx 之后并启用 HTTPS。以 Caddy 为例：

```caddyfile
example.com {
    reverse_proxy 127.0.0.1:8899
}
```

反代场景保持 `TRUST_PROXY=1`，这样会话 Cookie 会在 HTTPS 下带 `Secure`，限流也能取到真实客户端 IP。

### 预览隔离（强烈建议）

预览页会执行用户提供的任意 HTML/JS，因此必须和账号体系分开。配置 `PREVIEW_ORIGIN` 后：

- 主站 `/p/<code>` 不再渲染 HTML，只返回 `302` 到预览域；
- 预览域只提供 `GET/HEAD /p/<code>`，其他路径一律 `404`；
- 预览域不读取会话、不写 Cookie、不暴露 `/api/*`；
- 会话 Cookie 是 host-only 的，不会被发送到预览子域。

条件允许时建议使用**不同注册域**（例如 `example-preview.com`）；至少也要用独立子域。独立子域已能阻断读取主站会话，不同注册域还能避免子域写父域 Cookie 的副作用。`PREVIEW_ORIGIN` 必须指向与主站不同的域名，不能填主站自身。

以 Caddy 为例，把两个域名都反代到同一个服务：

```caddyfile
example.com {
    reverse_proxy 127.0.0.1:8899
}

preview.example.com {
    reverse_proxy 127.0.0.1:8899
}
```

`.env` 中设置：

```bash
PREVIEW_ORIGIN=https://preview.example.com
```

Nginx 同理，只要保留原始 `Host`（`proxy_set_header Host $host;`）即可，应用会按 Host 分流。

> 不要用「同域名不同端口」代替独立域名：Cookie 不按端口隔离，端口方案不能真正隔离会话。
>
> 如果暂时没有独立域名，应用会默认给预览页加 `CSP sandbox`（不透明源），阻断同源读取 `/api/my` 等接口；但部分依赖 `localStorage` 或同源 API 的 HTML 可能无法正常运行。要完整兼容并彻底隔离，请配置 `PREVIEW_ORIGIN`。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/data` | 数据目录（本地运行请改成 `./data`） |
| `BRAND_NAME` | `HTML 渲染器` | 页面标题/品牌名 |
| `MAX_PASTE_BYTES` | `2097152` | 单页最大字节数（2 MB） |
| `TRUST_PROXY` | `1`（compose） | 是否信任 `X-Forwarded-For` / `CF-Connecting-IP` / `X-Forwarded-Host`；直接暴露公网时设为 `0` |
| `FETCH_TIMEOUT_MS` | `12000` | 抓取远程 URL 的超时（毫秒） |
| `URL_FETCH_ENABLED` | `1` | 是否允许从 URL 抓取；设为 `0` 可关闭该功能 |
| `FETCH_ALLOWED_PORTS` | `80,443` | URL 抓取允许的端口白名单，逗号分隔 |
| `BLOB_GC_GRACE_MS` | `600000` | 无引用 blob 的延迟回收时间（毫秒） |
| `PREVIEW_ORIGIN` | 空 | 预览页独立 Origin，例如 `https://preview.example.com`；强烈建议设置 |
| `PREVIEW_SANDBOX` | 未设置 `PREVIEW_ORIGIN` 时 `1` | 是否给预览页加 CSP sandbox（`1/0`）；独立域名下默认 `0` 以保持页面兼容；未配置 `PREVIEW_ORIGIN` 时禁止设为 `0` |

## 数据目录

```
data/
  secret.key                 # 会话签名密钥（首次启动生成，勿删）
  users/u_<id>.json          # 用户（scrypt 哈希 + salt）
  index/users.json           # 用户名 → userId
  index/user-pastes/<id>.json# 旧版用户索引；启动时忽略，可由 pastes/ 重建
  pastes/<code>.json         # 链接记录（唯一事实来源：code/editKey/hash/大小/时间）
  blobs/<sha256>.html        # HTML 正文，按内容哈希去重
```

旧版本的 `pastes/<code>.json`（内嵌 `html`）会在启动时自动迁移到 `blobs/`。

备份：直接打包整个 `data/` 即可；容器本身无状态，可随时重建。

## HTTP API

错误统一以 HTTP 200 + `{"success":false,"error":"..."}` 返回；未登录返回 `needLogin:true`。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| POST | `/generate` | `{"type":"code","code":"<html>","name":"可选"}` 或 `{"type":"url","url":"...","name":"可选"}` | `{"success":true,"code":"...","editKey":"...","name":"...","reused":false}` |
| GET | `/p/:code` | — | 原始 HTML；配置 `PREVIEW_ORIGIN` 后主站返回 302 到预览域 |
| GET | `/edit/:code#key=` | — | 编辑页（`?key=` 仍兼容） |
| GET | `/api/get?code=` | `X-Edit-Key` 请求头（或 `key` 查询参数） | `{"success":true,"html":"..."}` |
| POST | `/api/save` | `{"code":"...","key":"...","html":"...","name":"可选"}` | 保存内容/名称 |
| POST | `/api/register` | `{"username":"...","password":"..."}` | 注册并登录 |
| POST | `/api/login` | 同上 | 登录 |
| POST | `/api/logout` | — | 退出 |
| GET | `/api/me` | — | 当前用户 |
| GET | `/api/my?offset=&limit=` | — | `{total, stats, items:[{code,editKey,size,createdAt,...}]}` |
| POST | `/api/delete` | `{"code":"..."}` | 删除自己的记录 |
| POST | `/api/rename` | `{"code":"...","name":"...","key":"可选"}` | 重命名（登录所有者或持 key 均可） |
| GET | `/healthz` | — | `ok` |

页面路由：`GET /`（首页）、`GET /login`（登录/注册）、`GET /my`（我的页面）。

## 快捷操作

| 快捷键 | 位置 | 作用 |
|---|---|---|
| `Ctrl/⌘ + Enter` | 首页 | 快速生成 |
| `Ctrl/⌘ + S` | 编辑页 | 保存修改 |
| `Tab` | 编辑页代码框 | 插入两个空格（不跳出输入框） |
| `/` | 我的页面 | 聚焦搜索框 |

编辑页会显示当前字节数（接近 2 MB 变色警告），有未保存修改时关闭页面会提示；「我的页面」支持按「全部 / 代码 / URL」筛选、搜索、分页加载、弹窗内联重命名。

## 项目结构

```
server.js                 # 进程入口：初始化 + 监听 + 优雅退出
src/
  config.js               # 环境变量、数据目录、页面模板
  http.js                 # 请求体读取、JSON/文本/HTML 响应、异步 gzip
  rate-limit.js           # 进程内滑动窗口限流
  store.js                # 文件存储、内存索引、blob 引用计数、原子写/写锁
  auth.js                 # scrypt 密码、签名 Cookie 会话
  fetch-html.js           # 远程 URL 抓取：DNS 固定、SSRF 防护、端口白名单
  handlers.js             # 业务处理器（生成/读取/保存/重命名/删除等）
  app.js                  # 路由、CSP、预览 ETag/304
  bootstrap.js            # 建目录、密钥、旧数据迁移
public/                   # index / edit / login / my / 404 页面、theme.css/theme.js 与 avatar.svg
test/api.test.js          # 端到端冒烟测试（node:test）
scripts/doctor.js         # 数据自检：缺失 blob / hash 不一致 / 孤儿 blob
Dockerfile
docker-compose.yml
deploy.sh                 # tar over ssh 部署脚本（需自行设置 HOST）
.env.example
SECURITY.md
CONTRIBUTING.md
CODE_OF_CONDUCT.md
.github/                  # CI、Issue / PR 模板
```

## 开发与测试

```bash
npm test
npm run doctor             # 数据自检（只读）
npm run doctor -- --fix-orphans  # 索引加载无错误时清理孤儿 blob
```

测试会启动真实 HTTP 服务并使用临时数据目录，覆盖：健康检查、gzip 压缩、匿名/登录生成、预览、读取、保存、去重、并发去重、注册登录、我的页面、重命名、删除、SSRF 拦截、IPv6 私网边界、端口白名单、重启索引重建、blob 引用计数/回收、旧数据迁移。CI 在 Node 18/20/22/24 上运行。

## 部署脚本

`deploy.sh` 通过 `tar over ssh` 把当前目录（排除 `data/`、`.git`、`.env`）同步到服务器并执行 `docker compose up -d --build`：

```bash
HOST=root@your-server ./deploy.sh
# 可选：KEY=~/.ssh/id_ed25519 REMOTE_DIR=/opt/html-renderer
```

脚本不再内置任何服务器地址或密钥路径，请通过环境变量传入。

> `.env` 不会随部署脚本上传。如需自定义 `BRAND_NAME` 等配置，请在服务器上的 `REMOTE_DIR` 下自行创建 `.env`（可从 `.env.example` 复制）。

## 安全注意

预览页会执行任意 HTML/JS。请配置 `PREVIEW_ORIGIN` 使用独立预览域名，**不要**在该域名下放置登录态或敏感 Cookie；应用会保证预览域只读、无 API、不写 Cookie。未配置独立域名时，预览页默认使用 `CSP sandbox` 不透明源作为兜底。完整威胁模型与加固清单见 [SECURITY.md](SECURITY.md)。

其他要点：

- 密码使用 `crypto.scrypt`（N=16384）加盐哈希，会话 Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 下自动加 `Secure` 并使用 `__Host-` 前缀（host-only，降低子域 Cookie 注入风险）。
- 编辑密钥等同密码；匿名用户丢失后无法找回，登录用户可在「我的页面」查看。code 为 8 位、editKey 为 16 位，均由加密随机数生成。
- URL 抓取做 SSRF 防护：DNS 只解析一次并固定到已校验 IP（防 DNS 重绑定），拦截 IPv4/IPv6 私网、回环、链路本地、元数据、NAT64、6to4、Teredo 等地址；默认只允许 80/443 端口，逐跳复验重定向，最多 5 跳、12 秒超时、2 MB；可用 `URL_FETCH_ENABLED=0` 完全关闭。
- 按 IP 限流：生成（登录 200 次/小时、匿名 60 次/小时）、保存 300 次/小时、登录注册 30 次/15 分钟。
- 数据备份只需打包 `data/`，但请妥善保管 `secret.key`。

## 贡献

欢迎提交 Issue 和 Pull Request。参与前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)；安全漏洞请按 [SECURITY.md](SECURITY.md) 的流程私下报告，不要公开提交 Issue。

## License

[MIT](LICENSE)
