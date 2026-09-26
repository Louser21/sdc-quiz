#!/usr/bin/env bash
#
# Generate the real nginx TLS conf from the production.conf template
# (infra/nginx/production.generated.conf). This file is gitignored.
#
# Usage:
#   ./scripts/gen-nginx-tls.sh <vhost> [cert_file] [key_file]
#
# Examples:
#   ./scripts/gen-nginx-tls.sh quiz-sdg.duckdns.org
#   ./scripts/gen-nginx-tls.sh quiz.example.com \
#       /etc/letsencrypt/live/quiz.example.com/fullchain.pem \
#       /etc/letsencrypt/live/quiz.example.com/privkey.pem
#
# The compose prod override bind-mounts the host's /etc/letsencrypt into the
# nginx container, so cert paths are the real Let's Encrypt paths and certbot
# auto-renewal keeps working without any copying.
#
set -euo pipefail

cd "$(dirname "$0")/.."

VHOST="${1:?usage: gen-nginx-tls.sh <vhost> [cert_file] [key_file]}"
CERT_FILE="${2:-/etc/letsencrypt/live/${VHOST}/fullchain.pem}"
KEY_FILE="${3:-/etc/letsencrypt/live/${VHOST}/privkey.pem}"

TEMPLATE="infra/nginx/production.conf"
OUT="infra/nginx/production.generated.conf"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[gen-nginx-tls] template missing: $TEMPLATE" >&2
  exit 1
fi

awk -v vh="$VHOST" -v cf="$CERT_FILE" -v kf="$KEY_FILE" \
  '{ gsub(/__SERVER_NAME__/, vh); gsub(/[${]CERT_FILE[}]/, cf); gsub(/[${]KEY_FILE[}]/, kf); print }' \
  "$TEMPLATE" > "$OUT"

echo "[gen-nginx-tls] wrote $OUT"
echo "[gen-nginx-tls] vhost:     $VHOST"
echo "[gen-nginx-tls] cert_file: $CERT_FILE"
echo "[gen-nginx-tls] key_file:  $KEY_FILE"

if [[ ! -f "$CERT_FILE" || ! -f "$KEY_FILE" ]]; then
  echo "[gen-nginx-tls] WARNING: cert files missing on host."
  echo "[gen-nginx-tls] nginx will fail to start until they exist (certbot)."
fi