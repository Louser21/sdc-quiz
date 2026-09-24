# Production Deployment

## Architecture recap

One box (or a vertical slice) runs `postgres` + `redis` + `api` + `web`, fronted
by nginx which is itself fronted by Cloudflare (orange cloud on). Same images
as local/staging — the only production-specific surface is TLS + origin settings.

## Steps

1. **Provision the VM** (Ubuntu LTS recommended), install Docker + Compose,
   open only `80`/`443` (and `22` for ops). Do not expose `3001`/`5432`.

2. **Clone + configure**

   ```sh
   git clone <repo> quiz && cd quiz
   cp .env.example .env
   ```

   `.env`:

   ```dotenv
   NODE_ENV=production
   SESSION_SECRET=<openssl rand -hex 32>
   SESSION_COOKIE_NAME=quiz_session
   SESSION_TTL_DAYS=30
   HOST_GRACE_PERIOD_MS=120000
   DEFAULT_QUIZ_TIME_LIMIT_SECONDS=600
   SCORE_BASE=1000
   RATE_LIMIT_ENABLED=true
   RATE_LIMIT_GLOBAL_MINUTE=600
   RATE_LIMIT_LOGIN_MINUTE=30
   RATE_LIMIT_REGISTER_MINUTE=30
   RATE_LIMIT_JOIN_MINUTE=120
   FRONTEND_ORIGIN=https://quiz.example.com
   PUBLIC_URL=https://quiz.example.com
   ```

3. **Build and start**

   ```sh
   npm run db:generate
   docker compose --profile app up -d --build
   ```

4. **TLS**

   The compose stack already ships an nginx on container port 80. Bring TLS on
   with either:

   - **Cloudflare Origin Certificates** (simplest behind the orange cloud): get a
     long-lived origin cert, mount it, and use `infra/nginx/production.conf`.
   - **Let's Encrypt (certbot)** with a `webroot`/`dns-01` challenge.

   Generate the real conf from the template, keeping the `set_real_ip_from`
   Cloudflare ranges active:

   ```sh
   CERT_FILE=/etc/letsencrypt/live/quiz.example.com/fullchain.pem \
   KEY_FILE=/etc/letsencrypt/live/quiz.example.com/privkey.pem \
   envsubst '${CERT_FILE} ${KEY_FILE}' < infra/nginx/production.conf \
     > /etc/nginx/conf.d/default.conf
   ```

   (If you edge-terminate at Cloudflare and the VM only sees CF traffic, keep the
   `real_ip_header CF-Connecting-IP;` directives so the API's per-IP rate limits
   key on real visitor IPs. If the VM is publicly reachable without CF, delete
   that block — trusting forged CF headers there would let attackers spoof IPs.)

5. **Backups + scheduled runs**

   ```sh
   # crontab
   0 3 * * * cd /opt/quiz && ./scripts/backup.sh >> backups/backup.log 2>&1
   ```

   Push `backups/` off-box nightly. See `docs/database-backup.md`.

6. **Monitoring** — see `docs/monitoring.md`.

## Scaling notes (out of scope for v1)

- Single API instance keeps the in-memory deadline timers + WS token buckets
  simple. To scale: (a) make the WS token buckets Redis-backed,
  (b) `@fastify/rate-limit` already has a Redis store, (c) Socket.IO Redis
  adapter is already a dependency for horizontal fan-out.
- Next.js SSR is vertically fine at this scale; cache rendered pages if needed.

## Rollback

Images are tagged by the CI build; rollback = `docker compose up -d --build`
with the previous ref. DB schema changes ship as Prisma migrations — roll the
API forward only after `npm run db:deploy` on the previous app version if it
needs to tolerate both.** — verify migrations are backward-compatible or
script the data path explicitly.