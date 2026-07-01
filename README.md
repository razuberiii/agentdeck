# AgentDeck

AgentDeck 是一个自托管的 Web / 移动端 PWA 客户端，用于通过持久运行时管理和继续 Codex 会话。

## 功能

- Codex Web / PWA 客户端，适配桌面和移动浏览器。
- 多 Codex profile 与账户切换。
- 会话列表、历史记录、重命名、归档、Fork 和删除。
- AgentDeck runtime 持久化会话元数据和事件。
- 页面刷新、浏览器重连或 Web 网关重启后可补发已持久化事件。
- 支持文件和图片附件上传，具体能力取决于 provider。
- 支持项目 diff 查看和生成产物下载。
- Gemini CLI provider，通过 ACP 运行在持久 runtime 中，并支持多 Gemini profile。
- 可选 Google Antigravity provider，用于基础文本任务。
- 移动端优先界面，包含可安装 PWA 资源。

## 架构

```text
Browser / PWA
  -> Web gateway
  -> AgentDeck runtime
  -> Codex app-server / Gemini ACP process
```

- **Browser / PWA**：加载会话快照，通过 WebSocket 加入会话、发送消息并渲染流式事件。
- **Web gateway**：Fastify API 与 WebSocket 服务，负责鉴权、CSRF、Origin 校验、会话索引、附件、产物和 runtime 订阅。
- **AgentDeck runtime**：长期运行的服务，将 runtime 会话和事件写入 SQLite，管理 Codex 账户运行状态、Gemini ACP 进程，并向 Web gateway 暴露 SSE 事件流。
- **Codex app-server**：由 runtime 调用的 Codex CLI app-server 进程，负责执行 Codex JSON-RPC 请求。
- **Gemini ACP process**：由 runtime 通过 JSON-RPC over stdio 管理的 Gemini CLI `--acp` 长连接进程。

## 环境要求

- Node.js 20 或更高版本，推荐 Node.js 22 LTS。
- npm。
- SQLite。
- OpenAI Codex CLI，并支持 `codex app-server`。
- 可选 Gemini CLI `@google/gemini-cli`，并支持 `gemini --acp`。
- Linux 可直接使用仓库中的 systemd 示例；其他进程管理器也可以运行相同的 Web 和 runtime 入口。

## 快速开始

安装依赖：

```bash
npm install
```

构建服务端和前端：

```bash
npm run build
```

启动 runtime：

```bash
DATA_DIR=.data \
RUNTIME_HOST=127.0.0.1 \
RUNTIME_PORT=3852 \
npm run runtime
```

在另一个终端启动 Web gateway：

```bash
DATA_DIR=.data \
USE_AGENT_RUNTIME=1 \
AGENT_RUNTIME_URL=http://127.0.0.1:3852 \
ALLOWED_ORIGINS=http://localhost:3842,http://127.0.0.1:3842 \
ADMIN_PASSWORD='change-me-at-least-12-chars' \
COOKIE_SECRET='change-me-random-32-bytes' \
npm start
```

打开：

```text
http://127.0.0.1:3842
```

