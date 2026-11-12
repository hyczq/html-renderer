# HTML 渲染器（自托管版）

把一段 HTML（粘贴 / 上传文件 / 远程 URL 抓取）变成**永久预览链接**的自托管小服务，并提供凭密钥访问的编辑页、账号体系与历史记录。

零第三方运行时依赖：单个 Node.js 进程 + 文件存储，Docker 一键部署，适合小内存服务器。

> 交互与视觉风格参考 [526900.pages.dev](https://526900.pages.dev/) 的「HTML 渲染器」；本项目是独立的自托管实现，与原站无隶属关系。

## 功能

| 功能 | 说明 |
|---|---|
| 🌐 从 URL | 服务端抓取远程 HTML 并保存（GitHub raw / 任意静态页） |
| 📝 粘贴代码 | 直接保存粘贴的 HTML |
| 📤 上传文件 | 浏览器读取 `.html/.htm` 后提交（≤ 2 MB） |
| 🔗 永久链接 | `GET /p/<code>` 直接返回存储的 HTML |
| ✏️ 编辑链接 | `GET /edit/<code>?key=<editKey>`，凭密钥读取/保存 |
| 👤 注册/登录 | 用户名 + 密码，scrypt 哈希，30 天签名 Cookie 会话 |
| 📁 我的页面 | 登录后 `/my` 查看全部历史链接，支持搜索、复制、编辑、删除 |
| 🏷️ 页面命名 | 生成时可填名称（留空自动取 HTML `<title>` / URL 域名），之后可随时重命名 |
| ♻️ SHA-256 去重 | 同一用户相同内容直接复用原链接，不重复建记录 |
| 🧩 内容级存储 | HTML 按 hash 存 `blobs/<sha256>.html`，不同用户相同内容也只存一份 |
| 🌙 深色模式 | 跟随系统主题，记忆在 localStorage |

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
cp .env.example .env          # 可选：修改 BRAND_NAME 等
mkdir -p data/pastes
sudo chown -R 10001:10001 data   # 容器内以 uid 10001 运行
docker compose up -d --build
curl http://127.0.0.1:8899/healthz   # -> ok
```

默认映射 `8899:3000`，数据落在 `./data`（bind mount，随宿主机备份）。若修改 `docker-compose.yml` 中的端口映射，请同步调整访问地址。

### 反向代理

建议放在 Caddy / Nginx 之后并启用 HTTPS。以 Caddy 为例：

```caddyfile
example.com {
    reverse_proxy 127.0.0.1:8899
}
```

反代场景保持 `TRUST_PROXY=1`，这样会话 Cookie 会在 HTTPS 下带 `Secure`，限流也能取到真实客户端 IP。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `/data` | 数据目录（本地运行请改成 `./data`） |
| `BRAND_NAME` | `HTML 渲染器` | 页面标题/品牌名 |
| `MAX_PASTE_BYTES` | `2097152` | 单页最大字节数（2 MB） |
| `TRUST_PROXY` | `1`（compose） | 是否信任 `X-Forwarded-For` / `CF-Connecting-IP`；直接暴露公网时设为 `0` |
| `FETCH_TIMEOUT_MS` | `12000` | 抓取远程 URL 的超时（毫秒） |

## 数据目录

```
data/
  secret.key                 # 会话签名密钥（首次启动生成，勿删）
  users/u_<id>.json          # 用户（scrypt 哈希 + salt）
  index/users.json           # 用户名 → userId
  index/user-pastes/<id>.json# 用户的历史记录索引
  pastes/<code>.json         # 链接记录（code/editKey/hash/大小/时间，无正文）
  blobs/<sha256>.html        # HTML 正文，按内容哈希去重
```

旧版本的 `pastes/<code>.json`（内嵌 `html`）会在启动时自动迁移到 `blobs/`。

备份：直接打包整个 `data/` 即可；容器本身无状态，可随时重建。

## HTTP API

错误统一以 HTTP 200 + `{"success":false,"error":"..."}` 返回（与参考站点一致）；未登录返回 `needLogin:true`。

| 方法 | 路径 | 入参 | 返回 |
|---|---|---|---|
| POST | `/generate` | `{"type":"code","code":"<html>","name":"可选"}` 或 `{"type":"url","url":"...","name":"可选"}` | `{"success":true,"code":"...","editKey":"...","name":"...","reused":false}` |
| GET | `/p/:code` | — | 原始 HTML（预览 CSP 允许脚本，见安全说明） |
| GET | `/edit/:code?key=` | — | 编辑页 |
| GET | `/api/get?code=&key=` | — | `{"success":true,"html":"..."}` |
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
  http.js                 # 请求体读取、JSON/文本/HTML 响应
  rate-limit.js           # 进程内滑动窗口限流
  store.js                # 文件存储、原子写、串行化写锁
  auth.js                 # scrypt 密码、签名 Cookie 会话
  fetch-html.js           # 远程 URL 抓取与 SSRF 防护
  handlers.js             # 业务处理器（生成/读取/保存/重命名/删除等）
  app.js                  # 路由与 CSP
  bootstrap.js            # 建目录、密钥、旧数据迁移
public/                   # index / edit / login / my 页面与 avatar.svg
test/api.test.js          # 端到端冒烟测试（node:test）
Dockerfile
docker-compose.yml
deploy.sh                 # tar over ssh 部署脚本（需自行设置 HOST）
.env.example
SECURITY.md
```

## 开发与测试

```bash
npm test
```

测试会启动真实 HTTP 服务并使用临时数据目录，覆盖：健康检查、匿名/登录生成、预览、读取、保存、去重、并发去重、注册登录、我的页面、重命名、删除、SSRF 拦截、旧数据迁移。CI 在 Node 18/20/22/24 上运行。

## 部署脚本

`deploy.sh` 通过 `tar over ssh` 把当前目录（排除 `data/`、`.git`、`.env`）同步到服务器并执行 `docker compose up -d --build`：

```bash
HOST=root@your-server ./deploy.sh
# 可选：KEY=~/.ssh/id_ed25519 REMOTE_DIR=/opt/html-renderer
```

脚本不再内置任何服务器地址或密钥路径，请通过环境变量传入。

> `.env` 不会随部署脚本上传。如需自定义 `BRAND_NAME` 等配置，请在服务器上的 `REMOTE_DIR` 下自行创建 `.env`（可从 `.env.example` 复制）。

## 与原站的差异

- 增加账号体系、历史记录、内容去重（原站没有）；
- 去掉原站顶部广告条（改为自用公告），头像换成本地 SVG，品牌名可用 `BRAND_NAME` 修改；
- URL 抓取增加 SSRF 防护（禁止内网/回环/元数据地址，逐跳校验重定向），5 次跳转、12 秒超时、2 MB；
- 每 IP 限流（生成：登录 200 次/小时、匿名 60 次/小时；保存 300 次/小时；登录注册 30 次/15 分钟）；
- 存储为文件，无外部数据库；code 8 位、editKey 16 位；密码 scrypt，会话 HMAC-SHA256 签名 Cookie。

## 安全注意

预览页会在**同源**下渲染任意 HTML/JS，这是产品行为。请使用独立域名部署，**不要**在该域名下放置任何登录态或敏感 Cookie。完整威胁模型与加固清单见 [SECURITY.md](SECURITY.md)。

其他要点：

- 密码使用 `crypto.scrypt`（N=16384）加盐哈希，会话 Cookie 为 `HttpOnly; SameSite=Lax`，HTTPS 下自动加 `Secure`。
- 编辑密钥等同密码；匿名用户丢失后无法找回，登录用户可在「我的页面」查看。
- 数据备份只需打包 `data/`，但请妥善保管 `secret.key`。

## License

[MIT](LICENSE)
