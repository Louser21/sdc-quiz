# Quiz Live — Master Plan & Status Board

Production-ready real-time quiz platform (Kahoot-style) for events and classrooms.
Target: **1,000 concurrent players**, multiple rooms, hostile mobile networks.

Priorities (in order): **CORRECTNESS > RELIABILITY > SECURITY > RECOVERABILITY > PERFORMANCE > FEATURES**.

> Spec that drives everything: see the pinned project brief (§numbers below refer to it).
> Convention/command manual for agents: see `skill.md`.

---

## Definition of Done (spec §46) — live status

Legend: `[x]` done, `[~]` partial, `[ ]` not done.

- [x] Quiz CRUD works
- [x] Question CRUD works
- [x] Authentication works (host register/login, httpOnly sessions)
- [ ] Host flow works
- [ ] Player flow works
- [ ] Game PIN works
- [ ] Lobby works
- [ ] WebSocket communication works
- [ ] Server-authoritative timer works
- [ ] Server-authoritative scoring works
- [ ] Duplicate answers prevented
- [ ] Late answers rejected
- [ ] Reconnection works
- [ ] Refresh recovery works
- [ ] Network switching recovery tested
- [ ] Host recovery works
- [ ] Backend restart recovery tested
- [ ] Unauthorized operations rejected
- [ ] Rate limiting enabled
- [ ] Correct answers aren't exposed early
- [ ] PostgreSQL persistence works
- [ ] Redis live state works
- [ ] Backups configured
- [ ] Health endpoints work
- [ ] Structured logging works
- [ ] CI passes
- [ ] Docker deployment works
- [ ] Staging deployment works
- [ ] Production deployment documented
- [ ] 100-user load test passes
- [ ] 500-user load test passes
- [ ] 1,000-user load test passes
- [ ] Reconnect storm tested
- [ ] Simultaneous-answer test passes
- [ ] Final result persistence verified

---

## Phase 0 — Scaffolding (DONE, commit `648cf35`)

- Monorepo (npm workspaces): `apps/api` (Fastify + Socket.IO + Prisma 7 + ioredis), `apps/web` (Next.js), `packages/shared` (typed DTOs/events).
- Prisma schema + migration: User, Session, Quiz, Question, Option, GameSession, Player, Answer; enums `QuizStatus`, `GameSessionStatus`, `PlayerStatus`, `UserRole`.
- compose stack (postgres, redis, api, web, nginx on :8080), nginx single-origin reverse proxy, Dockerfiles, `.env.example`, Makefile, `docs/` skeleton.
- API shell with `/api/health` + `/api/ready` (PG + Redis checks), Socket.IO attached, global config via zod.

## Phase 1 — Auth + Quiz/Question CRUD (DONE, commits `73952f0`, `866a201`, `853a950`)

- Host auth: argon2id password hashing; random 32-byte session token, sha256 stored at rest, httpOnly `quiz_session` cookie; `register/login/logout/me`.
- Quiz CRUD: list, create (201), get detail, update, delete, publish/unpublish, duplicate (deep copy incl. options).
- Question CRUD: add, update (replace options), delete (P2003→CONFLICT), reorder (transactional positions).
- Shared zod DTOs; integration tests (19 passing) against real PG + Redis.
- Web host UI: dashboard, login/register, new quiz, editor (correct-answer radio, reorder, time limits); AuthProvider at root; `HostChrome` layout fix.

## Phase 2 — Game creation, join code, lobby, player sessions (IN PROGRESS)

- [ ] Shared: `SERVER_EVENTS` (typed server→client), game REST DTOs (`GameCreateDto`,
      `GameSessionSummaryDto`, `PlayerJoinDto/Result`).
