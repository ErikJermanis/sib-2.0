# Deploy SiB 2.0 at `https://sib2.erikjermanis.me`

This is a checklist for **you to run** on the VPS. The server was only inspected with read-only commands; none of the deployment steps below have been performed. Start from this repository's `main` branch and ensure the version you want to deploy is pushed to GitHub before cloning it on the VPS.

## Current state (checked 2026-09-27)

- `sib2.erikjermanis.me` resolves to `116.202.103.249` (the VPS). HTTP currently returns nginx's default `404`; HTTPS currently fails certificate hostname validation. DNS is ready, but this site and its certificate are not configured.
- VPS: Ubuntu 24.04 x86-64. nginx is active on ports 80/443; Certbot is installed and its renewal timer is enabled and active. Other sites and the original SiB services (`sibweb.service`, `sib-api.service`) are active. Do not replace their nginx configurations or stop them for this deployment.
- Neither `node` nor `npm` is on the SSH user's PATH; `sqlite3` CLI is also not installed. Nothing is listening on `127.0.0.1:3000`. There is no `/home/erik/sib-2.0` checkout, `sib2.service`, or nginx `sib2` site yet.
- The repository already has a production build (`npm run build`), a Fastify server that serves both `dist/client` and `/api/*`, an installable PWA manifest/icons/service worker, and SQLite migrations on startup. `./app` is the pairing/device CLI. `dist/`, `.env`, and `data/` are ignored by Git. Node **>=22.12** and npm **>=10** are required; HTTPS and `NODE_ENV=production` are needed for production service workers, static serving, and secure pairing cookies.
- This app uses its own SQLite database; deploying it will **not** import data from the old SiB/PostgreSQL app. Test with a new empty list unless you separately plan a migration.

Target layout (consistent with `SiB 2.0 VPS Deployment Guide.md` in the project knowledge base):

| Component | Location |
| --- | --- |
| Git checkout and build | `/home/erik/sib-2.0` |
| Production configuration | `/home/erik/sib-2.0/.env` |
| Persistent SQLite database | `/home/erik/sib-2.0-data/sib.sqlite` |
| Backups | `/home/erik/sib-2.0-backups/` |
| systemd service | `/etc/systemd/system/sib2.service` |
| nginx site | `/etc/nginx/sites-available/sib2.erikjermanis.me` |
| Private upstream | `127.0.0.1:3000` |

## 1. Install the runtime on the VPS

- [ ] SSH in from your computer: `ssh erik@erikjermanis.me`.
- [ ] Install Node.js 24 (or another supported version >=22.12), npm, native-module build tools, and the SQLite CLI. Ubuntu's default Node package may be too old; these commands use NodeSource's Node 24 repository:

  ```bash
  sudo apt update
  sudo apt install -y curl ca-certificates build-essential sqlite3
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
  sudo -E bash /tmp/nodesource_setup.sh
  sudo apt install -y nodejs
  node --version
  npm --version
  command -v node
  ```

  Confirm Node is at least 22.12, npm at least 10, and note the absolute Node path (expected `/usr/bin/node`) for `ExecStart`. `better-sqlite3` is a native dependency: install/build it **on the Linux VPS**, rather than copying your Mac's `node_modules`.

## 2. Put the application and persistent storage in place

- [ ] As `erik`, clone the pushed repository and create directories outside the checkout for data and backups:

  ```bash
  cd /home/erik
  git clone https://github.com/ErikJermanis/sib-2.0.git
  mkdir -p /home/erik/sib-2.0-data /home/erik/sib-2.0-backups
  chmod 700 /home/erik/sib-2.0-data /home/erik/sib-2.0-backups
  cd /home/erik/sib-2.0
  git log -1 --oneline
  ```

  Check that the last commit is the version you meant to deploy. If HTTPS cloning is unavailable, use an authorized Git transport instead.

