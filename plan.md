# Quiz Live — Master Plan & Status Board

Real-time CBT-style MCQ paper platform (JEE-Mains style): a host runs a printed paper with a single
global timer; participants answer the same paper independently, submit or get auto-submitted at the
deadline, then see a final leaderboard. Target: **1,000 concurrent players**, hostile mobile networks.

Priorities (in order): **CORRECTNESS > RELIABILITY > SECURITY > RECOVERABILITY > PERFORMANCE > FEATURES**.

> Convention/command manual for agents: see `skill.md`.

---

## Definition of Done — live status

Legend: `[x]` done, `[~]` partial, `[ ]` not done.

- [x] Quiz CRUD works (incl. quiz-level `timeLimitSeconds`, 60 s – 120 min)
- [x] Question CRUD works (no per-question timers)
- [x] Authentication works (host register/login, httpOnly sessions)
- [x] Host flow works (lobby → start paper → submitted count + live results → end → FINISHED)
- [x] Player flow works (paper: navigator, A–D options, mark-for-review, countdown, submit, scorecard)
- [x] Game PIN works
- [x] Lobby works (fresh joiners only while LOBBY; rejoin allowed through ACTIVE)
- [x] WebSocket communication works (typed, zod-validated both directions)
- [x] Server-authoritative timer works (global deadline; auto-submit on expiry)
- [x] Server-authoritative scoring works (fixed points: `SCORE_BASE` per correct, 0 wrong)
- [x] Duplicate answers prevented (atomic submit lock; PG unique `(gameId, playerId, questionId)`)
- [x] Late answers rejected (`PAPER_ENDED` / `PLAYER_ALREADY_SUBMITTED`, enforced in Lua)
- [x] Reconnection works
- [x] Refresh recovery works
- [x] Network switching recovery tested
- [x] Host recovery works (paper runs on without the host; rejoin restores console)
- [x] Backend restart recovery tested (boot re-arms deadline timers from Redis)
- [x] Unauthorized operations rejected (ownership + role separation)
- [x] Rate limiting enabled (HTTP per-IP plugin + WS token buckets)
- [x] Correct answers aren't exposed early (never sent before submit)
- [x] PostgreSQL persistence works (papers, scores, FINISHED sessions)
- [x] Redis live state works
- [x] Backups configured (`scripts/backup.sh` + retention; restore tested on compose Postgres)
- [x] Health endpoints work
- [x] Structured logging works
- [x] `/metrics` endpoint (Prometheus text) works
- [~] CI passes (workflow added; every job-equivalent ran green locally — typecheck,
      integration 32/6, docker `compose build api web`, E2E 2/2 — first GitHub Actions run pending repo push)
- [x] Docker deployment works (compose `--profile app` verified: nginx→api→web, sockets, health/ready/metrics)
- [~] Staging deployment works (compose-stack deployment exercised; staging VM sweeps outstanding)
- [x] Production deployment documented
- [~] 100 / 500 / 1,000-user load runs (k6 scripts written, smoke-validated at 8 VU; full-scale run deferred to staging hardware)
- [~] Reconnect storm tested (E2E refresh recovery green; k6 reconnect-storm script ready for staging)
- [x] Simultaneous-submit race tested (Lua atomic lock + PG unique + integration tests)
- [x] Final result persistence verified

---

## Phase 0 — Scaffolding (DONE, commit `648cf35`)

- Monorepo (npm workspaces): `apps/api` (Fastify + Socket.IO + Prisma 7 + ioredis), `apps/web` (Next.js), `packages/shared` (typed DTOs/events).
- Prisma schema + migration: User, Session, Quiz, Question, Option, GameSession, Player, Answer; enums.
- compose stack (postgres, redis, api, web, nginx on :8080); API shell with `/api/health` + `/api/ready`.

## Phase 1 — Auth + Quiz/Question CRUD (DONE, commits `73952f0`, `866a201`, `853a950`)

- Host auth (argon2id, httpOnly session cookie); quiz CRUD incl. publish + duplicate; question CRUD incl. reorder.
- Shared zod DTOs; integration tests; web host UI (dashboard, login/register, new quiz, editor).

## Phase 2 — Game creation, join code, lobby, player sessions (DONE, commits in `git log`)

- `SERVER_EVENTS` (typed), game REST DTOs, player session cookie + REST join with nickname rules + rejoin.

## Phase 3 — CBT paper pivot: connected engine, UIs, tests (DONE)

Product pivot from Kahoot live-question rounds to a JEE-Mains CBT-style paper. Migration
`20260924120000_add_quiz_time_limit` drops `Question.timeLimit`, adds `Quiz.timeLimitSeconds` (DEFAULT 600).
Phases reduced to `LOBBY → ACTIVE → FINISHED`.

