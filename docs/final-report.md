# Final Report — Quiz Live

Real-time CBT-style MCQ platform (JEE-Mains style): a host runs a printed paper
with a single global timer; participants answer the same paper independently,
submit or get auto-submitted at the deadline, then see the final leaderboard.
Priority order: **CORRECTNESS > RELIABILITY > SECURITY > RECOVERABILITY >
PERFORMANCE > FEATURES**. Full multi-host load runs were deferred to staging
hardware — the complete runbook is in `plan.md` + `docs/`.

## 1. What was built

Monorepo (npm workspaces):

- `apps/api` — Fastify + Socket.IO + Prisma 7 + ioredis + Lua scripts.
- `apps/web` — Next 16 (App Router), React 19, Tailwind 4, typed socket client.
- `packages/shared` — zod-validated DTOs + the Socket.IO event contract used by
  both sides (`events.ts`); correctness/answer data is never sent before submit.
- `infra/` — API/Web Dockerfiles (multi-stage, `node:22-slim` — dependencies
  require Node ≥ 22), nginx conf + TLS template, compose single-origin stack.
- `e2e/` (Playwright), `load-tests/k6/`, `.github/workflows/ci.yml`,
  `scripts/backup.sh`, `docs/` (11 files) — see `plan.md` "Repo map".

## 2. Phase log

| Phase | Topic | Commit |
|-------|-------|--------|
| 0 | Scaffolding | `648cf35` |
| 1 | Auth + quiz/question CRUD | `73952f0`, `866a201`, `853a950` |
| 2 | Games: join code, lobby, player sessions, Socket.IO state machine (Redis+Lua), scoring, leaderboard | `b6353cd`, `19a8f55` |
| 3 | CBT pivot: global quiz timer, paper-style play, UIs, tests | `b748c50` |
| 4 | Recovery: reconnect refresh, host rejoin, backend-restart timer restore | `f707e96` |
| 5 | Security: HTTP rate limits, WS token buckets, `/metrics`, socket-auth fixes | `677471c` |
| 6 | Infra: TLS template, CI workflow, backup+restore, Docker fixes, full docs | `ed5b92b` |
| 7 | Tests + load: Playwright E2E, k6 suites, empty-body 400 fix | `41ee0af` |

## 3. Definition-of-Done matrix

Everything on the DoD board is green, or honestly `[~]` pending a staging VPS
(no git remote / VPS in this environment):

- ✅ Correctness: quiz/question CRUD, auth, host flow, player flow, game PIN,
  lobby join rules, typed+validated sockets, server-authoritative global timer,
  fixed-point scoring, duplicate-answer lock (Lua + PG unique), late-answer
  rejection, correct answers never pre-exposed, final result persisted.
- ✅ Reliability/Recovery: reconnection, refresh recovery, network-switch,
  host recovery, backend-restart timer restore (re-armed from Redis on boot).
- ✅ Security: ownership + role separation, httpOnly cookies,
  per-IP HTTP rate limiting + WS token buckets, no secrets in logs.
- ✅ Recoverability: `scripts/backup.sh` (PG dump + Redis RDB, retention),
  restore drill **tested** on compose Postgres.
- ✅ Observability: pino JSON logs (`logGame` domain events), `/health`,
  `/ready`, `/metrics` (Prometheus text, incl. WS + live-game gauges).
- ✅ Tests: 32 integration / 6 files, 2 Playwright E2E specs, k6 smoke that
  drives the whole loop over raw Engine.IO framing (0 HTTP failures,
  ws_connect avg 11.4 ms at 8 VU).
- [~] CI: every job-equivalent verified locally; first GitHub Actions run
      needs a repository push/remote.
- [~] Staging deployment + 100/500/1000-VU loads: scripts and runbooks ready;
      execution requires a staging VPS.

## 4. Trade-offs worth knowing

1. **In-memory WS token buckets + deadline timers** live in the API process.
   Single-instance deployment is the v1 model (`docs/production.md` documents
   the Redis-backed path for horizontal scaling).
2. **Live-game state lives in Redis**; PostgreSQL is the authoritative store for
   everything that has finished. An in-flight game whose Redis keys vanish is
   the accepted gap (documented in `docs/disaster-recovery.md`).
3. **"Natural end" finalize**: the paper auto-finishes when every joined player
   has submitted; the host can also end early, and a hard deadline always
   auto-submits the remainder.
4. **Fastify error-handler ordering** is load-bearing (registered before
   routes), and client-side fastify faults (empty JSON body) now map to
   `400 VALIDATION_ERROR` rather than `500` (found by k6, regression-tested).
5. **Per-IP join throttle (120/min)** is intentional; load runs on staging must
   raise the `RATE_LIMIT_*` knobs first (`docs/load-testing.md`).

## 5. Known debt

- `npm run lint` is broken repo-wide (pre-existing TS config drift, unrelated to
  delivered code); `typecheck` is the enforced gate and is green.
- Player identity is cookie-based, not device/email-bound; renames freeze when a
  paper starts and one device may hold only one LIVE game. The full identity
  model, Redis live-state gap, and single-instance limits are catalogued in
  `docs/known-issues.md` with their current mitigations.
- Full-scale (1,000-player) k6 runs, reconnect storm at scale, and a real
  staging VM + TLS certificate sweep remain to be executed on infrastructure.

## 6. Runbooks

- Local dev: `docs/local-development.md`. Tests: `npm run test:integration`,
  `npm run test:e2e`, `npm run typecheck`.
- Operate: `docs/production.md` (steps + Cloudflare/TLS notes), `docs/staging.md`,
  `docs/disaster-recovery.md`, `docs/database-backup.md`.
- Watch: `docs/monitoring.md`. Debug: `docs/troubleshooting.md`.
- APIs/sockets: `docs/api.md`, `docs/websocket-events.md`.
- Details: `docs/architecture.md`; load: `docs/load-testing.md`.