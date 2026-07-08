# Install

AgentDeck is a self-hosted coding agent gateway. The recommended deployment is localhost, LAN, VPN, Tailscale, Headscale, or WireGuard. Do not expose an unprotected AgentDeck service directly to the public internet.

## Profiles

Set `AGENTDECK_INSTALL_PROFILE` when running the installer:

```bash
sudo AGENTDECK_INSTALL_PROFILE=personal ./install.sh
sudo AGENTDECK_INSTALL_PROFILE=standard ./install.sh
```

`personal` keeps the existing single-user experience. It defaults to the `ubuntu` service user, Codex `approval_policy=never`, and Codex `sandbox_mode=danger-full-access`. Use it for trusted localhost, VPN, or LAN deployments where convenience is the priority.

`standard` is recommended for new installs. It defaults to a dedicated `agentdeck` system user unless you set `AGENTDECK_RUN_USER`, and renders Codex with `approval_policy=on-request` and `sandbox_mode=workspace-write`.

`hardened` is for operators who understand Linux and systemd hardening tradeoffs. The initial framework uses the dedicated service user defaults and renders Codex with `approval_policy=on-request` and `sandbox_mode=read-only`.

Existing deployments are not forced to migrate. If the installer sees an existing unit using `ubuntu` or `danger-full-access`, it keeps `personal` unless you explicitly set another profile.

## Custom Paths And Users

The systemd units are rendered from templates. These variables can be set during install:

```bash
sudo AGENTDECK_INSTALL_PROFILE=standard \
  AGENTDECK_RUN_USER=agentdeck \
  AGENTDECK_RUN_GROUP=agentdeck \
  AGENTDECK_HOME=/var/lib/agentdeck \
  AGENTDECK_DATA_DIR=/opt/data/agentdeck \
  AGENTDECK_CURRENT_DIR=/opt/stacks/agentdeck/current \
  AGENTDECK_ENV_DIR=/etc/agentdeck \
  ./install.sh
```

Personal mode keeps the old defaults unless you override them.
