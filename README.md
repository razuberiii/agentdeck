# Agent Deck

Agent Deck 是一个面向手机浏览器的本地 Agent 控制台。它把 Codex CLI、会话状态、工作区选择、附件上传、图片预览和文件产物下载整合成一个可安装的 PWA，让你可以从手机上打开、继续和管理本机上的 Codex 会话。

当前项目由三部分组成：

- Web 网关：Fastify API、WebSocket、鉴权、附件与静态资源服务。
- 持久运行时：独立的 Agent runtime，负责保存会话事件、断线恢复、SSE 订阅和 Codex 账户运行状态。
- Codex app-server：以 systemd 模板服务独立运行，供 runtime 通过 WebSocket 调用。

## 主要能力

- 在移动端创建、继续、停止 Codex 会话。
- 扫描允许访问的工作区目录，并在指定项目中启动会话。
- 支持多 Codex profile 切换，以及 Antigravity profile 的登录和切换。
- 支持文本、图片和附件输入，生成图片和产物文件可以在会话中预览或下载。
- 会话可重命名、归档、取消归档、删除，并可查看项目 diff。
- WebSocket 重连后可以按事件序号恢复输出，避免刷新或断线丢失正在运行的 turn。
- 运行时状态写入 SQLite，项目代码更新时不移动用户数据。
- 提供 PWA manifest、service worker 和图标，适合添加到手机桌面使用。

## 目录结构

- `client/src/main.tsx`：React 前端入口。
- `client/src/styles.css`：移动端优先的界面样式。
- `client/public/`：PWA manifest、service worker、图标和测试静态资源。
- `server/src/index.ts`：Web 网关，包含 API、WebSocket、鉴权、会话索引、上传和产物服务。
- `server/src/agentdeck-runtime.ts`：持久 Agent runtime，负责会话、事件、恢复和 Codex app-server 连接。
- `server/src/codex.ts`：连接 `codex app-server` 的 JSON-RPC 客户端。
- `server/src/runtime-client.ts`：Web 网关调用 runtime 的客户端。
- `server/src/db.ts`：SQLite 初始化和访问封装。
- `server/src/workspaces.ts`：工作区白名单校验和项目扫描。
- `deploy/`：systemd 单元、安装脚本、切换脚本、回滚脚本和运行时验证脚本。
- `scripts/backup.sh`：运行数据备份脚本。

## 环境要求

- Node.js 20 或更高版本。
- 主机可用 SQLite。
- 已安装 OpenAI Codex CLI，并且 `codex` 命令可用。
- 一个可写的数据目录，默认是 `/opt/data/agentdeck`。
- 生产部署使用 systemd，默认项目目录是 `/opt/stacks/agentdeck`。

## 本地开发

安装依赖：

```bash
npm install
```

直接运行 TypeScript 版 Web 服务：

```bash
npm run dev
```

运行持久 runtime：

```bash
npm run dev:runtime
```

构建服务端和前端：

```bash
npm run build
```

启动构建后的 Web 服务：

```bash
npm start
```

常用脚本：

- `npm run build:server`：只编译服务端 TypeScript。
- `npm run build:client`：只构建 React 前端。
- `npm run runtime`：启动构建后的持久 runtime。

## 配置

应用通过环境变量配置。当前 systemd 部署会读取 `/opt/data/agentdeck` 下的环境文件：

- `/opt/data/agentdeck/web.env`
- `/opt/data/agentdeck/runtime.env`
- `/opt/data/agentdeck/agentdeck-app-server-default.env`

常用变量：

- `ADMIN_PASSWORD`：首次登录用的管理员密码。
- `COOKIE_SECRET`：签名 Cookie 的稳定密钥。
- `DATA_DIR`：运行数据目录，默认 `/opt/data/agentdeck`。
- `CODEX_HOME`：Codex 配置目录，默认 `/home/ubuntu/.codex`。
- `HOST`：Web 网关监听地址，默认 `127.0.0.1`。
- `PORT`：Web 网关监听端口，默认 `3842`。
- `RUNTIME_HOST`：runtime 监听地址，默认 `127.0.0.1`。
- `RUNTIME_PORT`：runtime 监听端口，默认 `3852`。
- `AGENT_RUNTIME_URL`：Web 网关访问 runtime 的地址，生产默认 `http://127.0.0.1:3852`。
- `USE_AGENT_RUNTIME`：设为 `1` 时 Web 网关使用持久 runtime。
- `ALLOWED_WORKSPACES`：允许打开的工作区根目录，多个路径用逗号分隔。
- `ALLOWED_ORIGINS`：允许连接 WebSocket 的浏览器 Origin，多个值用逗号分隔。
- `CODEX_APP_SERVER_LISTEN`：Codex app-server 监听地址，例如 `ws://127.0.0.1:4668`。
- `CODEX_APP_SERVER_PORT_BASE`：runtime 为 Codex app-server 分配端口时使用的基础端口。

## 生产部署

当前部署使用三个 systemd 服务：

```bash
sudo systemctl restart agentdeck-app-server@default.service
sudo systemctl restart agentdeck-runtime.service
sudo systemctl restart agentdeck-web.service
sudo systemctl status agentdeck-app-server@default.service agentdeck-runtime.service agentdeck-web.service
```

安装或刷新 systemd 单元：

```bash
deploy/install-units.sh
```

构建并切换到当前生产形态：

```bash
deploy/cutover.sh
```

代码更新后的常规流程：

```bash
npm run build
sudo systemctl restart agentdeck-runtime.service agentdeck-web.service
```

如果变更涉及 Codex app-server 环境或 systemd 单元，也需要重启模板服务：

```bash
sudo systemctl restart agentdeck-app-server@default.service
```

## 验证与回滚

运行 runtime 验证：

```bash
node deploy/verify-runtime.mjs
node deploy/e2e-runtime.mjs
```

生产切换失败时，`deploy/cutover.sh` 会调用：

```bash
deploy/rollback.sh
```

也可以手动执行回滚脚本恢复到旧服务形态。

## 运行数据

运行数据放在仓库外，便于代码更新和部署切换：

- SQLite 数据库：`/opt/data/agentdeck/agentdeck.sqlite3`
- Codex profiles：`/opt/data/agentdeck/profiles/`
- 共享 Codex 会话：`/opt/data/agentdeck/shared/sessions`
- 上传附件：`/opt/data/agentdeck/attachments/`
- systemd 环境文件：`/opt/data/agentdeck/*.env`

仓库内的 `.tools/` 目录只用于本地验证日志和临时探测文件，不属于发布内容。

## 安全说明

- Web API 使用登录 Cookie 和 CSRF Token。
- 写操作需要有效登录和 CSRF 请求头。
- WebSocket 会校验登录 Cookie 和允许的 Origin。
- systemd 服务默认以 `ubuntu` 用户运行，并通过 `ReadWritePaths` 限定主要写入路径。
- Codex app-server 当前以 `approval_policy="never"` 和 `sandbox_mode="danger-full-access"` 启动，只应部署在可信机器和受控网络环境中。
