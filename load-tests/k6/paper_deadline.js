// Deadline-storm scenario: a SHORT paper (30s) so the global auto-submit fires
// for the whole cohort at once — exercises finalizePaper at peak cardinality.
//
//   k6 run -e URL=https://staging.example.com load-tests/k6/paper_deadline.js
//
// Unlike paper_ramp, players here answer lazily and the DEADLINE does the
// work: finalize + leaderboard are driven by the server's own timer.
// Env overrides for bounded runs: VUS (default 250), PAPER (seconds, default 30).
import http from "k6/http";
import { sleep } from "k6";
import {
  seedHostAndGame,
  joinGame,
  connectSocketio,
  emit,
  metrics,
} from "./common.js";

const PAPER_SECONDS = Number(__ENV.PAPER || 30);
const VUS = Number(__ENV.VUS || 250);

export const options = {
  scenarios: {
    cohort: {
      executor: "constant-vus",
      vus: VUS,
      duration: `${PAPER_SECONDS + 40}s`,
    },
  },
  thresholds: {
    http_req_duration: ["p(95)<1000"],
    ws_connect_ms: ["p(95)<2500"],
    ws_submit_scorecard_ms: ["p(95)<1500"],
  },
};

export function setup() {
  const seed = seedHostAndGame(PAPER_SECONDS);
  if (!seed) throw new Error("seed failed");
  return seed;
}

// Each k6 VU has its own JS runtime, so this flag is per-VU and makes a VU
// join+play exactly once (a real player does not re-join the same game).
let played = false;

export default function (seed) {
  if (played) return sleep(5);
  played = true;
  const nickname = `d${__VU}`; // joinGame appends -<ts>; nicknames capped at 24 chars
  const joined = joinGame(seed.joinCode, nickname);
  if (!joined) return;

  let tsub = 0;
  let answered = false;
  let gotScorecard = false;

  connectSocketio(joined.cookieHeader, {
    onOpen: (s) => emit(s, "player:sync", { gameId: joined.gameId }),

    "player:state": (state, s) => {
      if (state.phase === "ACTIVE" && !answered) {
        const q = state.questions[0];
        if (q) emit(s, "player:set-answer", {
          gameId: state.gameId,
          questionId: q.questionId,
          optionId: q.options[0].id,
        });
        answered = true;
      }
    },

    "player:set-answer-ack": (ack, s) => {
      if (ack.accepted) {
        tsub = Date.now();
        emit(s, "player:submit-paper", { gameId: joined.gameId });
      }
    },

    "player:scorecard": (_, s) => {
      metrics.submit.add(Date.now() - tsub);
      gotScorecard = true;
    },

    "game:finished": (_, s) => {
      if (!gotScorecard) metrics.submit.add(Date.now() - tsub);
      s.close();
    },
  });

  sleep(0.2);
}