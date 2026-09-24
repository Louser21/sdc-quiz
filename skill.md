# Quiz Live — Project Skill / Conventions Manual

Operating manual for any agent (or human) working in this repo. Read `plan.md` for status/goals.

## North-star invariants (never violate)

1. **The client is disposable; the server owns the game.** Never trust client timestamps, scores,
   correctness, or identity. Clients only *render*, *command*, *receive*.
2. **Authoritative live state lives in Redis, never only in process memory.** No `const games = {}`.
   The API process is a view/timer host; Redis is the source of truth.
3. **Selections are mutable until submission; submission is atomic and permanent.** State writes happen in
   Redis Lua scripts (`setAnswer`/`markReview` check phase + deadline + submitted-lock atomically;
   `submitPaper` locks once). The PG unique `(gameId, playerId, questionId)` is the second lock layer.
4. **Correctness is never sent before a player submits their paper.** `PaperQuestionView`/`OptionView`
   carry no `isCorrect`; the correct-answer map lives in the server-only `game:{id}:questions` JSON.
5. **All WebSocket payloads are runtime-validated with zod** (`CLIENT_EVENTS` inbound; `SERVER_EVENTS`
   typed outbound). Every inbound event: validate → authorize → transition.
6. **The timer is the paper deadline.** `paperStartedAt`/`deadline` are server-computed. Acceptance rule:
   `serverNow < deadline`. At/after the deadline every outstanding paper is auto-submitted; the client only
   renders remaining time.
7. **Player identity is a persistent session cookie**, not a socket id. `player_session` maps to a Player
   row; reconnects resolve the same player and the full paper state.
8. **Failure is explicit.** No swallowed errors, no fake persistence, no silent degradation.

## Architecture map

- REST: Fastify; everything under `/api`, registered as **plain async plugins** (NOT `fastify-plugin` —
  wrapping with `fp` silently ignores `{ prefix }`).
- Realtime: Socket.IO attached to the Fastify HTTP server; two rooms per game
  (`game:{id}` for players, `host:{id}` for the host socket).
- DB: Prisma 7 (`prisma-client` generator output at `apps/api/src/generated/prisma`), `PrismaPg` adapter,
  root `prisma.config.ts` holds `env("DATABASE_URL")`. No `url` in schema datasource.
- Redis: ioredis singleton (`src/redis/client.ts`); game keys prefixed `game:` (see below); Lua via
  `redis.defineCommand` set up at module load (`ensureScripts()`).
- Shared: `@quiz/shared` re-exports zod schemas from `packages/shared/src`. Web imports via source
  (transpiled by Next); API consumes `dist` (build first).

## Redis key layout (live game)

```
game:{id}              HASH  gameId, joinCode, quizId, quizTitle, hostUserId, phase (LOBBY/ACTIVE/FINISHED),
                             hostConnected, timeLimitSeconds, paperStartedAt, deadline, submittedCount
game:{id}:players      HASH  playerId -> JSON {nickname, score, connected, submitted, submittedAt, joinedAt}
game:{id}:answers      HASH  "playerId:questionId" -> optionId  (current, changeable selection)
game:{id}:marked       HASH  "playerId:questionId" -> "1"      (mark-for-review flag)
game:{id}:questions    JSON  { list:[{id,text,options:[{id,text}]}], correct:{qid:optionId} } — NEVER sent raw
leaderboard:{gameId}   ZSET  playerId -> score (mirror of player scores)
```

Phase transitions `LOBBY -> ACTIVE -> FINISHED` are enforced in Lua. `GAME_TRANSITIONS` lives in
`packages/shared/src/constants.ts`. Lua error replies map through `parseLuaReplyError` in `game/store.ts`.

## Wire events (see `packages/shared/src/events.ts` for exact schemas)

- Client → server: `player:sync`, `player:heartbeat`, `player:set-answer`, `player:mark-review`,
  `player:submit-paper`, `host:join-game`, `host:start-paper`, `host:end-paper`, `host:sync`.