- [x] Shared contracts rewritten (`constants.ts` `QUIZ_TIME_LIMIT_SCHEMA`, `GAME_PHASES`, `GAME_TRANSITIONS`;
      `dto.ts`, `types.ts` `PaperQuestionView`/`PlayerGameStateView`/`HostGameStateView`/`PlayerScorecard`;
      `events.ts` typed client/server registries).
- [x] `game/store.ts`: Redis hash layout + Lua scripts — `startPaper` (LOBBY→ACTIVE w/ deadline),
      `setAnswer`/`markReview` (ACTIVE + before deadline + not submitted), `submitPaper` (atomic lock,
      idempotent), `autoSubmitRemaining`, `finishGame`.
- [x] `game/host.ts`: `startPaper`, `endPaper`, `finalizePaper` (auto-submit all, score, FINISHED, persist,
      samples leaderboard from post-score state).
- [x] `game/player.ts`, `game/state.ts`: selection/mark/submit; full paper view (no correctness), scorecard,
      host view.
- [x] `answers/service.ts`: async PG persist of papers + final results; `players/service.ts` LOBBY-only fresh join.
- [x] `sockets/handlers.ts`: deadline timers (`paperTimers`), `finalizePaperFlow`, natural early finish when all
      submitted, boot-time `restoreActiveTimers`.
- [x] Scoring: fixed points (`scoreForCorrectness`), `isWithinPaperDeadline(now < deadline)`.
- [x] Web: quiz editor + new-quiz total-time field; host live console; player paper UI.
- [x] Integration tests rewrite: full 2-question paper flow, natural early finish, real deadline auto-submit
      (2 s paper via direct Redis tweak), persistence checks — 25 passing.
- Gate: `typecheck` (shared→api→web) + `npm test -w @quiz/api` green.

## Phase 4 — Recovery (DONE, commit in `git log`)

- [x] Player reconnect on socket: cookie → player → game → full `PlayerGameStateView` (selections, marks,
      submission, scorecard all restored from Redis; post-submit edits still rejected atomically).
- [x] Refresh / sleep / network-switch recovery (same player/score/submission; re-submit is an idempotent
      no-op; exactly one paper persisted per player under reconnect storms).
- [x] Host disconnect policy: the deadline timer is authoritative and the paper keeps running without the
      host; `HOST_GRACE_PERIOD_MS` (default 120 s) is kept as the documented warm-window knob — a
      disconnected host rejoins the console via `host:join-game` → fresh `host:state` at any phase.
- [x] Backend restart restore test: paper is started on process A with a 3 s deadline, A is torn down, a
      fresh process B against the same Redis re-arms the orphaned deadline timer and auto-submits +
      finalizes the paper for every player; termination state is persisted to PG.
- [x] Gate: `recovery.test.ts` — reconnect restore, post-submit immutability across reconnects, host
      reconnect restores controls, backend restart; full suite 28 passing.

## Phase 5 — Security, rate limiting, observability (DONE, commit in `git log`)

- [x] HTTP rate limiting: `@fastify/rate-limit` global floor (default 600/min per IP) + stricter per-route
      buckets on `POST /api/auth/login` (30/min) and `/register` (30/min), and `POST /api/play/join`
      (120/min). `errorResponseBuilder` returns an `AppError("RATE_LIMITED", …, 429)` (the plugin
      THROWS the builder's return, so it must be an AppError for the shared error handler to emit the
      standard `{error:{code,message}}` envelope — see `app.ts`).
- [x] Config knobs in `config.ts` + `.env.example`: `RATE_LIMIT_ENABLED`, `_GLOBAL_MINUTE`, `_LOGIN_MINUTE`,
      `_REGISTER_MINUTE`, `_JOIN_MINUTE`; `buildApp({ rateLimit: {...} })` overrides for headless tests.
- [x] Socket token buckets (`sockets/token-bucket.ts`, in-memory, documented per-instance trade-off):
      player actions (set-answer/mark-review/submit/heartbeat) burst 40 @ 5/s per player; host commands
      (join/start/end) burst 10 @ 1/s per game. Exceeded events → `error` `RATE_LIMITED` (set-answer also
      acks `accepted:false` so the optimistic client UI reverts).
- [x] Audit fixes: `player:heartbeat` and `player:sync` payloads are now actually validated; `host:sync`
      validates its payload AND is gated by `requireHostOwnedGame` (previously any authed host could sync
      any room). Empty-object events tolerate arg-less emits (`payload ?? {}`).
- [x] Observability: `observability/metrics.ts` (zero-dependency Prometheus registry) — counters
      `quiz_http_requests_total{method,route,status}`, `quiz_ws_events_total{event}`,
      `quiz_ws_rate_limited_total{event}`, `quiz_ws_connections_total{direction}`, gauges `quiz_live_games`
      / `quiz_live_players` sampled at scrape; exposed at `GET /api/metrics` (text/plain) via `routes/health.ts`.
- [x] Tests: `rate-limit.test.ts` — per-route join/login 429s + exact envelope, `/metrics` content, WS
      flood → RATE_LIMITED + metric reflection. Full suite 32 passing (6 files).
