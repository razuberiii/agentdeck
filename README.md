# AgentDeck

AgentDeck 是一个自托管的 agent workbench，用来在浏览器里持续使用 Codex、Gemini 和 Antigravity。

它不是单纯的 ChatGPT 皮肤。AgentDeck 关心的是 coding agent 真正在本机项目里工作时会遇到的那些事：会话要能继续，事件要能回放，账户和 profile 要分清，附件和生成文件要能落盘，Web 服务重启也不应该轻易打断正在跑的任务。

你可以把它放在自己的机器或服务器上，然后用桌面浏览器、手机浏览器或 PWA 接进去，继续同一个 session。

## 为什么会有它

普通 AI Chat UI 通常更关注模型列表、聊天记录和知识库。AgentDeck 更偏向“把 coding agent 跑稳”：

- 在浏览器或 PWA 里使用本机 Codex app-server。
- 用一个长期运行的 runtime 管住 provider 进程、会话状态和事件序列。
- 把会话绑定到项目目录，查看 diff，下载本轮生成的产物。
- 管理多个 Codex、Gemini、Antigravity 账户和 profile，避免下一轮任务用错身份。
- 页面刷新、网络断开或 Web gateway 重启后，补发已经持久化的事件。
- 上传图片和文件附件，并按不同 provider 的能力转给上游 agent。
- 通过 Web 入口远程查看和继续任务，而不是把 provider 进程直接暴露到公网。

## 当前能力

AgentDeck 现在包含三类 provider：

- **Codex**：通过 `codex app-server` 运行，支持多 profile、模型选择、沙盒/审批模式、会话恢复、图片输入、项目 diff 和产物下载。
- **Gemini**：通过 Gemini CLI 的 ACP 模式运行，支持多 Gemini profile、Google OAuth、API Key、模型发现、附件 resource link，以及 runtime 内的长期 ACP 进程。
- **Antigravity**：可选 provider，用本地 `agy` CLI 执行基础文本任务。它目前不是完整的结构化 runtime provider，不承诺图片输入、长任务恢复或完整上游连续会话。

其他核心功能：

- 会话列表、重命名、归档、删除。
- WebSocket 流式事件和 runtime 事件回放。
- 登录、CSRF、Origin 校验和基础 rate limit。
- 附件上传、预览、下载和安全 MIME 处理。
- 生成图片、产物文件和 changed artifact 持久化。
- PWA manifest、service worker 和移动端优先界面。
- systemd 示例、检查脚本、部署脚本和手动备份脚本。

## 架构

```text
Browser / PWA
  -> Web gateway
  -> AgentDeck runtime
  -> Codex app-server / Gemini ACP / Antigravity CLI
```

Web gateway 负责浏览器侧的事情：登录、Cookie、CSRF、Origin、静态资源、WebSocket、上传下载和 API。Runtime 负责执行侧的事情：会话状态、turn 状态、provider thread ID、事件序列、Codex app-server 生命周期、Gemini ACP 进程和账户绑定。

这个边界很重要。浏览器和 Web 可以展示状态，但真正决定一个 session 是否还在跑、下一轮用哪个账户执行、哪些事件已经持久化的是 runtime。

更多设计背景见 [docs/architecture.md](docs/architecture.md) 和 [docs/adr](docs/adr)。

## 环境要求

- Node.js 20+，推荐 Node.js 22 LTS。
- npm。
- SQLite。
- OpenAI Codex CLI，并且可用 `codex app-server`。
- 可选：Gemini CLI `@google/gemini-cli`，并且可用 `gemini --acp`。
- 可选：Google Antigravity CLI `agy`。
- 生产环境推荐 Linux + systemd；其他进程管理器也可以，只要分别跑 Web 和 runtime。

## 本地启动

安装依赖并构建：

```bash
npm install
npm run build
```

先启动 runtime：

```bash
DATA_DIR=.data \
RUNTIME_HOST=127.0.0.1 \
RUNTIME_PORT=3852 \
npm run runtime
```

再开一个终端启动 Web gateway：

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

开发时可以用源码入口：

```bash
npm run dev
npm run dev:runtime
```

## 配置

