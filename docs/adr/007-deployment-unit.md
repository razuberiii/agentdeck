# ADR 007：部署边界

## 状态

已采纳。

## 决策

部署通过 `scripts/deploy.sh` 执行完整检查。`--check` 不重启服务；`--deploy --components ...` 可以只切换 Web、Runtime 或指定 Provider。Runtime 发布先进入 draining，拒绝新任务并等待现有 Turn 和事件写入完成，再重启并验证健康状态。

## 原因

手工分别重启可能中断当前会话，并让 Web 与 Runtime 版本错配。按组件发布可以避免无关 Provider 被重启。

## 影响

Codex app-server 默认不随 Web 或 Runtime 重启；重启 Provider 必须显式指定 `provider:<name>:<profileId>`。备份写入 `/opt/data/agentdeck/backups/`，不进入 Git 工作区。
