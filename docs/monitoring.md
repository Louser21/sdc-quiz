# Monitoring

## Endpoints

| Endpoint | Purpose | Auth |
|----------|---------|------|
| `GET /api/health` | Liveness — returns `{"status":"ok","uptime":…,"now":…}` | none |
| `GET /api/ready` | Readiness — probes Redis + Postgres; `200`/`503` | none |
| `GET /api/metrics` | Prometheus text exposition (see below) | none (ops net) |

## Metrics (Prometheus text at `/api/metrics`)

Counters (from the `@quiz/api` process; zero-dependency registry in
`src/observability/metrics.ts`):

| Metric | Labels | Meaning |
|--------|--------|---------|
| `quiz_http_requests_total` | `method`, `route`, `status` | every `/api` request, by route pattern + status |
| `quiz_ws_events_total` | `event` | validated inbound WebSocket events |
| `quiz_ws_rate_limited_total` | `event` | WS events dropped by the token bucket |
| `quiz_ws_connections_total` | `direction` (`connect`/`disconnect`) | socket churn |

Gauges (sampled live at scrape time):

| Gauge | Meaning |
|-------|---------|
| `quiz_live_games` | games currently held in Redis (LOBBY/ACTIVE/FINISHED) |
| `quiz_live_players` | players attached to those games |

Example:

```
# TYPE quiz_http_requests_total counter
quiz_http_requests_total{method="POST",route="/api/play/join",status="200"} 42
quiz_http_requests_total{method="POST",route="/api/play/join",status="429"} 3
quiz_ws_events_total{event="player:set-answer"} 8123
quiz_live_games 5
quiz_live_players 87
```

## Scrape with Prometheus

```yaml
scrape_configs:
  - job_name: quiz-api
    scheme: https
    static_configs:
      - targets: ["quiz.example.com"]
    metrics_path: /api/metrics
    authorization:
      # optional: protect /api/metrics with a reverse-proxy basic-auth rule
      credentials: <token>
```

Dashboards (Grafana) that matter:

1. **Errors** — `sum(rate(quiz_http_requests_total{status=~"5.."}[5m]))`
2. **Cardinality of 429s** — by `route`; sudden jump = brute-force/fuzz attempt
3. **WS health** — `quiz_ws_connections_total{status="disconnect"}`
   vs `connect` (gaps = flaky devices), plus `quiz_ws_rate_limited_total`
4. **Live pool** — `quiz_live_games`, `quiz_live_players`
5. **Latency** — nginx `$upstream_response_time`, or add a histogram if needed

## Alerts (suggested)

- `quiz_http_requests_total{status=~"5.."}` rate > 0 for 2 min → API error spike
- `/api/ready` 503 for > 1 min → infra degraded
- `quiz_live_games == 0` at scheduled paper hours → nobody can host/join
- Disk usage on the VM (`backups/`) → backups may fail silently

## Logs

pino JSON on stdout (container `docker compose logs api`). Domain events use
`logGame("EVENT_NAME", …)` keys: `PAPER_STARTED`, `PAPER_SUBMITTED`,
`PAPER_FINISHED`, `PLAYER_CONNECTED/DISCONNECTED`, `HOST_CONNECTED/DISCONNECTED`,
`GAME_RESTORED`, `SELECTION_SET`, `SELECTION_REJECTED`, `GAME_CREATED`, …
Never log passwords/tokens. Ship `api` + `web` + `nginx` logs to your log
aggregator (Loki/ES) with the container labels preserved.