常用环境变量如下。生产环境建议把 Web 和 runtime 的 env 分开管理，不要把密钥放进 Git 仓库。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Web gateway 监听地址。 |
| `PORT` | `3842` | Web gateway 监听端口。 |
| `DATA_DIR` | `/var/lib/agentdeck` | 主数据目录，保存 SQLite、profiles、附件和生成文件。 |
| `ADMIN_PASSWORD` | 无 | 初始管理员密码，生产环境必须设置。 |
| `COOKIE_SECRET` | 启动时生成 | Cookie 签名密钥，生产环境必须设置为稳定随机值。 |
| `ALLOWED_ORIGINS` | `http://localhost:3842,http://127.0.0.1:3842` | 允许访问 WebSocket 的浏览器 Origin。 |
| `USE_AGENT_RUNTIME` | 未启用 | 设置为 `1` 后使用持久 runtime。 |
| `AGENT_RUNTIME_URL` | `http://127.0.0.1:3852` | Web gateway 调用 runtime 的地址。 |
| `AGENT_RUNTIME_TOKEN` | 未设置 | runtime 开启 token 时，Web 使用的 Bearer token。 |
| `RUNTIME_HOST` | `127.0.0.1` | runtime 监听地址。 |
| `RUNTIME_PORT` | `3852` | runtime 监听端口。 |
| `RUNTIME_TOKEN` | 未设置 | runtime 监听非 loopback 地址时必须设置。 |
| `RUNTIME_DB` | `$DATA_DIR/agentdeck-runtime.sqlite3` | runtime SQLite 数据库路径。 |
| `CODEX_HOME` | `$HOME/.codex` | 默认 Codex 配置目录。 |
| `ALLOWED_WORKSPACES` | 当前目录和 `/opt/projects` | UI 中允许选择的项目根目录，多个路径用逗号分隔。 |
| `GEMINI_BIN` | `/usr/bin/gemini` | Gemini CLI 路径。 |
| `GEMINI_ACP_ARGS` | `--acp` | Gemini ACP 启动参数。 |
| `GEMINI_PROFILE_ROOT` | `$DATA_DIR/gemini/profiles/default` | Gemini 默认 profile 根目录。 |
| `ANTIGRAVITY_BIN` | `agy` | Antigravity CLI 路径。 |
| `MAX_ATTACHMENT_BYTES` | `33554432` | 单个附件大小上限。 |
| `MAX_ATTACHMENTS_PER_MESSAGE` | `10` | 单条消息附件数量上限。 |
| `MAX_TOTAL_ATTACHMENT_BYTES` | `67108864` | 单条消息附件总大小建议上限。 |

生产域名示例：

```bash
ALLOWED_ORIGINS=https://agentdeck.example.com
```

如果 runtime 必须监听非本机地址，Web 和 runtime 两侧要配置同一个 token：

```bash
RUNTIME_TOKEN=replace-with-random-token
AGENT_RUNTIME_TOKEN=replace-with-random-token
```

## Gemini Provider

安装 Gemini CLI：

```bash
npm install -g @google/gemini-cli
gemini --version
gemini --help
```

AgentDeck runtime 会用 `gemini --acp` 启动长期子进程。每个 Gemini profile 都有独立的 `HOME` 和 `GEMINI_CONFIG_DIR`，默认目录类似：

```text
/var/lib/agentdeck/gemini/profiles/default
```

Web 登录支持 Google OAuth 和 Gemini API Key。API Key 只写入当前 profile 的私有 `agentdeck.env`，文件权限为 `0600`。OAuth 会在一个独立 PTY 中启动 Gemini CLI，捕获 Google 授权 URL，用户提交 authorization code 后再等待凭据落盘并初始化该 profile。

AgentDeck session 是本地持久对话；Gemini profile 是下一轮任务使用的执行身份。切换默认 Gemini profile 不会删除已有 session。如果继续旧 session 时上游 ACP session 属于旧 profile，AgentDeck 会在新 profile 下重建上游 session，并用本地可见历史续接。

需要注意的边界：

- Web gateway 重启不会杀死 runtime 里的 Gemini ACP 进程。
- runtime 整体重启不承诺无损恢复正在运行的 Gemini turn。
- Gemini CLI 如果声明 `session/load`，AgentDeck 会尝试加载上游 session；失败时会新建 session。
- Gemini CLI 没有稳定额度接口时，UI 会显示 unsupported，不会伪造额度。

## 附件和产物

附件通过 `multipart/form-data` 上传到 Web root 之外的 `attachments/` 目录。服务端会生成随机内部 ID，并保存 metadata；它不会信任浏览器传来的路径、MIME、大小或文件名。

支持常见图片、文本、源码、PDF、Office Open XML 文档、ZIP/GZ 和未知二进制文件。图片会显示缩略图；PDF 和安全文本类型可以预览；Office、压缩包和未知二进制默认按下载处理，并设置 `X-Content-Type-Options: nosniff`。

provider 输入策略：

- Codex：图片保持原生本地图片输入；普通文件以受控本地路径和 metadata 放入 prompt。
- Gemini：优先通过 ACP resource link / image block 发送，具体取决于 initialize capabilities。
- Antigravity：作为独立 CLI provider，文件以本地路径说明传入。

产物文件按 turn 记录。Web 会在 turn 前记录项目 manifest，turn 后比较路径、大小和内容 hash，只把变化文件持久化为 artifacts。

## 生产部署

仓库提供 systemd unit 示例：

```text
deploy/systemd/agentdeck-web.service
deploy/systemd/agentdeck-runtime.service
deploy/systemd/agentdeck-app-server@.service
deploy/systemd/env/*.env.example
```

