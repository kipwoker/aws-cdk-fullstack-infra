#!/usr/bin/env bash
# Self-contained Redash (BI) install: Docker + PostgreSQL + Redis + Redash.
# Reached only through the dashboard ALB (HTTPS + allowed CIDRs); add SSO on top
# for anything beyond a small team.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

mkdir -p /opt/dashboard
cd /opt/dashboard

cat > .env <<ENV
POSTGRES_PASSWORD=$(openssl rand -hex 24)
COOKIE_SECRET=$(openssl rand -hex 32)
SECRET_KEY=$(openssl rand -hex 32)
ENV
chmod 600 .env

cat > docker-compose.yml <<'COMPOSE'
services:
  postgres:
    image: postgres:15-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: redash
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: redash
    volumes:
      - postgres:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redis:/data

  server:
    image: {{REDASH_IMAGE}}
    command: server
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
    environment: &redash
      REDASH_DATABASE_URL: postgresql://redash:${POSTGRES_PASSWORD}@postgres/redash
      REDASH_REDIS_URL: redis://redis:6379/0
      REDASH_COOKIE_SECRET: ${COOKIE_SECRET}
      REDASH_SECRET_KEY: ${SECRET_KEY}
      REDASH_WEB_WORKERS: "2"
    ports:
      - "80:5000"

  worker:
    image: {{REDASH_IMAGE}}
    command: worker
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
    environment: *redash

  scheduler:
    image: {{REDASH_IMAGE}}
    command: scheduler
    restart: unless-stopped
    depends_on:
      - postgres
      - redis
    environment: *redash

volumes:
  postgres:
  redis:
COMPOSE

# The database may not accept connections immediately after boot.
for _ in $(seq 1 30); do
  if docker compose run --rm server create_db; then
    break
  fi
  sleep 5
done

docker compose up -d
