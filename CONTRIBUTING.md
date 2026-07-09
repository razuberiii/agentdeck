# Contributing

AgentDeck is a self-hosted coding agent gateway. Contributions should keep the project easy to install, easy to recover, and predictable for existing personal deployments.

## Development

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

## Change Guidelines

- Keep changes small and scoped.
- Do not silently change existing systemd users, ports, data directories, Codex sandbox mode, or approval policy.
- Keep stricter security behavior profile-based.
- `agentdeckctl check` and `doctor` must remain read-only.
- `agentdeckctl deploy` must not install systemd units.
- `agentdeckctl install-units` is the command that writes systemd units.
- Add or update tests for behavior changes.

## Documentation

Update the relevant file in `docs/` for install, security, providers, backup/restore, or troubleshooting changes.

