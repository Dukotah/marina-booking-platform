#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# One-time local setup: local Postgres + schema + RLS + seed.
# Zero external accounts. Safe to re-run (idempotent).
# Requires: Node 20+, pnpm, a local PostgreSQL (apt: `sudo apt install postgresql`).
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ Ensuring PostgreSQL is running…"
sudo service postgresql start >/dev/null 2>&1 || true

echo "▸ Ensuring role + database 'marina' exist…"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='marina'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE ROLE marina LOGIN PASSWORD 'marina' SUPERUSER;"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='marina'" | grep -q 1 \
  || sudo -u postgres psql -c "CREATE DATABASE marina OWNER marina;"

if [ ! -f .env ]; then
  echo "▸ Creating .env from .env.local.example…"
  cp .env.local.example .env
fi
set -a; . ./.env; set +a

echo "▸ Installing dependencies…"
pnpm install

echo "▸ Applying migrations…"
pnpm --filter @marina/database migrate:deploy

echo "▸ Applying RLS policies…"
pnpm db:rls

echo "▸ Seeding Lake Sonoma Marina (19 activities + 30 days of timeslots)…"
pnpm db:seed

echo ""
echo "✅ Local setup complete. Start everything with:  bash scripts/dev-local.sh"
echo "   Customer site → http://localhost:3000   Admin → http://localhost:3002   API → http://localhost:3001"