- [ ] Create `/home/erik/sib-2.0/.env` (for example with `nano`) with these values:

  ```dotenv
  HOST=127.0.0.1
  PORT=3000
  DATABASE_PATH=/home/erik/sib-2.0-data/sib.sqlite
  PUBLIC_BASE_URL=https://sib2.erikjermanis.me
  NODE_ENV=production
  ```

  Run `chmod 600 /home/erik/sib-2.0/.env`. Keep it out of Git. `PUBLIC_BASE_URL` must exactly match the browser origin: the pairing form rejects links for another origin. Use `127.0.0.1`, not `0.0.0.0`; do not open port 3000 in the firewall.

- [ ] From `/home/erik/sib-2.0`, as `erik` (no `sudo`), install **including build devDependencies**, run checks, and build:

  ```bash
  npm ci --include=dev
  npm test
  npm run build
  ls -l dist/client/index.html dist/client/manifest.webmanifest dist/client/service-worker.js dist/server/server/index.js
  ```

  `npm run build` includes both TypeScript typechecks. Production needs the built files and installed runtime dependencies; Playwright browsers and `npm run dev` are not needed on the VPS.

## 3. Start one private Fastify process with systemd

- [ ] Create `/etc/systemd/system/sib2.service` (with `sudo nano`) using the Node path verified above:

  ```ini
  [Unit]
  Description=SiB 2.0
  After=network.target

  [Service]
  Type=simple
  User=erik
  Group=erik
  WorkingDirectory=/home/erik/sib-2.0
  EnvironmentFile=/home/erik/sib-2.0/.env
  ExecStart=/usr/bin/node /home/erik/sib-2.0/dist/server/server/index.js
  Restart=on-failure
  RestartSec=3
  UMask=0077
  NoNewPrivileges=true
  PrivateTmp=true

  [Install]
  WantedBy=multi-user.target
  ```

  The working directory is essential: Fastify locates `dist/client` relative to it. The `EnvironmentFile` loads the same configuration the CLI reads from `.env`. On first start the app creates/migrates the SQLite file and may create neighboring `-wal` and `-shm` files.

- [ ] Enable, start, and check the service:

  ```bash
  sudo systemctl daemon-reload
  sudo systemctl enable --now sib2.service
  sudo systemctl status sib2.service
  curl -fsS http://127.0.0.1:3000/api/health
  ```

  Expect `{"ok":true}`. If it fails, check `sudo journalctl -u sib2.service -n 100 --no-pager` and the permissions on the data directory.

## 4. Route the subdomain through nginx and obtain its own certificate

- [ ] Create `/etc/nginx/sites-available/sib2.erikjermanis.me`:

  ```nginx
  server {
      listen 80;
      server_name sib2.erikjermanis.me;

      location / {
          proxy_pass http://127.0.0.1:3000;
          proxy_http_version 1.1;
          proxy_set_header Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto $scheme;
      }
  }
  ```

  Proxy **all** paths, including `/api/`, `/pair/`, `/shopping`, `/travel`, `manifest.webmanifest`, icons, and `service-worker.js`; Fastify serves them. Do not point this subdomain at the old SiB app or try to serve only `dist/client` from nginx.

- [ ] Enable and validate this site before requesting the certificate:

  ```bash
  sudo ln -s /etc/nginx/sites-available/sib2.erikjermanis.me /etc/nginx/sites-enabled/sib2.erikjermanis.me
  sudo nginx -t
  sudo systemctl reload nginx
  curl -fsS http://sib2.erikjermanis.me/api/health
  ```

  Only reload if `nginx -t` passes. Expect `{"ok":true}` over HTTP first. If it still returns nginx's default 404, check the enabled site, `server_name`, DNS, and nginx logs.

- [ ] Issue a **separate** certificate for this hostname and have Certbot configure the HTTP-to-HTTPS redirect:

  ```bash
  sudo certbot --nginx --cert-name sib2.erikjermanis.me -d sib2.erikjermanis.me --redirect
  sudo nginx -t
  curl -fsS https://sib2.erikjermanis.me/api/health
  curl -I http://sib2.erikjermanis.me/api/health
  sudo certbot certificates
  sudo certbot renew --dry-run
  systemctl status certbot.timer
  ```

  HTTPS should return `{"ok":true}` with a certificate valid for **sib2.erikjermanis.me**, without using `curl -k`. HTTP should redirect to HTTPS. Verify the new certificate/redirect belongs to this site, leaving existing certificates/sites intact. Certbot's active renewal timer was already present during inspection; the dry run confirms it can renew.

