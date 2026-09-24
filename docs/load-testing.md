# Load Testing

Target: **1,000 concurrent players** on hostile mobile networks. k6 lives in
`load-tests/k6/`. Run against a staging box (or `docker compose --profile app
up` on a beefy machine) — never production.

## Setup

[k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) ≥ 0.48, or use the
container: `docker run --rm -v "$PWD/load-tests/k6:/k6" grafana/k6 run -e URL=… /k6/…`

Scenarios read `URL` (the single origin, e.g. `https://staging.example.com`).
They use the real HTTP + WebSocket paths: register → create/publish quiz →
create game → join → connect socket → start paper → answer → submit.

## Scenarios

### 1. Ramp to N concurrent players (`paper_ramp.js`, planned)

- Warm-up: `VU=1`.
- Profile: 5 min ramp 100 → 500 → 1000 sockets, then a 2-minute peak and
  drain. Each virtual user answers one question and submits; the deadline is
  set high so the run finishes naturally ("all submits" path).

### 2. Deadline storm (`paper_deadline.js`, planned)

- Uses a **short** paper timer (e.g. 30 s) so the global auto-submit fires for
  the whole cohort at once — exercises `finalizePaper` at peak cardinality
  (Lua auto-submit for all, PG bulk persist, leaderboard ZSET).

### 3. Reconnect storm (`reconnect_storm.js`, planned)

- Each VU opens a socket, drops it (`reconnect: false`), re-joins with the same
  `player_session` cookie → asserts the restored `player:state`. Measures the
  reconnect restore rate under load (phase-7 hardening).

## Metrics to record (docs/load-testing.md results table)

| Metric | Meaning |
|--------|---------|
| Socket connects/s | throughput of the handshake + Redis attach |
| `player:set-answer` P50/P95/P99 | answer latency through Lua + Redis |
| submit → scorecard latency P99 | end-to-end submit path |
| deadline-storm finalize duration | `finalizePaper` total time at peak |
| `quiz_live_players` at peak | observed concurrency (compare to target 1000) |
| CPU/mem of api + redis + pg | saturation headroom |
| failed connections / reconnects | hostile-network survival |

Also record event count from `GET /api/metrics` for an independent cross-check.

## Interpretation guide

- P99 latency under ~1.5 s for submit→scorecard at target concurrency: pass.
- Deadline finalize completing within ~3–5 s for 1000 papers: pass (Lua is
  single-shot; PG bulk `createMany` dominates).
- Any `quiz_ws_rate_limited_total` growth during a *legitimate* run means the
  token-bucket refill is too tight — raise `playerActionBucket` capacity in
  `src/sockets/token-bucket.ts`.

## Known bottlenecks to watch

1. `finalizePaper` → per-player `playerCount`/leaderboard sampling + PG persist —
   the biggest write hot-spot.
2. `pushPlayerStates` fans out a full `player:state` per player per event — it
   is per-player-id (not per-socket) already, but a 1000-room broadcast is O(n)
   JSON serializations.
3. `listLiveGameIds` (used by `/api/metrics` + boot restore) does a Redis SCAN —
   fine for ops, keep it out of hot paths.

Work is tracked in `plan.md` Phase 7; results are appended below when run.