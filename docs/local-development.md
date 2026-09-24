# Local Development

## Requirements

- Node 20+ (dev boxes here run Node 22 LTS), npm
- Docker + Docker Compose (for Postgres + Redis; optionally the full stack)

## Setup

```sh
cp .env.example .env          # adjust SESSION_SECRET in real environments
npm ci
npm run db:generate
```

## Start infrastructure (Postgres + Redis)

```sh
docker compose up -d postgres redis
```

- Postgres: `localhost:5432` (`quiz`/`quiz`/`quiz`)
- Redis: `localhost:6380` (host port differs from the container's 6379)

Apply schema migrations:

```sh
npm run db:deploy        # prisma migrate deploy (applies committed migrations)
```

## Run the app locally (hot reload)

```sh
npm run dev              # api (:3001) + web (:3002 unless occupied → see below)
```

or separately:

```sh
make services            # postgres + redis
npm run dev:api          # API only (tsx watch, :3001)
npm run dev:web          # Next dev (proxies /api + /socket.io to :3001)
```

> **Port note:** this machine has `:3000` occupied, so the web dev server binds
> `:3002` (`PORT=3002`). Anywhere the frontend calls the API it uses an
> explicit `API_PROXY_TARGET=http://localhost:3001` / `NEXT_PUBLIC_SOCKET_URL`.

## Full compose stack (containers, single origin :8080)

```sh
docker compose --profile app up -d --build
open http://localhost:8080
```

nginx routes `/api/` + `/socket.io/` to the API and everything else to the SSR
web app (both in containers), so the browser talks to one origin.

## Configuration (`env`)

See `.env.example` — session cookie name/TTL, grace period, default paper time
limit, scoring base, and the rate-limit knobs (`RATE_LIMIT_*`). Secrets in
`.env` are never committed.

## Tests

```sh
npm run typecheck                 # full workspace typecheck (build @quiz/shared first)
npm test -w @quiz/api             # unit + integration (needs PG + Redis running)
```

Integration tests run against the real local Postgres + Redis and **truncate
Postgres tables** (`resetDb`) between tests; Redis games are *not* wiped, so if
a run looks polluted run `redis-cli -p 6380 flushdb` first.

## Handy verbs

```sh
make dev-api / dev-web / typecheck / test
npm run db:studio                 # Prisma Studio (inspect data)
npm run lint                      # currently broken repo-wide — gate on typecheck
```