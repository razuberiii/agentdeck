# Agent Deck

Agent Deck is a phone-friendly web app for using local agent CLIs from a browser. It runs a Fastify server in front of `codex app-server` and supported agent providers, serves a React PWA, and keeps sessions, uploads, generated images, and downloadable artifacts easy to reach from mobile.

## What It Does

- Opens and resumes Codex sessions from a mobile chat UI.
- Switches between Codex account profiles.
- Scans allowed workspace roots and starts sessions in selected projects.
- Supports image uploads and generated image previews.
- Exposes common session actions: stop, diff, rename, fork, archive, and delete.
- Shows approval prompts for restricted modes and sends the decision back to Codex.
- Provides installable PWA assets for quick access from a phone.

## Project Layout

- `client/src/main.tsx` - React application.
- `client/src/styles.css` - mobile UI styles.
- `client/public/` - manifest, service worker, icons, and static assets.
- `server/src/index.ts` - Fastify API, websocket server, session indexing, uploads, and artifact handling.
- `server/src/codex.ts` - JSON-RPC bridge to `codex app-server`.
- `server/src/workspaces.ts` - workspace validation and project scanning.
- `server/src/db.ts` - SQLite helper.

## Requirements

- Node.js 20 or newer.
- SQLite available on the host.
- OpenAI Codex CLI installed as `codex`.
- A writable runtime data directory. The default is `/opt/data/agentdeck`.

## Configuration

The app reads configuration from environment variables. The current systemd deployment also loads:

```text
/opt/data/agentdeck/.env
```

Common settings:

- `ADMIN_PASSWORD` - initial admin password, required before the first login.
- `COOKIE_SECRET` - stable secret used to sign cookies.
- `DATA_DIR` - runtime data directory. Defaults to `/opt/data/agentdeck`.
- `CODEX_HOME` - initial Codex home. Defaults to `/home/ubuntu/.codex`.
- `HOST` - bind address. Defaults to `127.0.0.1`.
- `PORT` - bind port. Defaults to `3842`.
- `ALLOWED_WORKSPACES` - comma-separated workspace roots the app may open.
- `ALLOWED_ORIGINS` - comma-separated origins allowed to connect to the websocket.

## Development

Install dependencies:

```bash
npm install
```

Run the TypeScript server directly:

```bash
npm run dev
```

Build the server and client:

```bash
npm run build
```

Start the built server:

```bash
npm start
```

## Deployment

This repository is deployed as three systemd services on the current host:

```bash
sudo systemctl restart agentdeck-app-server@default.service
sudo systemctl restart agentdeck-runtime.service
sudo systemctl restart agentdeck-web.service
sudo systemctl status agentdeck-app-server@default.service agentdeck-runtime.service agentdeck-web.service
```

After changing frontend or server code, rebuild and restart:

```bash
npm run build
sudo systemctl restart agentdeck-runtime.service agentdeck-web.service
```

## Runtime Data

Runtime state lives outside the repository so the app can be updated without moving user data:

- SQLite database: `/opt/data/agentdeck/agentdeck.sqlite3`
- Codex profiles: `/opt/data/agentdeck/profiles/`
- Shared Codex sessions: `/opt/data/agentdeck/shared/sessions`
- Attachments: `/opt/data/agentdeck/attachments/`
