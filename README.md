# Agent Deck

Agent Deck 是一个面向手机浏览器的本机 Agent 控制台。当前生产域名是 `https://codex.rubusoo.com`。

## 架构

请求链路是：

`Browser/PWA -> Web gateway -> persistent runtime -> Codex app-server`

- Browser/PWA：React 前端，通过 HTTP API 拉取快照，通过 WebSocket join 会话、发送消息和接收事件。
- Web gateway：Fastify 服务，负责登录 Cookie、CSRF、Origin 校验、会话列表、附件、产物、WebSocket 转发和 runtime subscription。
- persistent runtime：独立 Fastify 服务，持有 Codex 账户运行状态、SQLite 事件库、SSE push subscription、上游 thread resume/read。
- Codex app-server：Codex CLI 的 app-server，由 systemd 模板服务运行，runtime 通过 JSON-RPC/WebSocket 调用。

## 事件流与重连边界

浏览器进入 Codex 会话时，Web 会先按 `lastSequence` replay 已持久化 runtime events，然后幂等建立 runtime SSE subscription。idle 会话也会订阅；idle 只表示当前没有运行中的 turn，不表示下次发送前不需要事件回传通道。

用户发送消息时，Web 会再次幂等确保 subscription 已存在或正在建立，然后调用 runtime `turn/start`。前端会收到消息提交状态：`received`、`persisted`、`accepted`、`running`、`completed` 或 `failed`。`turn/start` 失败时会显示错误并保留输入以便重试。

恢复能力边界：

- 浏览器刷新或断线：Web 会补发已经成功持久化的事件。
- Web 重启：浏览器重连后重新 join，会重建 runtime subscription。
- runtime 重启：runtime 会读取本地 running/recovering 会话，向 app-server 执行 thread read/resume 校准状态。
- app-server 重启：runtime 会尝试重新连接并恢复上游 thread。
- 极端 runtime 崩溃：关键事件采用持久化后广播；高频 delta 批量写入，尚未 flush 的片段仍可能丢失。
- 上游 thread 丢失：runtime 会尝试创建替代 thread，并注入本地恢复上下文；模型内部完整上下文不能保证无损。

## 数据文件

运行数据在 `/opt/data/agentdeck`：

- `agentdeck.sqlite3`：Web gateway 会话索引、用户、settings、附件/产物索引。
- `agentdeck-runtime.sqlite3`：runtime sessions、events、accounts、runtime_instances。
- `agentdeck-runtime.sqlite3-wal` / `agentdeck-runtime.sqlite3-shm`：SQLite WAL 辅助文件。
- `profiles/`：Codex profile 目录。
- `antigravity-profiles/`：Antigravity profile 目录。
- `shared/sessions/`：共享 Codex session 文件。
- `shared/generated_images/`：生成图片。
- `attachments/`：上传附件。
- `web.env`、`runtime.env`、`agentdeck-app-server-default.env`：systemd 环境文件。

备份 SQLite 时应同时备份主库和 WAL/SHM，或先停止相关服务再复制。当前备份脚本应覆盖两个 SQLite 数据库；恢复后用 `npm run test:e2e` 和会话列表读取验证。

## 配置

常用环境变量：

- `ADMIN_PASSWORD`：首次登录密码。
- `COOKIE_SECRET`：签名 Cookie 密钥，必须稳定保存。
- `DATA_DIR`：默认 `/opt/data/agentdeck`。
- `CODEX_HOME`：默认 `/home/ubuntu/.codex`。
- `HOST` / `PORT`：Web 监听地址和端口，默认 `127.0.0.1:3842`。
- `RUNTIME_HOST` / `RUNTIME_PORT`：runtime 监听地址和端口，默认 `127.0.0.1:3852`。
- `RUNTIME_TOKEN`：runtime 控制接口 token。`RUNTIME_HOST` 不是 loopback 时必须配置。
- `AGENT_RUNTIME_URL`：Web 调用 runtime 的地址。
- `AGENT_RUNTIME_TOKEN`：Web 调用 runtime 时使用的 Bearer token；不要发送到前端。
- `USE_AGENT_RUNTIME=1`：启用 persistent runtime。
- `ALLOWED_WORKSPACES`：工作区根目录列表。
- `ALLOWED_ORIGINS`：浏览器 WebSocket Origin 白名单，多个值逗号分隔。生产必须包含 `https://codex.rubusoo.com`；如需要 HTTP 访问也要显式加入对应 Origin。

`ALLOWED_ORIGINS` 只校验浏览器 WebSocket 请求来自哪个页面 Origin。它不是 Codex API 白名单，不是登录用户列表，也不是服务器访问控制列表。没有 Origin 的非浏览器客户端当前不会被 Origin 白名单拒绝，但仍需要有效登录 Cookie。

## 本地开发与质量命令

```bash
npm install
npm run dev:runtime
npm run dev
npm run build
npm run typecheck
npm test
npm run test:e2e
npm run lint
```

本地 HTTP 开发如果使用 Secure cookie，需要走 localhost 或调整开发反向代理；生产应使用 HTTPS，并确保反向代理保留正确的 `Host`、`Origin` 和转发头。

## systemd

当前生产服务：

```bash
sudo systemctl status agentdeck-app-server@default.service --no-pager
sudo systemctl status agentdeck-runtime.service --no-pager
sudo systemctl status agentdeck-web.service --no-pager
```

重启当前 AgentDeck stack：

```bash
sudo systemctl restart agentdeck-app-server@default.service
sudo systemctl restart agentdeck-runtime.service
sudo systemctl restart agentdeck-web.service
```

runtime 会使用 `sudo systemctl` 管理默认 app-server，也可能使用 `sudo systemd-run` 启动非默认账户 app-server。生产部署应配置最小 sudoers，只允许 AgentDeck 相关 unit 的 start/stop/restart/status 以及受控的 transient app-server 启动命令；不要默认要求无限制免密 sudo。

## 安全边界

当前服务以 `ubuntu` 用户运行，并共享 `/home/ubuntu`、项目目录和 Agent token 可见范围。systemd 配置有 `ProtectSystem=full`、`PrivateTmp=true` 和 `ReadWritePaths`，但这不是强隔离。Codex app-server 使用 `approval_policy="never"` 和 `sandbox_mode="danger-full-access"`，只应运行在可信机器和受控网络中。

未认证 `/api/status` 只返回最小公开信息。需要登录后才返回 workspace roots、Codex home、provider、profile 和 runtime 状态。

## Rollback

当前 `deploy/rollback.sh` 不是完整版本回滚平台；不要把它理解为一定能恢复上一版代码、构建产物、env、systemd unit 和数据库迁移前状态。当前部署流程更接近“重启当前 stack/恢复当前服务形态”。需要真正 rollback 时，应使用发布目录、`current/previous` symlink、env/unit 快照和数据库迁移前备份。

## Antigravity

Antigravity 目前是补充 provider：

- 支持 profile 登录/切换、会话创建、普通文本发送和基本回复展示。
- 当前通过 Google 官方 CLI 的一次性命令执行，不是 Codex runtime 等价长连接。
- 不承诺图片发送、图片理解、结构化工具调用、长任务恢复或完整连续上游会话能力。

Codex 仍是当前一等支持路径。
