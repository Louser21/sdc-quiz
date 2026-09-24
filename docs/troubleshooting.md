# Troubleshooting

## "Player joined but never sees the paper / host never gets state"

- The socket must send `player:sync {}` / `host:join-game { gameId }` — the
  server does not broadcast to a socket it hasn't attached. After the paper
  starts, the state is pushed, but do a `player:sync` for a fresh refresh.
- Identity comes from the cookie **at connect time**. If the player joined
  through REST *after* the socket connected, reconnect the socket.
- Check logs for `PLAYER_CONNECTED` / `HOST_DISCONNECTED` (`docker compose logs api`).

## `error { code: "RATE_LIMITED" }`

- You (or a script) hit a token bucket: player actions 40 burst @ 5/s,
  host commands 10 burst @ 1/s. Wait a second and the bucket refills; or check
  `quiz_ws_rate_limited_total` on `/api/metrics` for the culprit event.
- HTTP `429 RATE_LIMITED` → per-IP limit per `.env` (`RATE_LIMIT_*`). Common
  cause: NAT'ed network behind one IP (e.g. an office). Raise the knobs, or
  tune `RATE_LIMIT_LOGIN_MINUTE`.

## Deadline fires but nobody was auto-submitted

- Deadline timers live in the API process (`paperTimers`). If the API restarted,
  they are re-armed on boot via `restoreActiveTimers()` — but only for games
  whose keys are still in Redis. If Redis was flushed, in-flight games are gone
  (see `docs/disaster-recovery.md`).
- Confirm the paper was actually ACTIVE: `GET /api/metrics` gauges / logs
  `PAPER_FINISHED`.

## Answer acked accepted:false

| reason | meaning |
|--------|---------|
| `PAPER_NOT_ACTIVE` | paper not STARTED (or already FINISHED) |
| `PAPER_ENDED` | past `deadline` — by the letter of the timer |
| `PLAYER_ALREADY_SUBMITTED` | player locked in; edits are immutable |
| `INVALID_OPTION` | optionId doesn't belong to that question |
| `too many events` | token bucket |

## "game is not accepting players" / `GAME_NOT_JOINABLE` on a fresh join

Fresh players can only join while LOBBY (before `host:start-paper`). Players
who were in the room may rejoin through ACTIVE via their existing
`player_session` cookie (same nickname rules apply).

## Nickname conflicts

- `NICKNAME_TAKEN` (409): nickname currently active in that game. Rejoin with
  the same cookie + a different nickname → same playerId, old name freed.
- Same cookie used from two tabs: the tabs share playerId; the room keeps the
  newest connected socket as "present".

## Typecheck fails after pulling schema changes

`@quiz/shared` is consumed as **built dist** by api/web. After touching shared:

```sh
npm run build -w @quiz/shared && npm run typecheck
```

## `prisma migrate` errors

- Mixed-case tables: any hand SQL must quote identifiers
  (`"Quiz"`, `"Question"`, …).
- Non-interactive environments: apply SQL by hand + `npx prisma migrate
  resolve --applied <name>` (see `skill.md` Gotchas).

## Metrics / health

- `GET /api/health` always 200 (process up). `GET /api/ready` 503 ⇒ Redis or
  Postgres down — check compose health (`docker compose ps`, `docker compose
  logs --tail=50 postgres redis`).

## Backups

- `scripts/backup.sh` writes `backups/`. If the log shows "no redis dump.rdb":
  Redis is AOF-only currently; the RDB snapshot is produced after `BGSAVE` (1 s
  wait) — everything still works, PG is the authoritative store.
- Restore drill: `docs/database-backup.md`.