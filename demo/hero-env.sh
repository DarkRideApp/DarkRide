#!/usr/bin/env bash
# Launch a FRESH, seeded DarkRide for hero recording — clean branded data and a
# known login (hero / hero-demo-pass), separate from your real instance/DB.
#
#   demo/hero-env.sh            # starts it, seeds it, prints the URL; Ctrl-C to stop
#
# Then record against it (creds default to hero in record.mjs's hero flow):
#   DARKRIDE_USER=hero DARKRIDE_PASS=hero-demo-pass \
#     node demo/record.mjs --scenario demo/scenarios/hero-playground.mjs \
#       --base-url http://localhost:5399 --name hero
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root

DB="${HERO_DB:-/tmp/darkride-hero.db}"
BACKEND_PORT="${HERO_BACKEND_PORT:-3399}"
FRONTEND_PORT="${HERO_FRONTEND_PORT:-5399}"
ADMIN_USER="${HERO_USER:-hero}"
ADMIN_PASS="${HERO_PASS:-hero-demo-pass}"

# Fresh DB every run (better-sqlite3 side files too).
rm -f "$DB" "$DB"-shm "$DB"-wal 2>/dev/null || true

export DATABASE_PATH="$DB"
export PORT="$BACKEND_PORT"                 # backend + vite proxy target
export DARKRIDE_BOOTSTRAP_ADMIN_USERNAME="$ADMIN_USER"
export DARKRIDE_BOOTSTRAP_ADMIN_PASSWORD="$ADMIN_PASS"
export WEBSOCKET_ALLOWED_ORIGINS="http://localhost:${FRONTEND_PORT}"

echo "Starting fresh DarkRide  (db=$DB  backend=$BACKEND_PORT  frontend=$FRONTEND_PORT)…"
npm run build -w @darkrideapp/plugin-sdk >/dev/null 2>&1 || true
npx concurrently -k -n backend,frontend \
  "tsx watch backend/index.ts" \
  "npx vite --port ${FRONTEND_PORT}" &
STACK_PID=$!
trap 'kill $STACK_PID 2>/dev/null || true' EXIT INT TERM

echo "Waiting for the backend…"
for i in $(seq 1 60); do
  if curl -fsS "http://localhost:${BACKEND_PORT}/v1/auth/me" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 60 ] && { echo "Backend didn't come up in 60s." >&2; exit 1; }
done

echo "Seeding hero data…"
node demo/hero-seed.mjs --api "http://localhost:${BACKEND_PORT}" --user "$ADMIN_USER" --pass "$ADMIN_PASS"

cat <<EOF

  ✔ Hero DarkRide ready:  http://localhost:${FRONTEND_PORT}
    login: ${ADMIN_USER} / ${ADMIN_PASS}
    (seeded clean Playground traffic; your real DB is untouched)

  Connect your device to THIS instance, then record. Ctrl-C to stop.
EOF
wait $STACK_PID
