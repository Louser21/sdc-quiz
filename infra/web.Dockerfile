# Frontend (Next.js). Context = repo root.
FROM node:22-slim AS build

WORKDIR /app

# Allow a larger build-time heap so `next build` survives 1 GiB hosts with swap.
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_OPTIONS=--max-old-space-size=2048

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .
RUN npm run build --workspace @quiz/shared && npm run build --workspace @quiz/web

FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@quiz/web"]