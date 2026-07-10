# Provider

AgentDeck 在同一个工作台中接入多个编码 Agent，但不会假装它们能力完全一致。界面以 `ProviderStatus` 返回的真实能力决定哪些操作可用。

## Codex

支持持久会话、权限审批、附件、多账号、额度读取和 app-server 执行。每个账号拥有独立的进程绑定，切换账号后下一次 Turn 使用当前账号，不会静默回退到旧账号。

## Claude Code

使用官方 CLI 登录和 Anthropic Agent SDK。支持会话延续与文件操作；模型、额度等能力以本机 SDK 和账号实际返回为准。

## Antigravity

依赖本机安装的上游 CLI。未设置 `ANTIGRAVITY_BIN` 时，会从 `PATH`、`DATA_DIR/provider-tools/bin` 和运行用户的本地 bin 目录寻找。

## Gemini CLI

通过 ACP 接入。个人 Google 登录是否可创建新会话取决于上游客户端支持；“已认证但客户端不支持”会显示为能力不可用，而不是错误地显示为未登录。

## 安装 Provider 工具

界面可把受支持的 CLI 安装到：

```text
DATA_DIR/provider-tools/bin
```

该目录位于 Git 工作区之外，并加入 Web、Runtime 和 Provider unit 的 `PATH`。Provider 凭据默认不进入普通备份，完整迁移时才使用 `--include-secrets`。
