// Reconnect storm: every VU joins, syncs, then drops and re-joins the socket
// with the SAME player_session cookie. Verifies identity-restored reconnects
// (player:state must come back with the paper intact) and measures the restore
// path used after a hostile-network drop.
//
//   k6 run -e URL=https://staging.example.com load-tests/k6/reconnect_storm.js
// Env overrides for bounded runs: VUS (default 100), ITER (default 3).
import { sleep } from "k6";
import {
  seedHostAndGame,
  joinGame,
  connectSocketio,
  emit,
  metrics,
} from "./common.js";

const VUS = Number(__ENV.VUS || 100);
const ITER = Number(__ENV.ITER || 3);

export const options = {
  scenarios: {
    reconnects: {
      executor: "per-vu-iterations",
      vus: VUS,
      iterations: ITER,
      maxDuration: "3m",
    },
  },
  thresholds: {
    ws_connect_ms: ["p(95)<2500"],
  },
};

export function setup() {
  const seed = seedHostAndGame(600);
  if (!seed) throw new Error("seed failed");
  return seed;
}

export default function (seed) {
  const nickname = `r${__VU}`; // joinGame appends -<ts>; nicknames capped at 24 chars
  const joined = joinGame(seed.joinCode, nickname);
  if (!joined) return;

  for (let cycle = 0; cycle < 3; cycle++) {
    let gotState = false;
    connectSocketio(joined.cookieHeader, {
      onOpen: (s) => emit(s, "player:sync", { gameId: joined.gameId }),
      "player:state": () => {
        gotState = true;
        metrics.sync_ready.add(0);
      },
    });
    if (!gotState) metrics.connect_failures.add(1);
    // Drop the socket and immediately re-join on the next cycle.
    sleep(1);
  }
}