- [x] Gate: `typecheck` (shared→api→web) + `npm test -w @quiz/api` green.

## Phase 6 — Docker, CI/CD, deployment, backups, docs (DONE, commit `ed5b92b`)

- [x] nginx TLS template + Cloudflare notes — `infra/nginx/production.conf` (TLS,
      HSTS, CF `set_real_ip_from` ranges, `real_ip_header CF-Connecting-IP`) +
      `docs/production.md`.
- [x] GitHub Actions CI — `.github/workflows/ci.yml`: lint (non-blocking, broken
      repo-wide), typecheck, unit+integration (Postgres+Redis services), web typecheck,
      Docker image build. First green run pending repo push.
- [x] `scripts/backup.sh` + `docs/database-backup.md` — PG custom-format dump +
      Redis RDB snapshot, `KEEP_N` retention, cron snippet; **restore tested** on
      compose Postgres (pg_restore into fresh DB, verified rows, dropped).
- [x] Full `docs/` set: architecture, local-development, staging, production,
      disaster-recovery, load-testing, monitoring, troubleshooting, websocket-events, api.
- [x] Dockerfile fixes discovered by CI-drilling: `node:22-slim` (deps require
      Node ≥22 — argon2/cookie/vitest EBADENGINE) + python3/make/g++ in the API
      build stage for the argon2 native addon. `docker compose --profile app`
      verified end-to-end (nginx→api→web, socket.io handshake, health/ready/metrics).

## Phase 7 — Tests + load (DONE, commit `41ee0af`)

- [x] **Playwright E2E** — `e2e/paper.spec.ts` (host registers → creates/publishes
      quiz → hosts → player joins/answers/submits → natural auto-finalize on
      all-submitted → both sides see the final leaderboard) and
      `e2e/recovery.spec.ts` (player refresh mid-paper restores server-side
      selections via cookie re-identification + `player:sync`, then can still
      submit). 2 specs green vs the compose stack (`npm run test:e2e`,
      ~12 s). `npm run test:e2e` added.
- [x] **k6 load scripts** (`load-tests/k6/`): `common.js` (REST seed + raw
      Engine.IO v4 websocket client over `k6/ws` — no custom binary), plus
      `paper_ramp.js` (100→1000), `paper_deadline.js` (250×30s auto-submit
      storm), `reconnect_storm.js` (cookie-restored reconnects), `paper_smoke.js`
      (CI smoke). Smoke validated end-to-end vs compose: 0 HTTP failures,
      ws_connect avg 11.4 ms, sync→state→answer→ack→scorecard all driven over
      raw sockets. Full 1000-VU runs deferred to staging hardware (see
      `docs/load-testing.md`).
- [x] **Bug found via k6, fixed + regression-tested**: `POST` with an empty JSON
      body (e.g. publish) returned `500 INTERNAL_ERROR`; Fastify's
      `FST_ERR_CTP_EMPTY_JSON_BODY` isn't `err.validation`, so the handler
      misclassified it. Now any fastify client-status (4xx) becomes
      `400 VALIDATION_ERROR`. Regression test added (integration 32/6 green).

## Phase 8 — Hardening + final report (CURRENT)

- [x] §46 DoD review + close resolvable gaps (duplicate DoD block removed; honest
      `[~]`s for staging/scale items that need a VPS).
- [x] Lint: `npm run lint` is broken repo-wide (pre-existing, unrelated ts config
      drift); typecheck is the enforced gate and is green — documented in
      `docs/final-report.md` as the one known-debt item.
- [x] `docs/final-report.md` written (system summary, DoD matrix, trade-offs, runbooks).
- [x] Final commit + milestone check-in ("After load testing, before final report" → complete).

---

## Milestone check-ins

1. After Phase 3 gate (full paper round-trip working). — DONE (25 integration tests green)
2. After Phase 4 (all recovery tests green). — DONE (28 integration tests green)
3. After load testing, before final report. — DONE (k6 smoke + E2E; full-scale deferred to staging)

> Phase 5 gate also green: 32 integration tests (adds rate limiting + metrics + WS token buckets).
> Phase 7 gate also green: E2E 2/2 + k6 smoke on raw Engine.IO framing + 32/6 integration + typecheck.

## Repo map

- `apps/api/src/` — auth/, quizzes/, questions/, game/ (store, host, player, state), players/, answers/,
  scoring/, leaderboard/, sockets/ (handlers), rate-limit/, logging/, routes/, config.ts, app.ts, index.ts.
- `apps/web/app/` — / (landing), /host, /dashboard, /quizzes, /games, /play, /join.
- `packages/shared/src/` — constants.ts, dto.ts, events.ts, types.ts, validate.ts.
- `prisma/schema.prisma`, `prisma/migrations/`.
- `infra/` — Dockerfiles + nginx. `load-tests/k6/`. `e2e/`. `.github/workflows/`.
- `docs/` — production docs. `scripts/`.