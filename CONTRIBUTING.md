# 贡献指南

感谢你愿意参与改进 HTML 渲染器。提交 Issue 或 Pull Request 前，请先阅读本指南。

## 开发环境

- Node.js >= 18（CI 覆盖 18 / 20 / 22 / 24）
- 本项目没有第三方运行时依赖，无需执行 `npm install`
- 本地数据目录不要提交到 Git

## 本地运行

```bash
DATA_DIR=./data PORT=3000 npm start
# 打开 http://localhost:3000
```

运行测试：

```bash
npm test
```

测试会启动真实 HTTP 服务并使用临时数据目录，不会写入当前工作目录的 `data/`。

## 代码约定

- 保持零第三方运行时依赖，优先使用 Node.js 标准库
- 服务端使用 CommonJS，2 空格缩进、单引号、分号
- 新增行为需要补充 `test/api.test.js` 中的端到端测试
- 涉及预览隔离、SSRF、认证、Cookie、限流等安全边界时，请在 PR 中说明威胁模型和验证方式
- 不要提交 `.env`、`data/`、密钥、证书或服务器私有配置

## 提交 Pull Request

1. Fork 仓库并从 `main` 创建分支
2. 保持改动聚焦，避免混入无关格式化或重构
3. 确认 `npm test` 通过
4. 在 PR 描述中说明变更内容、测试方式和可能的安全影响

## 安全漏洞

请不要公开提交安全 Issue。请按照 [SECURITY.md](SECURITY.md) 中的流程通过 GitHub 私密安全公告报告。

## 许可证

参与贡献即表示你同意将贡献内容按本项目的 [MIT License](LICENSE) 授权。