## 配置

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Web gateway 监听地址。 |
| `PORT` | `3842` | Web gateway 监听端口。 |
| `DATA_DIR` | `/var/lib/agentdeck` | 主数据目录，用于 Web 状态、上传文件、profiles 和 SQLite 文件。 |
| `ADMIN_PASSWORD` | 无 | 初始管理员登录密码，生产环境必须设置。 |
| `COOKIE_SECRET` | 进程启动时生成 | Cookie 签名密钥，生产环境应设置稳定随机值。 |
| `ALLOWED_ORIGINS` | `http://localhost:3842,http://127.0.0.1:3842` | 浏览器 WebSocket Origin 白名单。例如：`ALLOWED_ORIGINS=https://agentdeck.example.com`。 |
| `USE_AGENT_RUNTIME` | 未启用 | 设置为 `1` 后，Codex 会话通过持久 runtime 运行。 |
| `AGENT_RUNTIME_URL` | `http://127.0.0.1:3852` | Web gateway 调用 runtime 的 URL。 |
| `AGENT_RUNTIME_TOKEN` | 未设置 | runtime 要求 token 时，Web gateway 使用的 Bearer token。 |
| `RUNTIME_HOST` | `127.0.0.1` | runtime 监听地址。 |
| `RUNTIME_PORT` | `3852` | runtime 监听端口。 |
| `RUNTIME_TOKEN` | 未设置 | `RUNTIME_HOST` 不是 loopback 时必须设置。 |
| `RUNTIME_DB` | `$DATA_DIR/agentdeck-runtime.sqlite3` | runtime SQLite 数据库路径。 |
| `CODEX_HOME` | `$HOME/.codex` | Codex profile / 配置目录。 |
| `ALLOWED_WORKSPACES` | 当前工作目录和 `/opt/projects` | UI 中可选择的工作区根目录，多个路径用逗号分隔。 |
| `ANTIGRAVITY_BIN` | `agy` | 可选 Antigravity CLI 命令路径。 |
| `GEMINI_BIN` | `/usr/bin/gemini` | 可选 Gemini CLI 命令路径。 |
| `GEMINI_ACP_ARGS` | `--acp` | Gemini ACP 启动参数。旧 CLI 如仍需 `--experimental-acp` 可在这里覆盖。 |
| `GEMINI_PROFILE_ROOT` | `$DATA_DIR/gemini/profiles/default` | Gemini default profile / 凭据目录。 |
| `MAX_ATTACHMENT_BYTES` | `33554432` | 单个附件大小上限。 |
| `MAX_ATTACHMENTS_PER_MESSAGE` | `10` | 单条消息附件数量上限。 |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `67108864` | 单条消息附件总大小建议上限。 |

## Gemini CLI Provider

Gemini provider 需要 Node.js 20+ 和稳定版 Gemini CLI：

```bash
npm install -g @google/gemini-cli@0.49.0
gemini --version
gemini --help
```

AgentDeck runtime 使用 `gemini --acp` 启动长期 ACP 子进程。Gemini 支持多 profile，每个 profile 使用独立的 `HOME` 和 `GEMINI_CONFIG_DIR`，默认 profile 位于：

```text
/var/lib/agentdeck/gemini/profiles/default
```

新建 profile 会使用独立目录，例如：

```text
/var/lib/agentdeck/gemini/profiles/<profile-id>/home
```

Gemini 凭据与 Codex、Antigravity 分开保存，不会写入浏览器、SQLite 消息正文或公开仓库。Web 登录支持 Gemini API Key 和 Google OAuth：API Key 只写入当前 profile 的 `agentdeck.env`，文件权限为 `0600`；Google OAuth 使用独立 PTY 启动 `NO_BROWSER=true gemini --skip-trust`，从 Gemini CLI 0.49.0 的终端输出捕获 Google 授权 URL，并在用户提交 authorization code 后等待凭据落盘、初始化该 profile 的 ACP runtime 并执行轻量 session 验证。Vertex AI 和 gateway 只有在 Web 侧受控配置表单可用后才启用。

AgentDeck session 是持久对话，Gemini profile 是下一轮任务使用的执行身份。切换默认 Gemini profile 后，已有 AgentDeck Gemini session 仍可继续发送；如果上游 ACP session 属于旧 profile，AgentDeck 会在新 profile 下重建上游 session，并使用本地可见历史续接。模型内部未展示状态不保证跨账户保留。

当前边界：

- Web gateway 重启不会杀死 runtime 内的 Gemini ACP 进程。
- runtime 整体重启不会承诺无损恢复正在运行的 Gemini turn。
- Gemini CLI 如果声明 `session/load`，AgentDeck 会尝试加载 provider session；失败时会新建 session，并提示上游会话已重建。
- Gemini CLI 当前没有稳定的可机读额度接口时，UI 会显示 unsupported，不伪造额度。

## 通用附件

附件通过 `multipart/form-data` 上传到 Web root 之外的 `attachments/` 目录。服务端使用随机内部 ID、metadata 和下载接口，不信任浏览器传来的路径、MIME、大小或文件名。

支持常见图片、文本、源码、PDF、Office Open XML 文档、ZIP/GZ 和未知二进制文件。图片会继续显示缩略图；PDF 和安全文本类型可预览；Office、压缩包和未知二进制默认按下载处理，并设置 `X-Content-Type-Options: nosniff`。

Provider 接收策略：

- Codex：图片保持原生本地图片输入；普通文件以受控本地路径和 metadata 放入 prompt。
- Gemini：优先通过 ACP resource link / image block 发送，具体取决于 initialize capabilities。
- Antigravity：保持独立 provider，不改造成 ACP；文件以本地路径提供给 CLI。

