# AgentDeck

AgentDeck is a self-hosted web and mobile PWA client for running Codex sessions through a persistent runtime.

## Features

- Codex Web / PWA client for desktop and mobile browsers.
- Multiple Codex profiles and account switching.
- Session list, session history, rename, archive, fork, and delete actions.
- Persistent AgentDeck runtime for session metadata and event storage.
- Event replay after page refresh, browser reconnect, or Web gateway restart.
- File and image attachment upload for supported providers.
- Project diff view and generated artifact download.
- Optional Google Antigravity provider support for basic text tasks.
- Mobile-first interface with installable PWA assets.

## Architecture

```text
Browser / PWA
  -> Web gateway
  -> AgentDeck runtime
  -> Codex app-server
```

- **Browser / PWA**: Loads session snapshots, joins sessions over WebSocket, sends messages, and renders streamed events.
- **Web gateway**: Fastify API and WebSocket server for auth, CSRF checks, Origin checks, session indexing, attachments, artifacts, and runtime subscriptions.
- **AgentDeck runtime**: Long-running service that stores runtime sessions and events in SQLite, manages Codex account runtimes, and exposes SSE streams to the Web gateway.
- **Codex app-server**: Codex CLI app-server process used by the runtime for JSON-RPC calls.

## Requirements

- Node.js 18 or newer.
- npm.
- SQLite.
- OpenAI Codex CLI with `codex app-server` support.
- Linux for the included systemd examples. Other process managers can be used if they run the same Web and runtime entry points.

## Quick Start

Install dependencies:

```bash
npm install
```

Build the server and client:

```bash
npm run build
```

Start the runtime:

```bash
DATA_DIR=.data \
RUNTIME_HOST=127.0.0.1 \
RUNTIME_PORT=3852 \
npm run runtime
```

Start the Web gateway in another shell:

```bash
DATA_DIR=.data \
USE_AGENT_RUNTIME=1 \
AGENT_RUNTIME_URL=http://127.0.0.1:3852 \
ALLOWED_ORIGINS=http://localhost:3842,http://127.0.0.1:3842 \
ADMIN_PASSWORD='change-me-at-least-12-chars' \
COOKIE_SECRET='change-me-random-32-bytes' \
npm start
```

Open:

```text
http://127.0.0.1:3842
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Web gateway listen host. |
| `PORT` | `3842` | Web gateway listen port. |
| `DATA_DIR` | `/var/lib/agentdeck` | Main data directory for Web state, uploads, profiles, and SQLite files. |
| `ADMIN_PASSWORD` | none | Initial admin login password. Set this in production. |
| `COOKIE_SECRET` | generated at process start | Cookie signing secret. Set a stable random value in production. |
| `ALLOWED_ORIGINS` | `http://localhost:3842,http://127.0.0.1:3842` | Browser WebSocket Origin allowlist. Example: `ALLOWED_ORIGINS=https://agentdeck.example.com`. |
| `USE_AGENT_RUNTIME` | unset | Set to `1` to route Codex sessions through the persistent runtime. |
| `AGENT_RUNTIME_URL` | `http://127.0.0.1:3852` | URL the Web gateway uses to call the runtime. |
| `AGENT_RUNTIME_TOKEN` | unset | Bearer token used by the Web gateway when the runtime requires one. |
| `RUNTIME_HOST` | `127.0.0.1` | Runtime listen host. |
| `RUNTIME_PORT` | `3852` | Runtime listen port. |
| `RUNTIME_TOKEN` | unset | Required when `RUNTIME_HOST` is not loopback. |
| `RUNTIME_DB` | `$DATA_DIR/agentdeck-runtime.sqlite3` | Runtime SQLite database path. |
| `CODEX_HOME` | `$HOME/.codex` | Codex profile/config directory. |
| `ALLOWED_WORKSPACES` | current working directory and `/opt/projects` | Comma-separated workspace roots shown in the UI. |
| `ANTIGRAVITY_BIN` | `agy` | Optional Antigravity CLI command path. |

