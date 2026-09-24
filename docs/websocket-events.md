# WebSocket Events

Single `@quiz/shared` contract (`packages/shared/src/events.ts`) validates
**both** directions with zod. Socket path `/socket.io`, served by the API on
`:3001` (proxied by nginx at the single origin).

## Connection & identity

- Client connects; the server reads cookies from the handshake headers:
  - `quiz_session` → host identity (`socket.data.hostUserId`)
  - `player_session` → player identity (`playerId`, `sessionId`, `gameId`)
- Sockets act on identity resolved at **connect time**; every event is
  re-validated and re-authorized at dispatch time.

## Client → server (`CLIENT_EVENTS`)

| Event | Payload | Auth / rules |
|-------|---------|--------------|
| `player:sync` | `{}` | player identity — full `player:state` refresh |
| `player:heartbeat` | `{}` | player identity, throttled ≥5 s — liveness refresh |
| `player:set-answer` | `{ gameId, questionId, optionId }` | player; ACTIVE + not submitted + within deadline; atomic in Lua |
| `player:mark-review` | `{ gameId, questionId, marked }` | player; ACTIVE + own paper |
| `player:submit-paper` | `{ gameId }` | player; idempotent lock, then immutable |
| `host:join-game` | `{ gameId, runId? }` | host owner — joins room, emits `host:state` |
| `host:start-paper` | `{ gameId, runId? }` | host owner — LOBBY→ACTIVE, arms deadline timer |
| `host:end-paper` | `{ gameId, runId? }` | host owner — auto-submits all, finishes |
| `host:sync` | `{}` | host owner — fresh `host:state` for the current room |

`runId` is an optional idempotency shorthand for host commands. Empty-object
events tolerate an arg-less emit server-side (`payload ?? {}`).

## Server → client (`SERVER_EVENTS`)

| Event | Payload highlights |
|-------|--------------------|
| `player:state` | `phase`, `questions` (no correctness!), `selections`, `marked`, `deadline`, `scorecard`, `leaderboard` |
| `player:set-answer-ack` | `{ questionId, optionId, accepted, reason? }` — always echoed so the UI can revert |
| `player:scorecard` | submitted paper result `{ correctCount, totalQuestions, score, … }` |
| `game:finished` | `{ gameId, joinCode, quizTitle, leaderboard }` |
| `host:state` | lobby/players, `phase`, `deadline`, `leaderboard` |
| `host:paper-started` | `{ gameId, timeLimitSeconds, paperStartedAt, deadline }` |
| `host:player-updated` | `{ playerId, nickname, connected, submitted }` |
| `host:player-submitted` | `{ playerId, nickname, submittedCount }` |
| `host:game-finished` | `{ gameId, joinCode, quizTitle, leaderboard }` |
| `error` | `{ code, message }` — e.g. `RATE_LIMITED`, `NOT_IN_GAME`, `PAPER_NOT_ACTIVE` |

## Ordering & delivery notes

- **Selections are optimistic in the UI but validated server-side**; the ack
  drives the actual truth. On a rejected ack the client reverts.
- **Correct answers never travel before submit.** The `player:state.questions`
  omit `correct`; correctness only enters via `player:scorecard` after scoring.
- Deadline seats + room broadcasts piggyback on the authoritative Redis state;
  a `player:sync` / `host:sync` is always the source-of-truth refresh.
- Socket.IO connection-state recovery (2 min) is enabled — but identity comes
  from the cookie, not the recovery session.

## Rate limiting (server-side, outbound is unaffected)

- Player actions: token bucket 40 burst, 5/s refill per player. Exceeded →
  `error` `{ code: "RATE_LIMITED" }` (and `set-answer` acks `accepted:false`).
- Host commands: 10 burst, 1/s refill per game. Exceeded → `error` `RATE_LIMITED`.

## Typed client usage

```ts
// client -> server
import type { ClientToServerEvents, ServerToClientEvents } from "@quiz/shared";
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = /* ... */;
socket.emit("player:set-answer", { gameId, questionId, optionId });
socket.on("player:set-answer-ack", (ack) => { /* accepted? */ });
```