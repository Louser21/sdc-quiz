import * as store from "../game/store.js";

/**
 * Minimal Prometheus-style metrics registry. No external dependency: counters
 * and gauges live in memory and are rendered as plain Prometheus text on
 * GET /api/metrics. Labels are stored as a single composite key to keep the
 * hot path allocation-light.
 */

type Labels = Record<string, string | number>;

const ESCAPE_RE = /\\/g;

function escapeLabelValue(value: string | number): string {
  return String(value).replace(ESCAPE_RE, "\\\\").replace(/"/g, '\\"');
}

class Metrics {
  private counters = new Map<string, number>();

  inc(name: string, labels: Labels = {}, delta = 1): void {
    const key = labelKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + delta);
  }

  snapshot(): Map<string, number> {
    return new Map(this.counters);
  }
}

function labelKey(name: string, labels: Labels): string {
  if (Object.keys(labels).length === 0) return `${name}{}`;
  const parts = Object.entries(labels)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}="${escapeLabelValue(v)}"`);
  return `${name}{${parts.join(",")}}`;
}

export const metrics = new Metrics();

export function countHttpRequest(method: string, route: string, status: number): void {
  metrics.inc("quiz_http_requests_total", { method, route, status });
}

export function countWsEvent(event: string): void {
  metrics.inc("quiz_ws_events_total", { event });
}

export function countWsRateLimited(event: string): void {
  metrics.inc("quiz_ws_rate_limited_total", { event });
}

export function countWsConnection(direction: "connect" | "disconnect"): void {
  metrics.inc("quiz_ws_connections_total", { direction });
}

/**
 * Render the current counters plus live gauges (sampled at scrape time) as
 * Prometheus text/plain. Blocking Redis reads are acceptable here — this is an
 * ops/admin endpoint, not a hot path.
 */
export async function renderPrometheusText(): Promise<string> {
  const ids = await store.listLiveGameIds();
  let livePlayers = 0;
  for (const id of ids) {
    try {
      livePlayers += await store.playerCount(id);
    } catch {
      // continue sampling the rest of the games
    }
  }
  const lines: string[] = [];
  lines.push("# HELP quiz_live_games Games currently live in Redis.");
  lines.push("# TYPE quiz_live_games gauge");
  lines.push(`quiz_live_games ${ids.length}`);
  lines.push("# HELP quiz_live_players Players currently attached to live games.");
  lines.push("# TYPE quiz_live_players gauge");
  lines.push(`quiz_live_players ${livePlayers}`);
  lines.push("# HELP quiz_http_requests_total Total HTTP requests handled.");
  lines.push("# TYPE quiz_http_requests_total counter");
  lines.push("# HELP quiz_ws_events_total Total validated WebSocket events handled.");
  lines.push("# TYPE quiz_ws_events_total counter");
  lines.push("# HELP quiz_ws_rate_limited_total WebSocket events rejected by the token bucket.");
  lines.push("# TYPE quiz_ws_rate_limited_total counter");
  lines.push("# HELP quiz_ws_connections_total WebSocket connect/disconnect count.");
  lines.push("# TYPE quiz_ws_connections_total counter");
  for (const [key, value] of metrics.snapshot()) {
    lines.push(`${key} ${value}`);
  }
  return lines.join("\n") + "\n";
}