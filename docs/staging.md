# Staging Deployment

Staging mirrors production as closely as the host allows (same images, same
env, same nginx single-origin, same TLS termination path) but on a public URL
you can throw QA/automation at.

## On a staging VM

```sh
git clone <repo> quiz && cd quiz
cp .env.example .env
npx playwright                       # no-op guard; only needed for e2e
SCRIPT_URL=$(hostname -I | awk '{print $1}')   # or a DNS name you control
```

`.env` essentials for staging:

```dotenv
NODE_ENV=staging
SESSION_SECRET=<openssl rand -hex 32>
FRONTEND_ORIGIN=https://staging.example.com   # your actual URL
PUBLIC_URL=https://staging.example.com
```

Bring it up:

```sh
npm run db:generate
docker compose --profile app up -d --build
```

## Staging nginx/TLS

Deploy `infra/nginx/production.conf` (see `docs/production.md`) but set
`__SERVER_NAME__` to e.g. `staging.example.com`. A self-issued or Let's Encrypt
cert is fine for staging; if the host is behind Cloudflare, keep the CF
`set_real_ip_from` block enabled **and set `NODE_ENV=staging`** so the API signs
cookies with `secure`.

## Smoke checks after deploy

```sh
curl -s https://staging.example.com/api/health   # {"status":"ok",...}
curl -s https://staging.example.com/api/ready    # redis + database "ok"
curl -s https://staging.example.com/api/metrics  | head        # prometheus text
```

Then run the human path: register a host → create a 2-question quiz → publish →
start a live paper → join from a second browser → answer/submit → leaderboard.

## Restore test drill (recommended)

Stage is the right place to run the documented DB restore drill
(`docs/database-backup.md`) and load tests (`docs/load-testing.md`) so they
never touch production.