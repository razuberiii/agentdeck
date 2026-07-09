# Troubleshooting

Start with read-only checks:

```bash
sudo agentdeckctl status
sudo agentdeckctl check
sudo agentdeckctl doctor
```

`check` is read-only. It does not install units, change ownership, edit env files, or restart services.

`doctor` is also read-only and prints suggested commands.

## systemd Units

Install or update units explicitly:

```bash
sudo agentdeckctl install-units
```

This prints the units being installed and key resolved settings such as `User`, `Group`, `HOME`, `WorkingDirectory`, `DATA_DIR`, and `ENV_DIR`.

## Deployment

Deploy does not silently install systemd units:

```bash
sudo agentdeckctl deploy all
```

If units are outdated, run `install-units` explicitly.

Runtime deploy waits for active turns when it can. `--wait` refuses to self-wait if the current agent is active; run without `--wait` for an async job or use `--force` only when interruption is acceptable.

## Logs

```bash
sudo journalctl -u agentdeck-web.service -n 200 --no-pager
sudo journalctl -u agentdeck-runtime.service -n 200 --no-pager
sudo agentdeckctl jobs
sudo agentdeckctl job <job-id>
```

Provider install logs shown in the UI are redacted, but avoid posting full raw system logs publicly without reviewing them.

## Network Access

Use localhost, LAN, VPN, Tailscale, Headscale, WireGuard, or a reverse proxy allowlist. If you configure `ALLOWED_ORIGINS`, include every URL you use to open AgentDeck.

