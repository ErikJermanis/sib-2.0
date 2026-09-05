# SiB 2.0

Private, local-first shopping and travel lists for two people. The client is a vanilla TypeScript PWA; the server is Fastify with SQLite.

## Requirements

- Node.js 22.12 or newer
- npm 10 or newer
- HTTPS in production

## Development

```bash
npm install
cp .env.example .env
npm run dev
```

Vite runs at `http://localhost:5173` and proxies API and pairing requests to Fastify at `http://127.0.0.1:3000`.

The default development database is `./data/sib.sqlite`. All item data shown by the UI comes from IndexedDB; network responses are first committed locally and then rendered.

## Pair A Device

Set `PUBLIC_BASE_URL` to the externally accessible HTTPS origin, then create a named, one-use link:

```bash
./app create-pairing-link --name "Erik - iPhone"
```

Open the returned URL on the device. The server consumes the link and sets a ten-year `HttpOnly`, `Secure`, `SameSite=Lax` session cookie.

Manage paired devices on the server:

```bash
./app list-devices
./app revoke-device <device-id>
```

Revocation takes effect on the next API request. Existing local IndexedDB data is not remotely erased.

## Production

Create a production environment file:

```dotenv
HOST=127.0.0.1
PORT=3000
DATABASE_PATH=/var/lib/sib/sib.sqlite
PUBLIC_BASE_URL=https://sib.example.com
NODE_ENV=production
```

Build and start the single server process:

```bash
npm ci
npm run build
npm start
```

Run it from a stable working directory because the server serves `dist/client`. Keep `DATABASE_PATH` outside that release directory. SQLite enables WAL mode and may create `-wal` and `-shm` files beside the database.

An example systemd unit:

```ini
[Unit]
Description=SiB 2.0
After=network.target

[Service]
Type=simple
User=sib
WorkingDirectory=/opt/sib
EnvironmentFile=/opt/sib/.env
ExecStart=/usr/bin/node /opt/sib/dist/server/server/index.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

Terminate HTTPS at Caddy, nginx, or another reverse proxy and forward to `127.0.0.1:3000`. HTTPS is required for production service workers, installation, and the secure session cookie.

## Commands

```bash
npm run typecheck  # client and server TypeScript
npm test           # server and IndexedDB/sync tests
npm run test:e2e   # builds and tests both target mobile layouts
npm run build      # production client and server
npm start          # production server
```

Playwright's Chromium binary is installed once with `npx playwright install chromium`.

## Architecture

- `src/client/db.ts`: IndexedDB records, atomic local changes, and sync reconciliation
- `src/client/sync.ts`: small foreground sync engine and status policy
- `src/client/main.ts`: History API navigation and DOM interface
- `src/server/database.ts`: SQLite schema, pairing, devices, and versioned changes
- `src/server/server.ts`: pairing and sync HTTP endpoints plus production static serving
- `src/shared/protocol.ts`: client/server sync contract

Every local mutation stores the updated entity and an outbox operation in one IndexedDB transaction. `POST /api/sync` uploads pending operations and returns all server changes after the client's increasing version cursor. Operation UUIDs make retries idempotent, the server's receipt order implements last-write-wins, and deletion remains soft on both sides.

The service worker only caches the application shell and static assets. It does not cache API responses or replace the IndexedDB synchronization mechanism.