- [ ] `config.ts`: `PLAYER_SESSION_COOKIE_NAME`.
- [ ] `game/store.ts`: Redis live state + Lua state machine (see `skill.md`), questions snapshot + correct map.
- [ ] `scoring/` (config-drive formula), `leaderboard/` (Redis sorted set), `answers/service.ts` (async PG persist).
- [ ] `players/session.ts` + `players/service.ts`: httpOnly player cookie, REST join, nickname rules, rejoin.
- [ ] `routes/games.routes.ts`, `routes/play.routes.ts`; register in `app.ts`.
- [ ] `sockets/handlers.ts`: cookie auth on connect, host room + ownership, player auto-room, presence.
- [ ] Web: `/play` client, `/games` + `/games/[id]/live` host, dashboard "Host".
- [ ] Gate: typecheck + build + integration tests + smoke.

## Phase 3 — Socket.IO state machine, questions, timers, answers, scoring, leaderboard

- [ ] `host:start-question` (strict order + `runId` idempotency), broadcast `game:question` (no correctness).
- [ ] Server-authoritative timer (auto-end) wired to `questionEndsAt`.
- [ ] `player:submit-answer`: atomic Lua (all checks), deadline boundary, duplicate protection (Redis + PG unique).
- [ ] `host:end-question`/auto-end → results (host counts + correct, per-player personal result), async PG batch.
- [ ] `host:end-game` → FINISHED, leaderboard persisted.
- [ ] Web: player question/answer/results screens; host question/results/leaderboard screens.
- [ ] Gate: unit (scoring, state machine, timer, join-code) + integration full game + E2E round.

## Phase 4 — Recovery (spec §19–26)

- [ ] Player reconnect on socket: cookie → player → game → full `PlayerGameStateView` (no fresh timer).
- [ ] Refresh / sleep / network-switch recovery (same player/score, no dupes).
- [ ] Host disconnect grace (`HOST_GRACE_PERIOD_MS`); host reconnect restores controls.
- [ ] Backend-restart restore: boot `restoreActiveGames()` from Redis; graceful shutdown order.
- [ ] Gate: reliability tests 1–10 automated.

## Phase 5 — Security, rate limiting, observability

- [ ] Rate limits: login/join/quiz CRUD (HTTP), answers (socket token bucket), host commands.
- [ ] Host↔player role separation; ownership checks on every privileged op.
- [ ] Structured `logGame` domain events (no secrets); `/metrics` (Prometheus text); `/health` + `/ready`.
- [ ] Gate: security tests.

## Phase 6 — Docker, CI/CD, deployment, backups, docs

- [ ] nginx TLS template + Cloudflare notes.
- [ ] GitHub Actions CI (install→lint→typecheck→unit→integration→build→docker build).
- [ ] `scripts/backup.sh` + `docs/database-backup.md`, **restore tested** on compose Postgres.
- [ ] Full `docs/` set (architecture, local-development, staging-deployment, production-deployment,
      disaster-recovery, load-testing, monitoring, troubleshooting, websocket-events, api).

## Phase 7 — Tests + load

- [ ] Complete unit/integration coverage; E2E Playwright full host→player game + refresh recovery.
- [ ] k6 WebSocket scenarios A–E, run 100 → 500 → 1000, record results in `docs/load-testing.md`;
      fix bottlenecks and re-run.

## Phase 8 — Hardening + final report

- [ ] Full §46 checklist; close gaps; `docs/final-report.md` (implemented, limitations+risks,
      measured capacity, security checks, deployment, remaining risks).

---

## Milestone check-ins

1. After Phase 3 gate (full game round-trip working).
2. After Phase 4 (all recovery tests green).
3. After load testing, before final report.

## Repo map

- `apps/api/src/` — auth/, quizzes/, questions/, game/ (store, host, player, state), players/, answers/,
  scoring/, leaderboard/, sockets/ (handlers), rate-limit/, logging/, routes/, config.ts, app.ts, index.ts.
- `apps/web/app/` — / (landing), /host, /dashboard, /quizzes, /games, /play.
- `packages/shared/src/` — constants.ts, dto.ts, events.ts, types.ts, validate.ts.
- `prisma/schema.prisma`, `apps/api/migrations/`.
- `infra/` — Dockerfiles + nginx. `load-tests/k6/`. `e2e/`. `.github/workflows/`.
- `docs/` — production docs. `scripts/`.