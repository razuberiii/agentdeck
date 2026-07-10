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

恢复前保留目标机器当前备份；包含凭据的归档应加密保存并限制访问。