- Server → client: `player:state`, `player:set-answer-ack`, `player:scorecard`, `game:finished`,
  `host:state`, `host:paper-started`, `host:player-updated`, `host:player-submitted`, `host:game-finished`,
  `error`.

## Commands (run from repo root unless noted)

> Your shell may lack nvm on PATH. Prefix node tooling with:
> `export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"`

- Generate client: `npm run db:generate`  (REQUIRED after any schema change; typecheck fails otherwise)
- Migrate (pick the method that works, see Gotchas): `npm run db:migrate` / `npm run db:deploy`
- Services: docker compose `postgres` + `redis`; full stack: `docker compose --profile app up -d --build`
- **Ports**: API :3001 · web dev :3002 (host :3000 is occupied) · nginx :8080 · compose redis :6380 ·
  postgres :5432. DB: `postgresql://quiz:quiz@localhost:5432/quiz`
- Dev API: `npm run dev:api` · Dev web: `API_PROXY_TARGET=http://localhost:3001 npm run dev --workspace @quiz/web`
- Typecheck: `npm run typecheck` (all) — **build `@quiz/shared` first** (`npm run build -w @quiz/shared`),
  otherwise API/web fail against stale dist types
- Tests: `npm test -w @quiz/api` (real PG+Redis, 3 service files + integration; DB reset per `beforeEach`)
- Lint: `npm run lint` (currently broken repo-wide — stopgap: rely on typecheck only)

## Code conventions

- Strict TypeScript, ESM everywhere (`"type":"module"`, imports use `.js` suffixes in API code).
- Modules: transport (routes/sockets) thin; logic in `game/`, `players/`, `answers/`, `scoring/`,
  `leaderboard/`; DB access isolated in services.
- Errors: `AppError(code, message, status)` from `src/errors`; `parseWith(schema, value)` for validation;
  `sendError` shape `{ error: { code, message } }` reused for socket errors.
- Scoring: **fixed points** — `scoreForCorrectness(correct) = correct ? SCORE_BASE : 0` (default 1000).
  No speed component; a whole paper is submitted at once.
- Host commands accept optional `runId` shorthand for idempotency bookkeeping.
- Logging: `logGame("EVENT_NAME", { ... })` structured domain events; never log passwords/tokens.
- Web UI: dark zinc-950 theme, violet brand `#7c3aed`, `rounded-2xl` cards, `font-black` headings,
  `HostChrome` for page chrome, `RequireAuth` for host pages, `api()` helper for REST.

## Test / verify flow after any change

1. Schema touched? `npm run db:generate` → apply migration to the compose Postgres
2. `npm run build -w @quiz/shared` (if shared changed) → `npm run typecheck`
3. `npm test -w @quiz/api`
4. Update `plan.md`; commit at phase/milestone boundaries only.

## Gotchas (learned the hard way)

- `@quiz/shared` must be **rebuilt** before API/web typechecks consume it; dist is the source for the API.
- PostgreSQL tables are mixed-case (`"Quiz"`, `"Question"`); **unquoted identifiers fail** with
  `relation "question" does not exist`. Use `docker compose exec -T postgres psql -U quiz -d quiz` and
  quote identifiers.
- `prisma migrate dev` is unsupported non-interactively and `prisma migrate create` is an unknown command here:
  apply raw SQL manually, create the migration folder, then `npx prisma migrate resolve --applied <name>`
  and `npx prisma migrate status`.
- `noUncheckedIndexedAccess` is on in API — destructuring/array access needs `!` where provably present.
- `@fastify/cookie` cookie `secure` only when NODE_ENV is staging/production.
- Socket.IO connection-state recovery is enabled (2 min) — pair with `player_session` cookies for
  identity, not socket recovery alone.
- Avoid `pkill -f` patterns that match your own shell; use exact PID/port kills.
- `git` has no remote; commit messages follow the existing `Phase N: ...` style.
- Deadline timers live in the API process memory (`paperTimers` in `sockets/handlers.ts`) but the
  deadline itself lives in Redis — `restoreActiveTimers()` re-arms them on boot.