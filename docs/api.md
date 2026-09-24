# API Reference

Base URL: `/api` at the single origin (proxy → API `:3001`). Content-Type
`application/json`. Errors always carry the envelope:

```json
{ "error": { "code": "UNAUTHORIZED", "message": "..." } }
```

Common codes: `VALIDATION_ERROR` 400 · `UNAUTHORIZED` 401 · `FORBIDDEN` 403 ·
`NOT_FOUND` 404 · `CONFLICT` 409 · `INVALID_GAME_CODE` 404 ·
`GAME_NOT_JOINABLE` 409 · `NICKNAME_TAKEN` 409 · `GAME_FINISHED` 409 ·
`RATE_LIMITED` 429 · `INTERNAL_ERROR` 500.

## Auth

### `POST /api/auth/register`
Body `{ email, name, password }` → `201 { user: { id, email, name, role } }`; sets `quiz_session` cookie.

### `POST /api/auth/login`
Body `{ email, password }` → `200 { user }`; sets `quiz_session` cookie.

### `POST /api/auth/logout`
Cookie required. → `200 { ok: true }`; clears cookie.

### `GET /api/auth/me`
Cookie required → `200 { user }` or 401.

## Quizzes (host auth required)

### `POST /api/quizzes`
Body `{ title, description?, timeLimitSeconds? }` (default paper limit from
config) → `201 { quiz }`. Owner-scoped.

### `GET /api/quizzes` · `GET /api/quizzes/:id`
Owner-scoped listing / detail. `:id` returns `questions` with `isCorrect` flags
(owner-only; players never see this over REST).

### `PATCH /api/quizzes/:id` · `DELETE /api/quizzes/:id`
Rename/reset/delete. Owner-only.

### `POST /api/quizzes/:id/publish` · `POST /api/quizzes/:id/unpublish`
Publish (must have ≥1 question) / draft again.

### `POST /api/quizzes/:id/questions`
Body `{ text, options: [{ text, isCorrect }] }` → `200`. 2–4 options, ≥1 correct.

### `PATCH /api/questions/:id`
Update question text/options.

### `DELETE /api/quizzes/:id/questions/:questionId`

### `POST /api/quizzes/:id/questions/reorder`
Body `{ questionIds: string[] }` — persists order.

### `POST /api/quizzes/:id/duplicate`
Clones the quiz (new owner-scoped draft) → `201 { quiz }`.

## Games (host auth required)

### `POST /api/games`
Body `{ quizId }` → `201 { game: { id, joinCode } }`. Only for a **published**
quiz owned by the caller. Join code is 6 chars (A–Z, 2–9).

### `GET /api/games` · `GET /api/games/:id`
Owner-scoped list / detail.

Real-time driving of a game is via WebSockets (`docs/websocket-events.md`).
Create → join → start-paper → … → finished is the standard loop.

## Play (public — no auth)

### `POST /api/play/join`
Body `{ gameCode, nickname }` → `200 { join: { gameId, gameCode?, quizTitle,
deadline?, phase, player: { playerId } } }`.

- Sets the httpOnly `player_session` cookie (the socket layer uses it).
- Nickname rules: unique among active players; rejoining with the same cookie
  keeps the **same playerId** (re-choice of nickname allowed).
- Fresh joins only while LOBBY; active players may rejoin through ACTIVE;
  FINISHED games refuse (`GAME_FINISHED`).

## Ops

### `GET /api/health`
`200 { status: "ok", uptime, now }`

### `GET /api/ready`
`200 { status: "ready", checks: { redis, database } }` / `503` when degraded.

### `GET /api/metrics`
Prometheus text (`docs/monitoring.md`).

## Rate limits (per source IP)

| Route(s) | Default |
|----------|---------|
| global floor (all `/api`) | 600/min |
| `POST /api/auth/login` | 30/min |
| `POST /api/auth/register` | 30/min |
| `POST /api/play/join` | 120/min |

Over-limit → `429 RATE_LIMITED` (configurable in `.env`; `RATE_LIMIT_ENABLED=0`
disables). Socket events have their own token buckets — see
`docs/websocket-events.md`.