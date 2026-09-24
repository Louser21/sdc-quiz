#!/usr/bin/env bash
#
# Quiz Platform — database backup script (Postgres + Redis snapshot).
#
# Writes timestamped backups to ./backups and prunes to KEEP_N (default 14).
# Safe to run while the stack is up (Postgres dumps are consistent snapshots;
# Redis uses BGSAVE so the RDB is crash-consistent). Schedule via cron, e.g.
# every day at 03:00:
#
#   0 3 * * * cd /path/to/quiz && ./scripts/backup.sh >> backups/backup.log 2>&1
#
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_N="${KEEP_N:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
POSTGRES_SERVICE="${PG_SERVICE:-postgres}"
REDIS_SERVICE="${REDIS_SERVICE:-redis}"

mkdir -p "$BACKUP_DIR"

echo "[backup] $(date -u +%FT%TZ) starting"

# --- Postgres: consistent logical dump ---------------------------------------
echo "[backup] pg_dump -> ${BACKUP_DIR}/quiz-${STAMP}.sql"
docker compose exec -T "$POSTGRES_SERVICE" pg_dump -U quiz -d quiz \
  --format=custom --compress=9 --file=/tmp/quiz-backup.dump
docker compose cp "${POSTGRES_SERVICE}:/tmp/quiz-backup.dump" "${BACKUP_DIR}/quiz-${STAMP}.dump"
docker compose exec -T "$POSTGRES_SERVICE" rm -f /tmp/quiz-backup.dump

# --- Redis: crash-consistent RDB snapshot -------------------------------------
echo "[backup] redis BGSAVE -> ${BACKUP_DIR}/quiz-${STAMP}.rdb"
docker compose exec -T "$REDIS_SERVICE" redis-cli BGSAVE >/dev/null 2>&1 || true
sleep 1
docker compose cp "${REDIS_SERVICE}:/data/dump.rdb" "${BACKUP_DIR}/quiz-${STAMP}.rdb" || \
  echo "[backup] WARN: no redis dump.rdb produced (AOF-only deployment?); skipping Redis snapshot."

# --- Retention: keep the KEEP_N most recent -----------------------------------
echo "[backup] pruning to ${KEEP_N} newest files"
ls -1tr "${BACKUP_DIR}"/quiz-*.dump 2>/dev/null | head -n -"$KEEP_N" | xargs -r rm --
ls -1tr "${BACKUP_DIR}"/quiz-*.rdb 2>/dev/null | head -n -"$KEEP_N" | xargs -r rm --

echo "[backup] $(date -u +%FT%TZ) done — files:"
ls -lh "${BACKUP_DIR}"/quiz-"${STAMP}".*