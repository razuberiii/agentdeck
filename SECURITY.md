# Security Policy

AgentDeck is intended for self-hosted use behind localhost, LAN, VPN, Tailscale, Headscale, WireGuard, or a reverse proxy allowlist.

Do not expose an unprotected AgentDeck instance directly to the public internet.

## Reporting A Vulnerability

If you find a vulnerability, please open a GitHub security advisory or contact the maintainers privately before publishing details.

Include:

- affected version or commit
- deployment profile
- impact
- reproduction steps
- whether provider credentials, sessions, or project files are exposed

## Supported Defaults

Personal mode prioritizes ease of use for trusted private networks. Standard mode is recommended for new users. Hardened mode is for operators who want stricter defaults and understand the operational tradeoffs.

Security fixes should preserve existing personal deployments unless a change is explicitly documented as breaking.

