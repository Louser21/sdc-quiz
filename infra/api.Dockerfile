# Backend (Fastify + Socket.IO). Context = repo root.
# NOTE: ships a full node_modules including dev deps for simplicity. Prod
# hardening (npm ci --omit=dev) is part of Phase 6.
FROM node:20-slim AS build

WORKDIR /app

# Install after copying manifests so layer caching works.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

# Build shared + api
COPY . .
# prisma.config.ts needs DATABASE_URL resolvable even though generate doesn't connect.
ARG DATABASE_URL=postgresql://quiz:quiz@localhost:5432/quiz
ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate && npm run build --workspace @quiz/shared && npm run build --workspace @quiz/api

FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app /app

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]