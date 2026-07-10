# AgentDeck 架构

```text
浏览器
  │ HTTP / WebSocket / 上传
  ▼
Web 服务
  │ Runtime HTTP / SSE
  ▼
Runtime
  │ Provider 协议
  ▼
Codex app-server / Claude Agent SDK / Antigravity CLI / Gemini ACP
```

Web 负责 AgentDeck 登录、CSRF 与来源校验、文件传输、静态资源和浏览器事件转发。Runtime 是执行状态的唯一事实来源，负责会话、Turn、Provider 线程、事件序列、进程生命周期和实际执行账号。

## 消息流

1. 浏览器通过 WebSocket 发送用户消息。
2. Web 校验请求并转交 Runtime。
3. Runtime 校验当前 Provider 账号，记录执行账号，再发起 Turn。
4. Provider 事件先由 Runtime 持久化，再通过 SSE 送到 Web。
5. Web 转发给订阅浏览器，浏览器按序列应用并去重。
6. Turn 结束后，浏览器用权威快照收口实时事件。

用户消息只持久化用户实际输入和结构化附件。Adapter 可以临时生成带资源引用的 Provider 输入，但不会把服务器绝对路径或内部提示写回对话历史。

文件产物归属于创建或修改它的 Turn。执行前后通过路径、大小和内容哈希比较，只登记真实变化的文件；读取历史会话时使用已持久化清单，不重新扫描并伪造旧产物。

## 状态归属

### Runtime 负责

- 会话运行状态、活动 Turn 和交互等待状态。
- Provider 会话或线程 ID、模型和能力。
- 创建账号、选择账号、执行账号与上游绑定账号。
- Runtime 事件、最新序列与产物清单。
- Codex app-server 的 unit、端点和账号归属。
- 生命周期：starting、accepting、draining、stopping。

### Web 负责

- AgentDeck 自身的登录会话。
- CSRF、Origin 和 WebSocket 来源策略。
- 上传元数据、静态文件和浏览器订阅。
- 不影响执行语义的界面设置。

### 只读镜像与兼容字段

Web 可以镜像会话行用于列表与迁移，但不能用它决定执行状态。浏览器快照只是视图。历史遗留的 Web 运行状态和 Provider 就绪推断只为兼容保留，不得驱动执行。

## 快照、事件与重连

系统区分 `runtimeLatestSequence`、`snapshotCoveredSequence`、`browserAppliedSequence` 和 `browserAcknowledgedSequence`。重连携带浏览器真正应用过的序列，缺失事件由 Web 和 Runtime 重放。重复投递可以去重，永久丢失不可以接受。

## 账号与会话

AgentDeck 会话不永久属于某个 Provider 账号。每个 Turn 单独记录实际消耗额度的执行账号。切换账号会影响下一次执行，但不会删除本地历史，也不会静默回退到旧账号。

## Provider 边界

- Gemini 账号可以已认证但因上游客户端限制而不能创建会话，此时返回 `gemini_client_unsupported` 和 `canCreateSession=false`，不能误报为未登录。
- Claude Code 通过官方 Agent SDK 的 `query()` 与 `claude_code` preset 执行，并保存上游 session ID。Runtime 崩溃时会把活动 Turn 标记为中断，不承诺 Provider 侧任务无损续跑。
- Provider 密钥存放在 `DATA_DIR` 的受限目录，不进入普通 SQLite 字段或浏览器事件。

## 部署边界

Provider 进程默认独立于 Web 和 Runtime 发布。Web-only 发布不会重启 Runtime；Runtime 发布先进入 draining，等待活动 Turn、提交过程和事件写入结束。Provider 只有在显式指定 `provider:<name>:<profileId>` 时才重启。

备份位于 `/opt/data/agentdeck/backups/`，不进入 Git 工作区。
