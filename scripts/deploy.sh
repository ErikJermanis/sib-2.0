#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR=/home/erik/sites/sib-2.0/sib-2.0
DB_PATH=/home/erik/sib-2.0-data/sib.sqlite
BACKUP_DIR=/home/erik/sites/sib-2.0/backups
SERVICE=sib2.service
backup='(none)'

report_exit() {
  local status=$?
  if (( status != 0 )); then
    printf 'Deployment exited with status %s. Backup: %s. Check systemctl status and journalctl -u %s before retrying.\n' \
      "$status" "$backup" "$SERVICE" >&2
    if ! systemctl is-active --quiet "$SERVICE"; then
      printf '%s is not running; do not restart it until the build/startup failure is resolved.\n' "$SERVICE" >&2
    fi
  fi
}
trap report_exit EXIT

fail() { printf 'Deployment failed: %s\n' "$*" >&2; exit 1; }

[[ -d "$APP_DIR/.git" && -f "$APP_DIR/.env" && -f "$DB_PATH" ]] ||
  fail 'missing checkout, production .env, or SQLite database'
for command in git node npm sqlite3 flock curl; do
  command -v "$command" >/dev/null || fail "missing $command"
done

cd "$APP_DIR"
exec 9>"$APP_DIR/../.deploy.lock"
flock -n 9 || fail 'another deployment is running'

[[ $(git branch --show-current) == main ]] || fail 'checkout is not on main'
[[ -z $(git status --porcelain) ]] || fail 'checkout has local changes'
systemctl is-active --quiet "$SERVICE" || fail "$SERVICE is not running"

printf 'Updating checkout...\n'
git pull --ff-only origin main

# npm ci obeys the lockfile, NOT npm's min-release-age resolver setting.
# Check every pinned version before any dependency install scripts can execute.
printf 'Checking lockfile package release dates...\n'
node scripts/check-dependency-age.mjs

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
backup=$(mktemp "$BACKUP_DIR/sib-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX.sqlite")
printf 'Backing up SQLite to %s...\n' "$backup"
if ! sqlite3 "$DB_PATH" ".backup '$backup'" ||
   [[ $(sqlite3 "$backup" 'PRAGMA quick_check;') != ok ]]; then
  rm -f "$backup"
  backup='(none)'
  fail 'SQLite backup failed; service remains running'
fi
chmod 600 "$backup"

printf 'Stopping %s...\n' "$SERVICE"
sudo -n /usr/bin/systemctl stop "$SERVICE"

# The build deletes dist; never run it under a live server.
printf 'Installing, testing, and building...\n'
npm ci --include=dev
npm test
npm run build

printf 'Starting %s...\n' "$SERVICE"
sudo -n /usr/bin/systemctl start "$SERVICE"
systemctl is-active --quiet "$SERVICE" || fail "$SERVICE did not start; check journalctl -u $SERVICE"
health=$(curl --fail --silent --show-error --retry 8 --retry-connrefused --retry-delay 1 \
  --max-time 5 http://127.0.0.1:3000/api/health) || fail 'health check failed'
[[ "$health" == '{"ok":true}' ]] || fail "unexpected health response: $health"

printf 'Deployed %s; database backup: %s\n' "$(git rev-parse --short HEAD)" "$backup"