备份时除了 SQLite，也要备份 `attachments/` 目录。

## 生产部署

典型生产部署通常包含：

- 反向代理，例如 Nginx、Caddy 或 Traefik。
- 浏览器访问使用 HTTPS。
- 使用 systemd、Docker 或其他进程管理器。
- 环境变量文件放在 Git 工作树之外。
- runtime 默认只监听本机；如需非本机访问，必须配置 token。

WebSocket Origin 示例：

```bash
ALLOWED_ORIGINS=https://agentdeck.example.com
```

如果 runtime 必须监听非 loopback 地址，请在 runtime 和 Web gateway 两侧配置同一个 token：

```bash
RUNTIME_TOKEN=replace-with-random-token
AGENT_RUNTIME_TOKEN=replace-with-random-token
```

仓库在 `deploy/systemd/` 下提供通用 systemd unit 示例，默认形态如下：

```text
User=agentdeck
WorkingDirectory=/opt/agentdeck
EnvironmentFile=/etc/agentdeck/*.env
```

请根据自己的部署路径、用户和权限模型调整这些示例。

## 数据与备份

请备份配置的 `DATA_DIR`。重要文件和目录包括：

- `agentdeck.sqlite3`
- `agentdeck-runtime.sqlite3`
- 服务运行期间可能存在的 SQLite `-wal` 和 `-shm` 文件
- `profiles/`
- `gemini/profiles/`
- `antigravity-profiles/`
- `shared/sessions/`
- `shared/generated_images/`
- `attachments/`

备份数据库时建议使用 SQLite 的 `.backup` 命令，或先停止相关服务再复制数据库文件。环境文件和密钥不要提交到公开仓库。

## 安全

- 生产环境建议使用 HTTPS。
- 配置强随机且稳定的 `COOKIE_SECRET`。
- 不要公开 `ADMIN_PASSWORD`、`COOKIE_SECRET` 或 runtime token。
- runtime 默认应监听 `127.0.0.1`；如果改为非本机访问，必须配置 `RUNTIME_TOKEN`。
- 不要把 Codex app-server 直接暴露到公网。
- Codex 可能根据 sandbox 和 approval 设置读写工作区文件。
- 只把确实希望 AgentDeck 访问的目录加入 `ALLOWED_WORKSPACES`。

## 恢复行为

浏览器断线、页面刷新或 Web gateway 重启后，AgentDeck 可以补发已经成功持久化的事件。

runtime 或 Codex app-server 重启时，AgentDeck 会尝试重新连接并恢复已知会话。如果上游 thread 不存在，AgentDeck 可能创建替代 thread，并使用本地历史作为上下文继续。

高频流式 delta 会批量写入。在极端崩溃情况下，尚未持久化的流式片段可能丢失。

## Antigravity

AgentDeck 可以创建 Antigravity 会话、管理 Antigravity profiles、发送普通文本 prompt，并展示基础回复。

说明：

- Antigravity 支持基于可用 CLI 命令执行任务。
- 它不等同于 Codex runtime 的结构化流式会话。
- Antigravity 会话目前不保证图片输入、结构化工具调用、长任务恢复或完整上游连续会话能力。

## 开发

运行标准检查：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

常用开发命令：

```bash
npm run dev
npm run dev:runtime
npm run build:server
npm run build:client
```

## 常见问题

### WebSocket Origin 被拒绝

把浏览器页面的 Origin 加入 `ALLOWED_ORIGINS`。生产示例：

```bash
ALLOWED_ORIGINS=https://agentdeck.example.com
```

### runtime 无法连接

确认 runtime 进程正在运行，并且 `AGENT_RUNTIME_URL` 指向正确地址。如果设置了 `RUNTIME_TOKEN`，Web gateway 也需要配置相同值的 `AGENT_RUNTIME_TOKEN`。

### Codex app-server 没有启动

确认 Codex CLI 已安装，并且 `codex app-server` 可用。如果使用 systemd，请查看 app-server unit 日志。

### SQLite 权限错误

确认服务用户可以读写 `DATA_DIR`，包括 SQLite WAL 和 SHM 文件。

### 反向代理配置问题

确认反向代理转发 WebSocket upgrade，并保留正确的 `Host` 和 `Origin`。生产环境应配置有效 HTTPS 证书。

## License

当前仓库尚未包含 license 文件。