## Production Deployment

A typical production deployment uses:

- A reverse proxy such as Nginx, Caddy, or Traefik.
- HTTPS for browser access.
- A process manager such as systemd, Docker, or another supervisor.
- Environment files outside the Git working tree.
- Runtime bound to loopback unless a token is configured.

Example WebSocket Origin configuration:

```bash
ALLOWED_ORIGINS=https://agentdeck.example.com
```

If the runtime must listen on a non-loopback interface, configure a token on both services:

```bash
RUNTIME_TOKEN=replace-with-random-token
AGENT_RUNTIME_TOKEN=replace-with-random-token
```

The repository includes generic systemd unit examples under `deploy/systemd/`. They use:

```text
User=agentdeck
WorkingDirectory=/opt/agentdeck
EnvironmentFile=/etc/agentdeck/*.env
```

Adjust paths, user names, and permissions for your deployment.

## Data and Backup

Back up the configured `DATA_DIR`. Important files and directories include:

- `agentdeck.sqlite3`
- `agentdeck-runtime.sqlite3`
- SQLite `-wal` and `-shm` files when services are running
- `profiles/`
- `antigravity-profiles/`
- `shared/sessions/`
- `shared/generated_images/`
- `attachments/`

Use SQLite's `.backup` command or stop the services before copying database files. Keep environment files and secrets out of public repositories.

## Security

- Use HTTPS in production.
- Set a strong, stable `COOKIE_SECRET`.
- Keep `ADMIN_PASSWORD`, `COOKIE_SECRET`, and runtime tokens private.
- Keep the runtime on `127.0.0.1` unless you have configured `RUNTIME_TOKEN`.
- Do not expose Codex app-server directly to the public internet.
- Codex may be able to read or write files inside configured workspaces depending on its sandbox and approval settings.
- Restrict `ALLOWED_WORKSPACES` to directories you intend AgentDeck to access.

## Recovery Behavior

AgentDeck can replay events that have already been persisted when a browser disconnects, a page refreshes, or the Web gateway restarts.

When the runtime or Codex app-server restarts, AgentDeck attempts to reconnect and resume known sessions. If an upstream thread no longer exists, AgentDeck may create a replacement thread and continue with local history as context.

High-frequency streaming deltas are batched. In an extreme crash, stream fragments that were not yet persisted may be lost.

## Antigravity

AgentDeck can create Antigravity sessions, manage Antigravity profiles, send plain text prompts, and display basic replies.

Notes:

- Antigravity support uses the available CLI command as a task runner.
- It is not equivalent to Codex runtime streaming.
- Image input, structured tool calls, long-running recovery, and full upstream conversational continuity are not currently guaranteed for Antigravity sessions.

## Development

Run the standard checks:

```bash
npm install
npm run build
npm run typecheck
npm run lint
npm test
npm run test:e2e
```

Useful development commands:

```bash
npm run dev
npm run dev:runtime
npm run build:server
npm run build:client
```

## Troubleshooting

### WebSocket Origin Rejected

Add the browser page origin to `ALLOWED_ORIGINS`. For production:

```bash
ALLOWED_ORIGINS=https://agentdeck.example.com
```

### Runtime Cannot Connect

Check that the runtime process is running and that `AGENT_RUNTIME_URL` points to it. If `RUNTIME_TOKEN` is set, configure the same value as `AGENT_RUNTIME_TOKEN` for the Web gateway.

### Codex app-server Is Not Running

Confirm the Codex CLI is installed and that `codex app-server` works. If using systemd, inspect the app-server unit logs.

### SQLite Permission Errors

Ensure the service user can read and write `DATA_DIR`, including SQLite WAL and SHM files.

### Reverse Proxy Issues

Ensure the proxy forwards WebSocket upgrades, preserves the correct `Host` and `Origin`, and serves HTTPS with a valid certificate.

## License

No license file is currently included.
