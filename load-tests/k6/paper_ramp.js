// Ramp-up Socket.IO load test: players join a single live game, connect
// sockets, sync state, answer and submit.
//
//   k6 run -e URL=https://staging.example.com load-tests/k6/paper_ramp.js
//
// VU #1 doubles as the host driver: it connects with the seed host cookie,
// starts the paper shortly into the ramp and keeps it ACTIVE through the peak.
// Env overrides for bounded runs: PEAK (default 1000 VUs), HOLD (default 120s).
import http from "k6/http";
import { sleep } from "k6";
import {
  URL_BASE,
  seedHostAndGame,
  joinGame,
  connectSocketio,
  emit,
  metrics,
} from "./common.js";

const PEAK = Number(__ENV.PEAK || 1000);
const HOLD = Number(__ENV.HOLD || 120);

export const options = {
  vus: 50,
  stages: [
    { duration: "30s", target: 100 },
    { duration: "60s", target: PEAK },
    { duration: `${HOLD}s`, target: PEAK },
    { duration: "30s", target: 0 },
  ],
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    ws_connect_ms: ["p(95)<2000"],
    ws_answer_ack_ms: ["p(95)<1500"],
  },
};

export function setup() {
  const seed = seedHostAndGame(600);
  if (!seed) throw new Error("seed failed");
  return seed;
}

// Each k6 VU has its own JS runtime, so this flag is per-VU and makes a VU
// join+play exactly once (a real player does not re-join the same game).
let played = false;

export default function (seed) {
  if (played) return sleep(5);
  played = true;
  const nickname = `p${__VU}`; // joinGame appends -<ts>; nicknames capped at 24 chars
  const joined = joinGame(seed.joinCode, nickname);
  if (!joined) return;

  const tsync = Date.now();
  let submitted = false;
  let tans = 0;
  let tsub = 0;

  connectSocketio(joined.cookieHeader, {
    onOpen: (s) => emit(s, "player:sync", { gameId: joined.gameId }),

    "player:state": (state, s) => {
      if (state.phase === "ACTIVE" && !submitted) {
        metrics.sync_ready.add(Date.now() - tsync);
        const q = state.questions[0];
        if (q) {
          tans = Date.now();
          emit(s, "player:set-answer", {
            gameId: state.gameId,
            questionId: q.questionId,
            optionId: q.options[0].id,
          });
        }
      }
    },

    "player:set-answer-ack": (ack, s) => {
      if (!ack.accepted) return;
      metrics.answer.add(Date.now() - tans);
      tsub = Date.now();
      emit(s, "player:submit-paper", { gameId: joined.gameId });
    },

    "player:scorecard": (_, s) => {
      metrics.submit.add(Date.now() - tsub);
      submitted = true;
      s.close();
    },
  });

  // Host driver duties (only VU #1, which also joined as a player above).
  if (__VU === 1) {
    connectSocketio(seed.cookieHeader, {
      onOpen: (s) => emit(s, "host:join-game", { gameId: seed.gameId }),
      "host:state": (state, s) => {
        if (state.phase === "LOBBY") {
          emit(s, "host:start-paper", { gameId: seed.gameId, runId: "ramp" });
        } else if (state.phase === "ACTIVE") {
          s.setTimeout(() => s.close(), 60_000);
        }
      },
    });
  }

  sleep(0.2);
}