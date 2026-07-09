# Security

AgentDeck is a self-hosted coding agent gateway. It is designed for localhost, LAN, VPN, Tailscale, Headscale, WireGuard, or a reverse proxy with an allowlist.

Do not expose an unprotected AgentDeck service directly to the public internet.

## Install Profiles

`personal` is the most convenient mode. It preserves the existing single-user workflow: the `ubuntu` run user, Codex `danger-full-access`, and `approval_policy=never` remain valid defaults. Use it only on trusted localhost, VPN, or private LAN networks.

`standard` is recommended for new self-hosted installs. It uses a dedicated `agentdeck` user by default and renders more conservative Codex settings while keeping normal setup simple.

`hardened` is for operators who are comfortable with Linux, systemd, and provider-specific tradeoffs. It starts from stricter defaults and is expected to require more explicit configuration.

Existing deployments are not silently migrated between profiles. In particular, upgrades do not change the run user, data directory, ports, Codex sandbox mode, or approval policy unless you explicitly set those variables.

## Origin And WebSocket Checks

HTTP state-changing requests validate `Origin` or `Referer`. WebSocket connections require a valid session cookie and a legal origin. If `ALLOWED_ORIGINS` is set, requests must match it.

For personal mode, leaving `ALLOWED_ORIGINS` unset keeps localhost, same-host, and VPN access compatible. For standard and hardened deployments, set it explicitly:

```bash
ALLOWED_ORIGINS=https://agentdeck.example.internal,http://100.64.0.10:3842
```

## Sessions

Browser cookies contain random session tokens only. Server-side sessions are stored as token hashes and can be revoked through logout or the session management API.

Changing `ADMIN_PASSWORD` revokes existing sessions.

## Secrets

Diagnostics and provider install logs are redacted before reaching the UI. The default backup excludes provider tokens, OAuth state, API keys, and profile secrets.

Use `AGENTDECK_ENABLE_VERBOSE_DIAGNOSTICS=1` only while debugging a trusted private deployment.

Use `agentdeckctl backup --include-secrets` only when you need a full credential-bearing migration backup. Treat that archive like a password vault.

