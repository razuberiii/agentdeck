# Codex Mobile

Mobile-first PWA gateway for using Codex from a phone. It wraps the local `codex app-server` with a Fastify API, React UI, multi-account switching, shared session history, image uploads, artifact links, and installable PWA assets.

## Features

- Mobile chat UI for Codex sessions
- Multiple Codex account profiles
- Shared session storage across profiles
- Image upload and generated image viewing
- Session archive, fork, rename, delete, and diff actions
- Project picker with manual workspace scanning
- PWA manifest and service worker

## Layout

- `client/src/main.tsx` - React app
- `client/src/styles.css` - UI styles
- `client/public/` - PWA icons, manifest, service worker
- `server/src/index.ts` - Fastify API and websocket server
- `server/src/codex.ts` - Codex app-server bridge
- `server/src/workspaces.ts` - workspace/project scanning helpers
- `server/src/db.ts` - SQLite wrapper

## Requirements

- Node.js 20+
- `sqlite3`
- OpenAI Codex CLI available as `codex`
- A writable data directory, defaulting to `/opt/data/codex-mobile`

## Configuration

The service reads environment variables from the process environment. In the current deployment, systemd also loads:

```text
/opt/data/codex-mobile/.env
```

Useful variables:

- `ADMIN_PASSWORD` - initial admin password, required on first boot
- `COOKIE_SECRET` - stable cookie signing secret
- `DATA_DIR` - app data directory, default `/opt/data/codex-mobile`
- `CODEX_HOME` - initial Codex home, default `/home/ubuntu/.codex`
- `HOST` - bind host, default `127.0.0.1`
- `PORT` - bind port, default `3842`
- `ALLOWED_WORKSPACES` - comma-separated workspace roots
- `ALLOWED_ORIGINS` - comma-separated websocket origins

## Development

Install dependencies:

```bash
npm install
```

Run a production build:

```bash
npm run build
```

Start the built server:

```bash
npm start
```

Run the TypeScript server directly during development:

```bash
npm run dev
```

## Deployment

This instance is deployed with systemd:

```bash
sudo systemctl restart codex-mobile.service
sudo systemctl status codex-mobile.service
```

After frontend or server changes:

```bash
npm run build
sudo systemctl restart codex-mobile.service
```

## Data

Runtime data is intentionally outside the repository:

- SQLite database: `/opt/data/codex-mobile/codex-mobile.sqlite3`
- Codex profiles: `/opt/data/codex-mobile/profiles/`
- Shared sessions: `/opt/data/codex-mobile/shared/sessions`
- Attachments: `/opt/data/codex-mobile/attachments/`

Do not commit `.env`, database files, profile auth files, or runtime attachments.
