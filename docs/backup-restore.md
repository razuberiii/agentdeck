# 备份与恢复

AgentDeck 的持久状态由 SQLite 和 `DATA_DIR` 下的文件组成。现有部署默认使用 `/opt/data/agentdeck`。

## 创建备份

```bash
sudo agentdeckctl backup
```

备份写入 `/opt/data/agentdeck/backups/agentdeck-backup-YYYYMMDD-HHMMSS.tar.zst`，包含 Web 与 Runtime 数据库、附件、产物、生成图片、清单和脱敏环境摘要。

默认不包含 Provider Token、OAuth 状态、API Key 或账号密钥。只有完整迁移时才使用：

```bash
sudo agentdeckctl backup --include-secrets
```

## 恢复前检查

```bash
sudo agentdeckctl restore /path/to/agentdeck-backup.tar.zst --dry-run
```

确认清单、来源版本和目标路径后再恢复。真实恢复会覆盖数据，必须停止服务并显式传入 `--force`：

```bash
sudo systemctl stop agentdeck-web.service agentdeck-runtime.service
sudo agentdeckctl restore /path/to/agentdeck-backup.tar.zst --force
sudo systemctl start agentdeck-runtime.service agentdeck-web.service
```

恢复会拒绝路径穿越、链接、特殊文件、未在 manifest 声明的额外条目，并校验每个文件的类型、权限和 SHA-256，以及两个 SQLite 的 `integrity_check`。业务数据库、附件、产物、生成图片和 provider-tools 采用精确替换，因此归档中不存在的旧文件不会残留；可执行文件的执行位按 manifest 恢复。

不含 secrets 的归档会保留目标中已有的 `profiles`、`claude/profiles`、`gemini/profiles`、`antigravity-profiles` 和 `shared/sessions`，不会从归档混入凭据；dry-run 会明确显示这一策略。含 secrets 的归档则用归档内容替换这些管理路径。恢复支持原 DATA_DIR 不存在的空目标。

切换前会 Drain 并停止服务。启动或健康检查失败时会移回原数据目录；成功后输出 rollback snapshot 路径（空目标恢复则没有旧快照）。rollback snapshot 目前由维护者确认恢复稳定后手工清理。包含凭据的归档应加密保存并限制访问。
