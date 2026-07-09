# Backup And Restore

AgentDeck stores the important self-hosted state in SQLite plus files under `DATA_DIR`.

The default data directory for existing deployments is:

```text
/opt/data/agentdeck
```

## Create A Backup

```bash
sudo agentdeckctl backup
```

The archive is written to:

```text
/opt/data/agentdeck/backups/agentdeck-backup-YYYYMMDD-HHMMSS.tar.zst
```

Each archive contains:

- `agentdeck.sqlite3`
- `agentdeck-runtime.sqlite3`
- `attachments/`
- `artifacts/` when present
- `shared/generated_images/` when present
- `manifest.json`
- `redacted-env-summary.json`

The manifest includes version, commit, creation time, install profile, data directory, and whether secrets were included.

## Secrets

By default, backups do not include provider tokens, OAuth state, API keys, or profile secrets.

To create a credential-bearing migration backup:

```bash
sudo agentdeckctl backup --include-secrets
```

This prints a warning. Store the archive like a password vault.

## Restore Dry Run

Always inspect an archive before restoring:

```bash
sudo agentdeckctl restore /opt/data/agentdeck/backups/agentdeck-backup-YYYYMMDD-HHMMSS.tar.zst --dry-run
```

Dry run prints the manifest and the paths that would be restored.

## Restore

Stop AgentDeck services before restoring data on a real server.

```bash
sudo systemctl stop agentdeck-web.service agentdeck-runtime.service
sudo agentdeckctl restore /opt/data/agentdeck/backups/agentdeck-backup-YYYYMMDD-HHMMSS.tar.zst --force
sudo systemctl start agentdeck-runtime.service agentdeck-web.service
```

Restore refuses to overwrite existing target data unless `--force` is provided.

