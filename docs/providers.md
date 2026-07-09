# Providers

AgentDeck presents multiple coding agents through one web gateway. Provider capability is not identical; check the Provider settings page after install for the current local status.

## Codex

Codex is the most complete integration. It supports persistent sessions, approvals, attachments, account selection, and app-server based execution.

Personal profile keeps Codex `danger-full-access` and `approval_policy=never` for the current smooth single-user workflow. Standard and hardened profiles render more conservative defaults unless overridden.

## Claude Code

Claude Code uses the official CLI login and Claude Agent SDK. Credentials live in provider profile state under `DATA_DIR` and are excluded from normal backups.

## Antigravity

Antigravity support depends on the installed upstream CLI. If `ANTIGRAVITY_BIN` is empty, AgentDeck discovers it from `PATH`, `DATA_DIR/provider-tools/bin`, and the service user's `$HOME/.local/bin`.

## Gemini CLI

Gemini CLI support is experimental. Personal Google login behavior depends on upstream support and may not be suitable as the primary provider.

## Installing Provider Tools

The UI can install supported provider CLIs into:

```text
DATA_DIR/provider-tools/bin
```

This keeps tools outside the Git worktree and makes systemd `PATH` consistent across web, runtime, and app-server units.

## Backups

Default backups include AgentDeck data, attachments, artifacts, and a redacted env summary. Provider tokens and OAuth secrets are not included unless `--include-secrets` is passed.

