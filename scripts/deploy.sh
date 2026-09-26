#!/usr/bin/env bash
#
# Deploy / upgrade the Quiz Platform on a production box (single host).
# Site is reachable at $PUBLIC_URL after this exits 0.
#
#   ./scripts/deploy.sh
#
# Order of operations:
#   1. Bootstrap .env from .env.example when missing (real SESSION_SECRET,
#      NODE_ENV=production). You still set PUBLIC_URL/FRONTEND_ORIGIN.
#   2. Preflight checks: env vars, TLS conf + certs.
#   3. Start postgres + redis, run `prisma migrate deploy`.
#   4. Build + start the app (api/web/nginx) via the PROD override.
#   5. Health gate: https://localhost/api/health must return 200.
#
# First-time TLS (do ONCE, before this script):
#   sudo certbot certonly --standalone -d <vhost> --agree-tos
#   ./scripts/gen-nginx-tls.sh <vhost>
#   # certbot won't run while port 80 is busy; deploy.sh starts nginx AFTER,
#   # so run certbot with no stack up (or `docker compose stop nginx` first).
#
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE=(docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile app)

echo "[deploy] project dir: $PWD"

# --- 1. bootstrap .env -------------------------------------------------------
if [[ ! -f .env ]]; then
  echo "[deploy] .env missing -> creating from .env.example"
  cp .env.example .env
  SECRET="$(openssl rand -hex 32)"
  sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env
  sed -i "s|^NODE_ENV=.*|NODE_ENV=production|" .env
  grep -q '^NGINX_HTTP_PORT=' .env || echo 'NGINX_HTTP_PORT=80' >> .env
  echo "[deploy] .env created. SESSION_SECRET generated, NODE_ENV=production."
  echo "[deploy] !!! EDIT .env now:"
  echo "[deploy]     PUBLIC_URL=https://<your-vhost>"
  echo "[deploy]     FRONTEND_ORIGIN=https://<your-vhost>"
  echo "[deploy]     then re-run this script."
  exit 1
fi

# --- 2. preflight -------------------------------------------------------------
grep -q '^NODE_ENV=production' .env || {
  echo "[deploy] ERROR: .env must set NODE_ENV=production" >&2
  exit 1
}
if grep -q '^SESSION_SECRET=change-me' .env; then
  echo "[deploy] ERROR: SESSION_SECRET still the example value; set a real one." >&2
  exit 1
fi

URL="$({ grep -E '^PUBLIC_URL=' .env | cut -d= -f2- | tr -d '[:space:]'; } || true)"
case "$URL" in
  https://*) ;;
  "")        echo "[deploy] ERROR: PUBLIC_URL unset" >&2; exit 1 ;;
  *)         echo "[deploy] ERROR: PUBLIC_URL must start with https:// (got: $URL)" >&2; exit 1 ;;
esac
echo "[deploy] PUBLIC_URL: $URL"

if [[ ! -f infra/nginx/production.generated.conf ]]; then
  echo "[deploy] ERROR: infra/nginx/production.generated.conf missing." >&2
  echo "[deploy] Run: ./scripts/gen-nginx-tls.sh <your-vhost>" >&2
  exit 1
fi
VHOST="$(sed -n 's/^[[:space:]]*server_name[[:space:]]*\([^;]*\);/\1/p' \
  infra/nginx/production.generated.conf | head -n1 | tr -d '[:space:]')"
echo "[deploy] serving vhost: $VHOST (nginx health req root)"

# --- 3. db + migrate ----------------------------------------------------------
"${COMPOSE[@]}" config --quiet
echo "[deploy] starting postgres + redis..."
"${COMPOSE[@]}" up -d --wait postgres redis
echo "[deploy] applying migrations..."
"${COMPOSE[@]}" run --rm api npx prisma migrate deploy

# --- 4. build + up ------------------------------------------------------------
echo "[deploy] building + starting the app stack (api/web/nginx)..."
"${COMPOSE[@]}" up -d --build --wait
echo "[deploy] containers:"
"${COMPOSE[@]}" ps --format 'table {{.Service}}\t{{.Status}}'

# --- 5. health gate -----------------------------------------------------------
echo "[deploy] health gate (https://localhost/api/health)..."
curl -fsSk --retry 5 --retry-all-errors --retry-delay 3 -o /dev/null \
  "https://localhost/api/health" \
  || { echo "[deploy] FAILED: api not healthy over TLS." >&2; exit 1; }

echo "[deploy] DONE. Live at: $URL"
echo "[deploy] Next: log in as a host, publish a quiz, share the link."