## 5. Check the PWA, installation, pairing, and sync

- [ ] In a browser, visit `https://sib2.erikjermanis.me/shopping` and `/travel` directly (including a refresh). Check for a trusted certificate, loaded icons and styles, and an unpaired-device screen. In browser developer tools verify `manifest.webmanifest` and `service-worker.js` return successfully, the service worker registers/controls the page, and the manifest offers installation. If a service worker is not controlling the first load yet, refresh after registration.
- [ ] Check API/auth behavior: `curl -i https://sib2.erikjermanis.me/api/session` should return `401` before pairing; the public health endpoint should return `200`. After pairing, the browser's `/api/session` should return authenticated and the `sib_session` cookie should be `Secure`, `HttpOnly`, and `SameSite=Lax`.
- [ ] Install from the **HTTPS origin** (iOS Safari: Share → Add to Home Screen; Android Chrome: Install app). **Launch the installed app first**, then generate a fresh single-use pairing link on the VPS:

  ```bash
  cd /home/erik/sib-2.0
  ./app create-pairing-link --name "Erik - iPhone"
  ```

  Copy the full URL directly into the installed app's pairing form **without opening it in Safari first**. Installed iOS apps may not share Safari's cookies; opening the URL in Safari consumes the token there. If consumed in the wrong context, create another link. A browser-only session may instead open its link directly. Make a **new one-use link for each installation** (for example, the Android installed app and any desktop browser); keep links private.

- [ ] Add a shopping item on one paired device and confirm it appears on a second paired device; repeat for a travel item, edit/delete, and reload. Go offline **after loading/installing the app online**, launch it, navigate between tabs, make a change, and confirm the UI still reads/writes IndexedDB. Reconnect/foreground the app and confirm changes sync. The service worker caches the app shell/assets, **not** API responses; sync happens on launch, foreground return, and changes (with retries).
- [ ] Check `./app list-devices`. If necessary, `./app revoke-device <device-id>` disables that device's future API access; it does not erase its local IndexedDB data. Check startup after a reboot or `sudo systemctl restart sib2.service` and repeat the HTTPS health check.

## 6. Backups and subsequent deployments

- [ ] Set up a repeatable backup of `/home/erik/sib-2.0-data/sib.sqlite` and keep a copy off the VPS if you need protection against VPS loss. While the app is running, use SQLite's online backup rather than copying only the main DB file (WAL writes may be pending):

  ```bash
  sqlite3 /home/erik/sib-2.0-data/sib.sqlite ".backup '/home/erik/sib-2.0-backups/sib-$(date +%F-%H%M%S).sqlite'"
  ls -lh /home/erik/sib-2.0-backups/
  ```

  Test restoring a copy in a separate location before relying on backups. The database includes list data, device sessions, and pairing tokens; keep backups private.

- [ ] For updates, back up first, then stop the service **before** rebuilding: `npm run build` cleans `dist`, so building under a running server can temporarily break static asset requests. From the checkout:

  ```bash
  cd /home/erik/sib-2.0
  sqlite3 /home/erik/sib-2.0-data/sib.sqlite ".backup '/home/erik/sib-2.0-backups/sib-$(date +%F-%H%M%S).sqlite'"
  sudo systemctl stop sib2.service
  git pull --ff-only
  npm ci --include=dev
  npm test
  npm run build
  sudo systemctl start sib2.service
  curl -fsS https://sib2.erikjermanis.me/api/health
  ```

  Check `sudo journalctl -u sib2.service -n 100 --no-pager` if startup fails. To restore the database, stop the service first; save the current DB/WAL state and replace it with a verified backup before starting again. Restoring an old DB can leave previously paired clients with sync cursors ahead of the restored server, so plan client recovery before rolling back data. The old SiB services can remain online throughout testing.
