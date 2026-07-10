# AgentDeck 文档

这里放的是安装、运维和内部设计说明。第一次使用只需要阅读项目根目录的 [README](../README.md)；遇到具体问题时再进入对应章节。

## 使用与运维

- [安装与升级](install.md)：安装档位、运行用户和目录配置。
- [Provider](providers.md)：Codex、Claude Code、Antigravity 与 Gemini 的能力边界。
- [安全](security.md)：网络暴露、会话、凭据和权限建议。
- [备份与恢复](backup-restore.md)：备份内容、敏感信息与恢复流程。
- [故障排查](troubleshooting.md)：只读检查、日志与部署问题。

## 内部设计

- [系统架构](architecture.md)：浏览器、Web、Runtime 和 Provider 的职责。
- [架构决策记录](adr/)：解释关键约束为何存在，主要面向维护者。

文档描述的是当前代码，而不是开发计划。行为变化时，应在同一个提交中更新对应文档。