典型生产部署包含：

- 反向代理，例如 Nginx、Caddy 或 Traefik。
- HTTPS。
- `DATA_DIR` 放在 Git 工作树之外。
- Web、runtime、provider 使用单独的 env 文件。
- runtime 默认只监听 `127.0.0.1`；如果跨机器访问必须加 token。

安装或渲染 systemd unit 前，先根据自己的路径、用户和权限模型调整 env。仓库里的默认示例假设：

```text
WorkingDirectory=/opt/stacks/agentdeck
EnvironmentFile=/etc/agentdeck/*.env 或 /opt/data/agentdeck/*.env
```

部署脚本支持先检查、再按组件发布：

```bash
scripts/deploy.sh --check
scripts/deploy.sh --deploy --components web
scripts/deploy.sh --deploy --components runtime
scripts/deploy.sh --deploy --components web,runtime
scripts/deploy.sh --deploy --changed
```

runtime 发布会先进入 draining，拒绝新 turn，等待正在提交和正在运行的 turn 以及事件写入完成后再重启。provider 进程不会因为 Web 或 runtime 发布而默认重启；要重启指定 Codex profile，需要显式指定：

```bash
scripts/deploy.sh --deploy --components provider:codex:default
```

## 数据和备份

AgentDeck 不会自动备份。仓库里的 [scripts/backup.sh](scripts/backup.sh) 是手动工具；你想备份时自己跑，不想备份可以不管它。

通常备份整个 `DATA_DIR` 就够了，重点包括：

- `agentdeck.sqlite3`
- `agentdeck-runtime.sqlite3`
- SQLite `-wal` 和 `-shm` 文件
- `profiles/`
- `gemini/profiles/`
- `antigravity-profiles/`
- `shared/sessions/`
- `shared/generated_images/`
- `attachments/`

手动备份示例：

```bash
DATA_DIR=/opt/data/agentdeck \
BACKUP_DIR=/opt/data/agentdeck/backups \
/opt/stacks/agentdeck/scripts/backup.sh
```

脚本会生成 `agentdeck-YYYYMMDD.tar.gz`，并只保留最近 7 个 `agentdeck-*.tar.gz`。如果要定时备份，请自己加 cron 或 systemd timer。备份 SQLite 时建议用 SQLite `.backup`，或者先停相关服务再复制数据库文件。

## 安全建议

- 生产环境使用 HTTPS。
- 设置强随机、稳定的 `COOKIE_SECRET`。
- 不要泄露 `ADMIN_PASSWORD`、`COOKIE_SECRET`、`RUNTIME_TOKEN` 或 provider 凭据。
- 不要把 Codex app-server 直接暴露到公网。
- runtime 尽量只监听 `127.0.0.1`。
- 只把确实希望 AgentDeck 访问的目录加入 `ALLOWED_WORKSPACES`。
- 记住 Codex、Gemini、Antigravity 都可能按各自 sandbox 和 approval 设置读写工作区文件。

## 恢复行为

浏览器断线、页面刷新或 Web gateway 重启后，AgentDeck 会尽量补发已经持久化的 runtime 事件。

runtime 或 provider 进程重启时，AgentDeck 会尝试重新连接并恢复已知 session。如果上游 thread 不存在，它可能创建替代 thread，并使用本地可见历史继续。高频 streaming delta 会批量写入；极端崩溃时，尚未持久化的片段可能丢失。

## 开发

常用命令：

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

拆开跑：

```bash
npm run build:server
npm run build:client
npm run dev
npm run dev:runtime
```

项目主要目录：

```text
client/      React + Vite PWA
server/      Fastify Web gateway 和 AgentDeck runtime
deploy/      systemd、检查、cutover、rollback 脚本
docs/        架构文档和 ADR
scripts/     备份、部署和迁移辅助脚本
tests/       Node test runner 测试
```

## 常见问题

### WebSocket Origin 被拒绝

把浏览器页面的 Origin 加入 `ALLOWED_ORIGINS`。例如：

```bash
ALLOWED_ORIGINS=https://agentdeck.example.com
```

### runtime 连不上

确认 runtime 正在运行，`AGENT_RUNTIME_URL` 指向正确地址。如果配置了 `RUNTIME_TOKEN`，Web gateway 也要配置相同值的 `AGENT_RUNTIME_TOKEN`。

### Codex app-server 没有启动

确认 Codex CLI 已安装，并且 `codex app-server` 可用。如果使用 systemd，请查看 `agentdeck-app-server@<profile>.service` 的日志。

### SQLite 权限错误

确认运行服务的用户可以读写 `DATA_DIR`，包括 SQLite 的 WAL 和 SHM 文件。

### 反向代理后不能连接

确认反向代理转发 WebSocket upgrade，并保留正确的 `Host` 和 `Origin`。生产环境请配置有效 HTTPS 证书。

## License

当前仓库尚未包含 license 文件。
