# Known Issues & Deferred Work

Status: these are accepted limitations of the v1 single-instance release. They
are deliberately deferred, either because they need infrastructure we don't
have yet or because they change the identity model fundamentally. Each entry
lists the current mitigation so an operator knows what behavior to expect.

## 1. Cheap per-device identity (no email/device binding)

**Issue.** Player identity is an httpOnly cookie (`player_session`). A human can
therefore hold several slots in the same game by using incognito windows or a
fresh browser (each with a different nickname), and can re-enter as a "new"
player. There is also no way for a host to remove/kick a player or free a
reserved nickname; a slot is reserved for the cookie's lifetime (7 days) even
if that player has gone forever.

**Mitigated now (temp checks):**
- Nickname is frozen once the paper starts (renames only while in the lobby) —
  no name tampering after scoring begins.
- A device already in a *live* game (lobby or active) is refused when trying to
  join a different game (`ALREADY_IN_GAME`), so one browser can't silently hop
  between papers and tab-identity theft is blocked. The old session is released
  only once that game finishes.
- Duplicate nicknames in the same game are impossible (DB unique constraint),
  so each slot has a visible identity during play.

**Proper fix (future):** strict per-device / per-email players. Bind players to
an account (hosted or one-tap), enforce one active session per device, and give
hosts a kick/ban action. This is a schema + identity-model change.

## 2. Single live player session per device

**Issue.** The one `player_session` cookie can only point at one game at a time.
Being in two live papers across two tabs of the same browser is not supported —
joining the second is now refused (see #1) rather than silently replacing the
first.

## 3. Live-game state lives in Redis only

**Issue.** LOBBY/ACTIVE paper state (players, selections, countdowns) is kept in
Redis and rebuilt into PG only at finalize. Wiping Redis or losing the Redis
instance mid-paper loses in-progress games. Finished games are safe (persisted
to PG).

**Proper fix (future):** snapshot live games to PG on an interval, or run Redis
with AOF + replication. See `docs/disaster-recovery.md`.

## 4. Per-instance timers and rate buckets

**Issue.** Paper-day deadline timers and WS token buckets live in the API
process's memory. Restarting the API re-arms timers from Redis (supported), but
true horizontal scaling to multiple API instances is not yet supported — the
Redis-lock and shared-state design is the path, but the deployment model is
single-API-instance for v1.

## 5. In-memory HTTP rate limits

**Issue.** `@fastify/rate-limit` uses an in-memory store by default. It protects
a single instance; a multi-instance deployment needs Redis-backed limits.

## 6. Full-scale load & staging sweeps outstanding

**Issue.** k6 scripts and the reconnection-storm suite are smoke-validated at
8 VU only. The 100/500/1,000-player runs, TLS certificate sweep, and a real
staging VM deployment have not been executed (no VPS/git remote in this
environment). Scenarios + runbooks are ready in `docs/load-testing.md`.

## 7. Lint is broken repo-wide

**Issue.** `npm run lint` fails across the monorepo (pre-existing TS config
drift). `npm run typecheck` is the enforced gate and is green; a config
migration is deferred. See `docs/final-report.md` "Known debt".

## 8. Editor reload semantics (fixed, kept for transparency)

The quiz editor previously threw away unsaved question edits whenever another
question was saved/reordered (a `load()` clobbered local state). This is fixed:
the editor now merges server truth with locally-dirty questions and only the
just-saved question is replaced by its server copy. Deleting a question still
refreshes from the server as before.