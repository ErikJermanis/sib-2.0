# SiB 2.0

Private, local-first shopping and travel lists for two people. The client is a vanilla TypeScript PWA; the server is Fastify with SQLite.

## Requirements

- Node.js 22.12 or newer
- npm 11.19 or newer (the project enforces a 14-day minimum package release age)
- `just` for the `install` and `deploy` recipes
- HTTPS in production

## Development

```bash
just install # clean install with a lockfile-age check; requires npm 11.19+
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

For an installed app, first open the site in your phone's browser and install it (on iOS, use Share → Add to Home Screen; on Android, use Install app). Launch the home-screen app, **copy the full one-use URL without opening it in the browser**, and paste it into the pairing form. The installed iOS app may not share Safari's cookies, so opening the link in Safari first can consume it without pairing the installed app. If that happens, generate a new link. Opening the link directly still works for a browser session.

The server consumes the link and sets a ten-year `HttpOnly`, `Secure`, `SameSite=Lax` session cookie in the app that paired it. Every installation needs its own link.

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
node scripts/check-dependency-age.mjs
npm ci --include=dev
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

### Redeploying the existing VPS

The live service uses `/home/erik/sites/sib-2.0/sib-2.0` as its checkout, `/home/erik/sib-2.0-data/sib.sqlite` as its database, and `sib2.service` as its systemd unit. The production `.env` and database stay on the VPS; do not copy your local `.env` or database over them.

After committing and pushing this repository to `origin/main`, install the deployment script **once** from your laptop outside the server's Git checkout:

```bash
scp scripts/deploy.sh erik@erikjermanis.me:/home/erik/sites/sib-2.0/deploy.sh
ssh erik@erikjermanis.me 'chmod 700 /home/erik/sites/sib-2.0/deploy.sh'
```

If you later change `scripts/deploy.sh`, copy it over again. Keeping the executable copy outside the checkout prevents a `git pull` from replacing the script while Bash is reading it.

On the VPS, use `sudo visudo -f /etc/sudoers.d/sib2-deploy` and add **exactly**:

```sudoers
erik ALL=(root) NOPASSWD: /usr/bin/systemctl stop sib2.service, /usr/bin/systemctl start sib2.service
```

The script uses `sudo -n` (non-interactive); only those two systemd commands need passwordless sudo. The systemd unit, nginx site, Node/npm 11.19+, and SQLite CLI must already be in place. Then, from your laptop:

```bash
just deploy
```

`just deploy` runs the server's installed script via SSH. It refuses a dirty checkout, pulls `origin/main` with `--ff-only`, checks the lockfile's package release dates, backs up SQLite online to `/home/erik/sites/sib-2.0/backups`, stops the app, runs `npm ci --include=dev`, tests and builds, starts the app, and verifies the local health endpoint. SQLite migrations run as the service starts. A failed build is **not** automatically restarted with incomplete files; check the printed error and `journalctl -u sib2.service` before retrying. Inspect `https://sib2.erikjermanis.me` after deployment.

### Dependency release-age policy

The committed `.npmrc` sets `min-release-age=14`, so npm 11.19+ will not **select** packages published within the last 14 days during local `npm install`/updates. On a laptop currently running npm 10, upgrade npm (for example `npm install -g npm@11` with an existing compatible Node installation), then confirm `npm --version` is at least 11.19 and `npm config get min-release-age` prints `14` in this checkout.

`npm ci` uses pinned `package-lock.json` versions and **does not apply** npm's release-age filter. For clean local installs use `just install`: it checks every locked registry version's published date before running `npm ci`. The server's deployment script runs the same check before installing anything. Both checks fail closed if registry release dates are unavailable or a lockfile entry is not a hashed npm registry tarball. Use npm 11.19+ for `npm install` when adding/updating dependencies; run `just install` rather than bare `npm ci` for clean local installs. Keep the lockfile committed; updating dependencies locally does not cause the VPS to resolve newer versions during deployment.

## Commands

```bash
npm run typecheck  # client and server TypeScript
npm test           # app and dependency-age policy tests
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

Every local mutation stores the updated entity and an outbox operation in one IndexedDB transaction. `POST /api/sync` uploads pending operations and returns server changes after the client's increasing version cursor; a new local database receives an active-item snapshot instead of historical changes. Operation UUIDs make retries idempotent, the server's receipt order implements last-write-wins, and synced deletions are removed from IndexedDB while retained as server tombstones.

Sync runs at app launch, when the app returns to the foreground, and after a local mutation. Failed sync attempts retry after 10, 30, and 60 seconds, then stop until the next launch, foreground return, or local mutation. Unpaired devices do not sync.

The service worker only caches the application shell and static assets. It does not cache API responses or replace the IndexedDB synchronization mechanism.
