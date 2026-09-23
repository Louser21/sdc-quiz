# Quiz Live

Production-ready real-time quiz platform (Kahoot-style) for events and classrooms.

- **Frontend**: Next.js (App Router) + React + TypeScript + Tailwind
- **Backend**: Node.js + Fastify + Socket.IO
- **Database**: PostgreSQL via Prisma
- **Live state**: Redis (ioredis)
- **Testing**: Vitest, Playwright, k6
- **Docs**: see `docs/`

## Quick start

```bash
cp .env.example .env
npm ci
make services      # postgres + redis
make db-migrate    # apply schema migrations
make dev           # api :3001 + web :3000
```

Full stack (nginx single origin on :8080):

```bash
make infra         # docker compose --profile app up -d --build
```

See `docs/local-development.md` and `docs/architecture.md` for details.