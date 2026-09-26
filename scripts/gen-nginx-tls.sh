#!/usr/bin/env bash
#
# Generate the real nginx TLS conf from the production.conf template
# (infra/nginx/production.generated.conf). This file is gitignored.
#
# Usage:
#   ./scripts/gen-nginx-tls.sh <vhost> [cert_file] [key_file] [extra_vhost ...]
#
# Examples:
#   ./scripts/gen-nginx-tls.sh quiz-sdg.duckdns.org
#   ./scripts/gen-nginx-tls.sh quiz.example.com \
#       /etc/letsencrypt/live/quiz.example.com/fullchain.pem \
#       /etc/letsencrypt/live/quiz.example.com/privkey.pem
#   # SAN cert: also serve the old name from the same server block:
#   ./scripts/gen-nginx-tls.sh quiz.example.com "" "" sdc-quiz.duckdns.org
#
# The compose prod override bind-mounts the host's /etc/letsencrypt into the
# nginx container, so cert paths are the real Let's Encrypt paths and certbot
# auto-renewal keeps working without any copying.
#
# With extra vhosts, the generated server_name lists all of them. Issue the
# matching SAN cert once (certbot -d <vhost> -d <extra> ...); certbot stores
# it under /etc/letsencrypt/live/<vhost>/, which stays the cert_file default.
#
set -euo pipefail

cd "$(dirname "$0")/.."

VHOST="${1:?usage: gen-nginx-tls.sh <vhost> [cert_file] [key_file] [extra_vhost ...]}"
if [[ "${2:-}" == "" ]]; then
  CERT_FILE="/etc/letsencrypt/live/${VHOST}/fullchain.pem"
  KEY_FILE="/etc/letsencrypt/live/${VHOST}/privkey.pem"
  EXTRA=("${@:3}")
else
  CERT_FILE="$2"
  KEY_FILE="$3"
  EXTRA=("${@:4}")
fi

TEMPLATE="infra/nginx/production.conf"
OUT="infra/nginx/production.generated.conf"

if [[ ! -f "$TEMPLATE" ]]; then
  echo "[gen-nginx-tls] template missing: $TEMPLATE" >&2
  exit 1
fi

SERVER_NAMES="$VHOST"
if ((${#EXTRA[@]})); then
  SERVER_NAMES="$SERVER_NAMES ${EXTRA[*]}"
fi

awk -v vh="$SERVER_NAMES" -v cf="$CERT_FILE" -v kf="$KEY_FILE" \
  '{ gsub(/__SERVER_NAME__/, vh); gsub(/[$][{]CERT_FILE[}]/, cf); gsub(/[$][{]KEY_FILE[}]/, kf); print }' \
  "$TEMPLATE" > "$OUT"

echo "[gen-nginx-tls] wrote $OUT"
echo "[gen-nginx-tls] server_name: $SERVER_NAMES"
echo "[gen-nginx-tls] cert_file:   $CERT_FILE"
echo "[gen-nginx-tls] key_file:    $KEY_FILE"

if sudo -n true 2>/dev/null; then
  # Passwordless sudo available -> we can actually read root-owned certs.
  if ! sudo test -f "$CERT_FILE" || ! sudo test -f "$KEY_FILE"; then
    echo "[gen-nginx-tls] WARNING: cert files missing on host."
    echo "[gen-nginx-tls] nginx will fail to start until they exist (certbot)."
  fi
elif [[ ! -r "$CERT_FILE" || ! -r "$KEY_FILE" ]]; then
  # No sudo; best-effort permissions check. Under /etc/letsencrypt this
  # is expected to be unreadable as a non-root user -> warning is advisory.
  echo "[gen-nginx-tls] WARNING: cert files not readable by $USER"
  echo "[gen-nginx-tls] (expected under /etc/letsencrypt; verify with: sudo ls $(dirname "$CERT_FILE"))"
fi