# Disaster Recovery

Goal: recover a working platform and its data after an outage. Priorities in
order: **records that are already written (PostgreSQL)**, then **recoverability
of live games**, then **uptime**.

## RTO / RPO targets (guide)

- RPO (data loss): hours, bounded by the last `scripts/backup.sh` run + the PG
  WAL. Recommended: daily backups (default), back them off-box.
- RTO (restore time): minutes on a replacement VM (image-based) +
  `pg_restore` time.

## Scenarios

### 1. API container down / API crash-looping

```sh
docker compose ps                    # which one is unhealthy
docker compose logs --tail=200 api
docker compose up -d api             # restart with current image
```

Game impact: in-flight papers keep their Redis state; the restart re-arms
deadline timers (`restoreActiveTimers`) and finishes + persists any papers whose
deadline passes. No data loss.

### 2. Web container down

SSR only — no state in the web process. Restart it; players/host reconnect and
re-sync (`player:sync` / `host:sync`).

### 3. PostgreSQL down (Redis alive)

Live games keep running (state is in Redis). Persistence writes fail and are
logged with retries. Once PG is back: confirm migrations are applied
(`npm run db:deploy`) and watch for backlogged completions to land. Any paper
that finished while PG was down is safe to re-finalize, but the app only
persists at finalize — so temporarily losing attrs for finished-then-dropped
papers is possible; rerun  the flood of `finalizePaper` if needed (it is
idempotent at the Redis level).

### 4. Redis lost (PostgreSQL alive)

Ended games are fully recorded in PG — no loss. **In-progress (LOBBY/ACTIVE)
games are unrecoverable**: their Redis keys are gone. The API keeps running but
existing rooms are gone; players rejoin a new game. Mitigation: rely on
`appendonly yes` (default in compose) + the RDB backups in
`scripts/backup.sh`, and accept this as a v1 limitation.

Restoring Redis from a snapshot (optional):

```sh
docker compose stop redis
# mount backups/quiz-<stamp>.rdb as /data/dump.rdb (move the AOF aside),
docker compose start redis
```

### 5. Full loss of the VM

1. Provision a replacement box (same images from CI).
2. `git clone`, `cp .env.example .env`, set `SESSION_SECRET` to the **same**
   value as before (else hosts are logged out), restore `.env` vars.
3. Restore PostgreSQL from the newest off-box backup
   (`docs/database-backup.md` — `pg_restore --clean --if-exists` into a fresh
   DB, verify row counts, flip connection).
4. `npm run db:generate` if needed, `docker compose --profile app up -d --build`.
5. Redis starts empty or from the last RDB; live-game state is the accepted gap.

## Before/after checklist

**Before (hardening):**

- [ ] Daily backups + off-box copy (cron)
- [ ] Periodic restore drill in staging (documented in `docs/database-backup.md`)
- [ ] `SESSION_SECRET` stored in a secrets manager, not only `.env`

**After any restore:**

- [ ] `curl /api/health` + `/api/ready` green
- [ ] Host login works (proves sessions) 
- [ ] One game round-trips to FINISHED (proves Redis + PG write path)
- [ ] `curl /api/metrics` shows fresh live gauges