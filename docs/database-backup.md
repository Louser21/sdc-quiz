# Database Backups

Quiz Platform stores:

- **PostgreSQL** — durable state: users, sessions, quizzes, questions, options,
  game sessions, players, answers. This is the source of truth you must back up.
- **Redis** — live in-flight game state (LOBBY/ACTIVE games, answers-in-progress,
  leaderboards). Recoverable: once every active paper hits its deadline, the
  auto-submit + finalize path repopulates PostgreSQL from Redis, so **Redis is a
  replay source, not a loss source**. Backups are still taken for safety.

## Script

`scripts/backup.sh` writes a consistent PostgreSQL dump plus a crash-consistent
Redis RDB snapshot into `./backups/` and keeps the newest `KEEP_N` (default 14)
of each. It is safe to run against the running compose stack.

```sh
./scripts/backup.sh
```

Set `BACKUP_DIR=/absolute/path` to write elsewhere (e.g. an external/mounted
volume) and `KEEP_N=30` to retain more. Run on `redis`, the AOF is on inside the
container; the script additionally triggers `BGSAVE` so `dump.rdb` is fresh.

### Scheduling

Example crontab — daily at 03:00 UTC, keeping a month:

```cron
0 3 * * * cd /path/to/quiz && ./scripts/backup.sh >> backups/backup.log 2>&1
```

Copy `backups/` off-machine (rsync to another host, object storage, NAS, …) for
real DR — a backup on the same disk that fails is not a backup.

## Restore — PostgreSQL (tested on the compose stack)

1. Copy a chosen dump into the container:

   ```sh
   docker compose cp backups/quiz-20260924T175351Z.dump postgres:/tmp/quiz-restore.dump
   ```

2. Restore into the target database. To a **fresh** database (recommended first,
   to inspect before swapping):

   ```sh
   docker compose exec -T postgres psql -U quiz -d quiz -c \
     "CREATE DATABASE quiz_restore WITH FORCE;"   # FORCE drops a conflicting one
   docker compose exec -T postgres pg_restore -U quiz -d quiz_restore \
     --clean --if-exists /tmp/quiz-restore.dump
   ```

   Or restore **in place** (replaces current data — take a current backup first):

   ```sh
   docker compose exec -T postgres pg_restore -U quiz -d quiz --clean --if-exists \
     /tmp/quiz-restore.dump
   ```

   Verify:

   ```sh
   docker compose exec -T postgres psql -U quiz -d quiz_restore \
     -c 'SELECT count(*) FROM "User";'
   ```

3. **After a full restore**, the API needs `npm run db:generate` (or the
   migration state must match) — `npx prisma migrate status` should be clean.
   Redis will be re-seeded by clients: hosts restart their games, players rejoin
   via the join code, and finished papers already in PostgreSQL remain visible.

## Restore — Redis (optional recovery of in-flight games)

Stop the stack, replace the volume data, or mount the saved RDB/AOF:

```sh
docker compose stop redis
# mount backups/quiz-<stamp>.rdb as /data/dump.rdb (rename the AOF aside),
docker compose start redis
```

Because even Redis backups can be minutes stale, treat Redis restore as
"recover what was mid-flight"; PostgreSQL is the authoritative record of every
completed paper.

## Restore test record

Verified against the compose stack on 2026-09-24: a `pg_dump` custom-format
backup produced by `scripts/backup.sh` was restored into a fresh
`quiz_restore_test` database with `pg_restore --clean --if-exists` (exit 0) —
5 users and all related rows present; the test database was then dropped.
Run this periodically as a drill (ideally automated in staging CI).