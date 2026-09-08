#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Boot the whole stack locally with .env loaded: API (:3001), customer web
# (:3000), admin (:3002). Ctrl-C stops all. Run setup-local.sh first.
#
# NOTE (WSL on /mnt/c): the OS does not deliver file-change events for the
# Windows filesystem, so `tsx watch` (API) won't hot-reload. After editing API
# code, stop (Ctrl-C) and re-run this script. Next.js (web/admin) reloads fine.
# ---------------------------------------------------------------------------
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Missing .env — run: bash scripts/setup-local.sh"; exit 1; }
set -a; . ./.env; set +a

# Mirror the root .env into apps/web/.env.local so the customer web app keeps
# NEXT_PUBLIC_DEMO_MODE=0 even if it is ever restarted STANDALONE (Next only
# reads .env files from apps/web/, not the repo root). Without this a crash
# restart of just the web app fails open to demo fixtures and every real Book
# button (/activities/pontoon-5-person) 404s. Idempotent; re-synced every boot.
cp -f .env apps/web/.env.local

sudo service postgresql start >/dev/null 2>&1 || true

echo "▸ Starting API (:3001), customer web (:3000), admin (:3002)…"
echo "  Customer → http://localhost:3000   Admin → http://localhost:3002   (Ctrl-C to stop)"
exec pnpm dev
