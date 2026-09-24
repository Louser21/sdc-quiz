# Quiz Live — Project Skill / Conventions Manual

Operating manual for any agent (or human) working in this repo. Read `plan.md` for status/goals.

## North-star invariants (never violate)

1. **The client is disposable; the server owns the game.** Never trust client timestamps, scores,
   correctness, or identity. Clients only *render*, *command*, *receive*.
2. **Authoritative live state lives in Redis, never only in process memory.** No `const games = {}`.
   The API process is a view/timer host; Redis is the source of truth.
3. **Answer acceptance is an atomic Redis Lua script.** One player + one question = one accepted answer,
   enforced in Lua *and* by the PG unique `(gameId, playerId, questionId)`.
4. **Correctness is never sent before the question ends.** `QuestionPayload`/`HostQuestionView` contain
   no `isCorrect`; the correct-answer map stays in a server-only Redis key.
5. **All WebSocket payloads are runtime-validated with zod** (`CLIENT_EVENTS` inbound; `SERVER_EVENTS`
   typed outbound). Every inbound event: validate → authorize → transition.
6. **Timers are server-side.** `questionStartedAt`/`questionEndsAt` come from the server; the client only
   renders remaining time. Acceptance rule: `serverNow < questionEndsAt`.
7. **Player identity is a persistent session cookie**, not a socket id. `player_session` maps to a Player
   row; reconnects resolve the same player and the full game state.
8. **Failure is explicit.** No swallowed errors, no fake persistence, no silent degradation.

## Architecture map

- REST: Fastify; everything under `/api`, registered as **plain async plugins** (NOT `fastify-plugin` —
  wrapping with `fp` silently ignores `{ prefix }`).
- Realtime: Socket.IO attached to the Fastify HTTP server; two rooms per game
  (`game:{id}` for players, `host:{id}` for the host socket).
- DB: Prisma 7 (`prisma-client` generator output at `apps/api/src/generated/prisma`), `PrismaPg` adapter,
  root `prisma.config.ts` holds `env("DATABASE_URL")`. No `url` in schema datasource.
- Redis: ioredis singleton (`src/redis/client.ts`); game keys prefixed `game:` (see below); Lua via
  `redis.defineCommand`.
- Shared: `@quiz/shared` re-exports zod schemas from `packages/shared/src`. Web imports via source
  (transpiled by Next); API consumes `dist` (build first).

## Redis key layout (live game)

```
game:{id}              HASH  phase, joinCode, quizId, quizTitle, hostUserId, hostConnected,
                             currentQuestionId, questionStartedAt, questionEndsAt,
                             questionNumber, totalQuestions, answerCount,
                             resultQuestionId, correctOptionId
game:{id}:players      HASH  playerId -> JSON {nickname, score, connected, joinedAt}
game:{id}:answers      HASH  "playerId:questionId" -> "optionId,timestampMs,points"
game:{id}:counts       HASH  "questionId:optionId" -> count
game:{id}:questions    JSON  { list:[{id,text,timeLimit,options:[{id,text}]}], correct:{qid:optionId} }
leaderboard:{gameId}   ZSET  playerId -> score (live leaderboard)
```

Lua transitions enforce `GAME_TRANSITIONS` (constants.ts). Question start requires
`questionId === questions[questionNumber].id` (strict ordering).

## Commands (run from repo root unless noted)

> Your shell may lack nvm on PATH. Prefix node tooling with:
> `export PATH="$HOME/.nvm/versions/node/v22.23.3/bin:$PATH"`

- Generate client: `npm run db:generate`  (REQUIRED after any schema change; typecheck fails otherwise)
- Migrate: `npm run db:migrate` (dev) / `npm run db:deploy` (apply)
- Services: docker compose `postgres` + `redis`; full stack: `docker compose --profile app up -d --build`
- **Ports**: API :3001 · web dev :3002 (host :3000 is occupied by an unrelated app) · nginx :8080 ·
  compose redis host port :6380 (host redis :6379) · postgres :5432 (`postgresql://quiz:quiz@localhost:5432/quiz`)
- Dev API: `npm run dev:api` (tsx watch) · Dev web: `API_PROXY_TARGET=http://localhost:3001 npm run dev --workspace @quiz/web`
- Typecheck: `npm run typecheck` (all) — build `@quiz/shared` first when web is typechecked
- Build: `npm run build` (shared+api) · `npm run build:web`
- Tests: `npm run test:integration` (real PG+Redis, `fileParallelism:false`, DB reset in `beforeAll`)
- Lint: `npm run lint`

## Code conventions

- Strict TypeScript, ESM everywhere (`"type":"module"`, imports use `.js` suffixes in API code).
- Modules: transport (routes/sockets) thin; logic in `game/`, `players/`, `answers/`, `scoring/`,
  `leaderboard/`; DB access isolated in services.
- Errors: `AppError(code, message, status)` from `src/errors`; `parseWith(schema, value)` for validation;
  `sendError` shape `{ error: { code, message } }` reused for socket errors.
- Scoring: `scoringService.calculateScore({ timeLimit, startedAt, endsAt, now, correct })` —
  `round(BASE * (MIN_FRACTION + (1-MIN_FRACTION) * remainingFraction))`, wrong = 0. Config in env.
- Host commands accept optional `runId`; same `runId` for the same command type on the same game = no-op
  (idempotency). Keep a `lastRunId` field per game.
- Logging: `logGame("EVENT_NAME", { ... })` structured domain events; never log passwords/tokens.
- Web UI: dark zinc-950 theme, violet brand `#7c3aed`, `rounded-2xl` cards, `font-black` headings,
  `HostChrome` for page chrome, `RequireAuth` for host pages, `api()` helper for REST.

## Test / verify flow after any change

1. `npm run db:generate` (if schema touched) → `npm run typecheck`
2. targeted `npm run test:integration` (API) / `npm run test:unit`
3. `npm run build`, then Playwright smoke against the running dev web :3002
4. Update `plan.md` status; commit at phase/milestone boundaries only.

## Gotchas (learned the hard way)

- `@quiz/shared` must be built before API tests/typecheck consume `@quiz/shared` types from dist.
- Vitest 5: `--globalSetup` CLI flag is gone (use config); workers get `NODE_ENV=test`.
- `@fastify/cookie` cookie `secure` only when NODE_ENV is staging/production.
- Socket.IO connection-state recovery is enabled (2 min) — pair with `player_session` cookies for
  identity, not socket recovery alone.
- Avoid `pkill -f` patterns that match your own shell; use exact PID/port kills.
- `git` has no remote; commit messages follow the existing `Phase N: ...` style.