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

Scripts live in `load-tests/k6/` and share `common.js` (REST seed, Engine.IO v4
WebSocket handshake over raw `k6/ws` — **no custom k6 binary needed**). All
scenarios: VU joins as a player via `POST /api/play/join` (gets the
`player_session` cookie), opens a Socket.IO socket (websocket transport),
`player:sync`s, answers, submits; VU #1 also connects as the seed host to
start/keep the paper ACTIVE.

> **Before running at scale**: the default per-IP join throttle is 120/min —
> a 1,000-VU run on one host will 429 everything. Raise the knobs on the
> target instance for the run (`RATE_LIMIT_ENABLED=false` or
> `RATE_LIMIT_JOIN_MINUTE=100000`), then restore them.

```sh
# smoke (small: 8 VUs, validates the whole loop)
docker run --rm -v "$PWD/load-tests/k6:/k6" --network host grafana/k6 run \
  -e URL=https://staging.example.com /k6/paper_smoke.js

# ramp to 1000 concurrent players
docker run --rm -v "$PWD/load-tests/k6:/k6" --network host grafana/k6 run \
  -e URL=https://staging.example.com /k6/paper_ramp.js

# deadline storm: 250 players × 30s paper → global auto-submit
docker run --rm -v "$PWD/load-tests/k6:/k6" --network host grafana/k6 run \
  -e URL=https://staging.example.com /k6/paper_deadline.js

# reconnect storm: join → sync → drop → re-join (same cookie), ×3
docker run --rm -v "$PWD/load-tests/k6:/k6" --network host grafana/k6 run \
  -e URL=https://staging.example.com /k6/reconnect_storm.js
```

### 1. Ramp to N concurrent players (`paper_ramp.js`)

Stages 100 → 1000 → 1000 (2 min) → 0. Each VU answers one question and
submits; the paper is long (10 min) so the run exercises the alive-ACTIVE path
plus the natural-end finishes.

### 2. Deadline storm (`paper_deadline.js`)

- 30-second paper so the global auto-submit fires for the whole cohort at once —
  exercises `finalizePaper` at peak cardinality (Lua auto-submit for all, PG
  bulk persist, leaderboard ZSET).

### 3. Reconnect storm (`reconnect_storm.js`)

- Each VU opens a socket, drops it, re-joins with the same `player_session`
  cookie → asserts the restored `player:state`. Measures the reconnect restore
  rate under load (phase-7 hardening).

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

## Results so far (local smoke, 2026-09-24, compose stack)

| Metric | Observed |
|--------|----------|
| HTTP req failures | 0 / 13 (seed + 8 joins) |
| `ws_connect_ms` (socket.io connected) | avg 11.4 ms · p95 26.8 ms |
| ws messages in/out | 44 / 19 across 9 sockets (sync→state→answer→ack→scorecard verified) |

Full 100–1000 VU runs require staging hardware (local compose box is the
platform's bottleneck); record them here with the table from "Metrics to record"
when run.