# Architecture

## Topology

```
                          ┌────────────────────────────────────────┐
    Host Browser ────────►│  nginx :8080 (single origin, same-origin │
    Player Devices ──────►│  cookies; production: TLS + Cloudflare)   │
                          └───────┬──────────────────────┬───────────┘
                                  │ /api, /socket.io      │ / (Next.js)
                          ┌───────▼────────┐     ┌────────▼────────┐
                          │ API  :3001     │     │ Web   :3000      │
                          │ Fastify v5 +    │     │ Next.js (SSR)   │
                          │ Socket.IO v4    │     │ host + player   │
                          └───┬────┬────┬───┘     └─────────────────┘
                              │    │    │
                      ┌───────▼┐ ┌─▼────┴─────┐
                      │ Redis  │ │ PostgreSQL │
                      │ :6379  │ │ :5432      │
                      │ live   │ │ durable    │
                      │ state  │ │ records    │
                      └────────┘ └────────────┘
```

All traffic goes through the **single origin** (nginx): the web UI and the API
are same-origin, so httpOnly session cookies just work and CORS stays trivial.

## Split responsibilities

| Store      | Holds | Authority |
|------------|-------|-----------|
| **PostgreSQL** | Users, sessions, quizzes, questions, options, game sessions, players, answers (final persisted scores) | Source of truth for everything ended/recorded |
| **Redis**      | In-flight games: `game:{id}` (state HASH incl. host + phase + deadline), `game:{id}:players` (HASH), `game:{id}:answers` (HASH), `leaderboard:{id}` (ZSET) | Authoritative for **live** game state; auto-submits + finalize write completed papers to PG |

Once all papers are in, `finalizePaper` writes the finished session, players and
answers to PostgreSQL and marks the game FINISHED — Redis is then only a cache
view of that outcome.

## Process model

- API is stateless across restarts except for **in-memory deadline timers**
  (`paperTimers`). The deadlines themselves live in Redis, so on boot
  `restoreActiveTimers()` re-arms the timer for every orphaned ACTIVE game —
  a backend restart never "freezes" a running paper.
- WebSocket event handlers are thin; all domain logic lives in `game/`,
  `players/`, `answers/`, `scoring/`, `leaderboard/`. Both directions are
  zod-validated against `packages/shared` (`CLIENT_EVENTS` / `SERVER_EVENTS`).
- Player identity = httpOnly `player_session` cookie kept by the client and
  re-presented on reconnect; Socket.IO connection-state recovery (2 min) pairs
  with it — a refresh on a flaky network returns the *same* paper view from
  Redis, not a new attempt.

## Game lifecycle

```
LOBBY ──host:start-paper──► ACTIVE ─┬─ deadline fires / host:end-paper / all submitted
   ▲        (global timer)          │        │
   │ new joiners only here         player:submit-paper (locks player atomically)
   └────────────rejoin──────────────┘        ▼
                                     FINISHED (leaderboard + persisted results)
```

- One shared `deadline` (`now < deadline`); selection of an answer is accepted
  while ACTIVE *and* not-yet-submitted, enforced atomically in Lua (+ repeated
  by a PG unique constraint at persist time).
- Correct answers are **never** sent before submit (`correct` map is server-only
  in Redis; the player view strips it and the persist-time scoring uses it).
- Scoring is fixed: `SCORE_BASE` per correct answer (default 1000).

## Security model

- **Host** UI is behind `RequireAuth` (session cookie → Prisma user). Every
  privileged REST route + WS handler re-checks ownership (a host can only
  operate games where `state.hostUserId === user.id`).
- **Player** gets a `player_session` cookie at join; sockets are attached to the
  game room only for players holding a valid session for that game.
- HTTP brute-force + flood protection: `@fastify/rate-limit` (per-IP, login /
  register / join stricter than the global floor). WS flood protection: in-memory
  token buckets per player (actions) and per game (host commands).
- Secrets: argon2id for passwords; `SESSION_SECRET` for signed cookies; no
  secrets in the repo (see `.env.example`; real `.env` is gitignored).

## Observability

- Structured pino logs with domain events via `logGame("EVENT_NAME", …)`; never
  passwords/tokens.
- `GET /api/metrics` — Prometheus text: `quiz_http_requests_total`,
  `quiz_ws_events_total`, `quiz_ws_rate_limited_total`,
  `quiz_ws_connections_total`, live gauges `quiz_live_games` / `quiz_live_players`.
- `GET /api/health` (liveness) and `GET /api/ready` (Postgres + Redis probes).

## Deployment shapes

- **Local / staging:** `docker compose` (postgres + redis always-on;
  `--profile app` adds api + web + nginx). See `docs/local-development.md`.
- **Production:** the same images behind nginx/TLS + Cloudflare. See
  `docs/production.md`, `docs/disaster-recovery.md`, `docs/database-backup.md`.

## Failure trade-offs

| Failure | Effect | Mitigation |
|---|---|---|
| Player drops network | Selections kept in Redis; reconnect restores them; post-submit edits still rejected | session cookie + connection-state recovery + server-authoritative view |
| Host disconnects | Paper keeps running; host rejoins console anytime | deadline timer is server-side; `host:join-game` → fresh `host:state` |
| API process dies | Deadline timers lost | Redis holds deadlines; boot re-arms timers and finishes papers |
| PostgreSQL down | Live game unaffected; persistence delayed | `answers/service.ts` writes async + retries; failed persists are logged |
| Redis lost | In-progress game unplayable | No auto-fix; restart from PG for ended games (see disaster-recovery) |