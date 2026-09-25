// Tiny smoke validation of the k6 Socket.IO framing + host driver.
//   docker run --rm -v "$PWD/load-tests/k6:/k6" grafana/k6 run -e URL=http://host.docker.internal:8080 /k6/paper_smoke.js
import { sleep } from "k6";
import {
  seedHostAndGame,
  joinGame,
  connectSocketio,
  emit,
} from "./common.js";

export const options = {
  stages: [
    { duration: "10s", target: 8 },
    { duration: "5s", target: 0 },
  ],
};

export function setup() {
  const seed = seedHostAndGame(600);
  if (!seed) throw new Error("seed failed");
  return seed;
}

export default function (seed) {
  const joined = joinGame(seed.joinCode, `smoke-${__VU}`);
  if (!joined) return;

  connectSocketio(joined.cookieHeader, {
    onOpen: (s) => emit(s, "player:sync", { gameId: joined.gameId }),
    "player:state": (state, s) => {
      if (state.phase === "ACTIVE") {
        emit(s, "player:set-answer", {
          gameId: state.gameId,
          questionId: state.questions[0].questionId,
          optionId: state.questions[0].options[0].id,
        });
      }
    },
    "player:scorecard": (_, s) => s.close(),
  });

  if (__VU === 1) {
    connectSocketio(seed.cookieHeader, {
      onOpen: (s) => emit(s, "host:join-game", { gameId: seed.gameId }),
      "host:state": (state, s) => {
        if (state.phase === "LOBBY") {
          emit(s, "host:start-paper", { gameId: seed.gameId, runId: "smoke" });
        } else if (state.phase === "ACTIVE") {
          s.setTimeout(() => s.close(), 15_000);
        }
      },
    });
  }

  sleep(2);
}