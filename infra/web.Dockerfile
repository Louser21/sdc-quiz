# Frontend (Next.js). Context = repo root.
FROM node:22-slim AS build

WORKDIR /app

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