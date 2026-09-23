.PHONY: help install services infra up down dev dev-api dev-web build typecheck lint test test-unit test-integration db-reset db-migrate db-deploy db-generate db-studio logs

help:
	@echo "Targets:"
	@echo "  make install        - npm ci (install all workspaces)"
	@echo "  make services       - start postgres + redis only (docker)"
	@echo "  make infra          - docker compose --profile app up -d --build"
	@echo "  make up             - alias for infra"
	@echo "  make down           - stop the compose stack"
	@echo "  make dev            - services + run api & web locally (hot reload)"
	@echo "  make dev-api        - api only (tsx watch)"
	@echo "  make dev-web        - web only (next dev, proxies /api to :3001)"
	@echo "  make build          - type-checked build of shared + api"
	@echo "  make typecheck      - tsc --noEmit across workspaces"
	@echo "  make lint           - lint across workspaces"
	@echo "  make test           - unit + integration tests"
	@echo "  make db-generate    - prisma generate"
	@echo "  make db-migrate     - prisma migrate dev (create/apply migrations)"
	@echo "  make db-deploy      - prisma migrate deploy (apply committed migrations)"
	@echo "  make db-reset       - prisma migrate reset --force (WIPES data)"

install:
	npm ci

services:
	docker compose up -d postgres redis

infra up:
	docker compose --profile app up -d --build

down:
	docker compose --profile app down

dev: services
	npm run dev

dev-api:
	npm run dev:api

dev-web:
	npm run dev:web

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test: test-unit test-integration

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

db-generate:
	npm run db:generate

db-migrate:
	npm run db:migrate

db-deploy:
	npm run db:deploy

db-reset:
	npx prisma migrate reset --force

logs:
	docker compose logs -f --tail=100