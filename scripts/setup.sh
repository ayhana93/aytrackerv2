#!/usr/bin/env bash
#
# From a fresh clone to a running application.
#
# Safe to re-run: it creates what is missing and leaves what exists alone. In particular it will
# not overwrite an existing .env.local, because that file holds a developer's own secrets.
#
#   ./scripts/setup.sh              database in Docker (default)
#   ./scripts/setup.sh --no-docker  use a PostgreSQL you are already running

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

USE_DOCKER=1
[[ "${1:-}" == "--no-docker" ]] && USE_DOCKER=0

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
warn() { printf '\033[33m  %s\033[0m\n' "$1"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------------------
# Prerequisites, checked up front
# ---------------------------------------------------------------------------
# Checked together rather than one at a time, so a developer missing two things is told about
# both instead of discovering the second after installing the first.
step "Checking prerequisites"

MISSING=()
command -v node >/dev/null || MISSING+=("node 22+  → https://nodejs.org")
command -v pnpm >/dev/null || MISSING+=("pnpm 10+  → corepack enable && corepack prepare pnpm@latest --activate")
if [[ $USE_DOCKER -eq 1 ]]; then
  command -v docker >/dev/null || MISSING+=("docker    → https://docs.docker.com/get-docker/  (or re-run with --no-docker)")
fi
if ((${#MISSING[@]})); then
  printf '\033[31mMissing:\033[0m\n'
  printf '  %s\n' "${MISSING[@]}"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
# 22 is not a preference. `process.loadEnvFile` and the `--env-file-if-exists` flag this setup
# relies on do not exist before it.
[[ "$NODE_MAJOR" -ge 22 ]] || fail "Node 22+ required, found $(node -v)"
echo "  node $(node -v), pnpm $(pnpm -v)"

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
step "Installing dependencies"
pnpm install --frozen-lockfile 2>&1 | tail -3

# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------
step "Environment"
if [[ -f .env.local ]]; then
  echo "  .env.local exists — leaving it alone"
else
  cp .env.example .env.local
  # A generated secret rather than a placeholder. A placeholder is a secret everyone shares, and
  # it survives into staging because nothing ever fails to remind you.
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  if [[ "$(uname)" == "Darwin" ]]; then
    sed -i '' "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env.local
  else
    sed -i "s|^SESSION_SECRET=.*|SESSION_SECRET=${SECRET}|" .env.local
  fi
  echo "  created .env.local with a generated SESSION_SECRET"
fi

DB_URL="$(grep -E '^DATABASE_URL=' .env.local | head -1 | cut -d= -f2-)"
[[ -n "$DB_URL" ]] || fail "DATABASE_URL is empty in .env.local"

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------
if [[ $USE_DOCKER -eq 1 ]]; then
  step "Starting PostgreSQL"
  docker compose up -d postgres

  printf '  waiting for it to accept connections'
  for _ in $(seq 1 60); do
    if docker compose exec -T postgres pg_isready -U aytracker -d aytracker >/dev/null 2>&1; then
      printf ' ready\n'; break
    fi
    printf '.'; sleep 1
  done
  docker compose exec -T postgres pg_isready -U aytracker -d aytracker >/dev/null 2>&1 \
    || fail "PostgreSQL did not become ready. Check: docker compose logs postgres"
else
  step "Using your PostgreSQL"
  echo "  $DB_URL"
  warn "Ensure aytracker_test exists too, or integration tests will fail."
fi

step "Applying migrations"
# `migrate deploy`, never `migrate dev`: this schema's invariants — partial unique indexes, the
# composite tenant foreign keys, RLS — are hand-written, and `migrate dev` would offer to drop
# them because Prisma's schema language cannot express them. See docs/database.md.
pnpm db:migrate:deploy 2>&1 | tail -4

step "Building workspace packages"
# Before the seed, not after. `prisma/seed.ts` imports @aytracker/auth and @aytracker/billing,
# which resolve to `dist` — on a fresh clone with no build output the seed fails with "Cannot
# find module". Generating the Prisma client first, because the packages typecheck against it.
pnpm db:generate 2>&1 | tail -2
pnpm build 2>&1 | tail -3

step "Seeding demo data"
pnpm db:seed 2>&1 | tail -8

# ---------------------------------------------------------------------------
# Prove it works before claiming it does
# ---------------------------------------------------------------------------
step "Verifying"
pnpm --silent typecheck >/dev/null 2>&1 && echo "  typecheck ok" || fail "typecheck failed — run: pnpm typecheck"
pnpm --silent test >/dev/null 2>&1 && echo "  unit tests ok" || fail "unit tests failed — run: pnpm test"

echo
bold "Ready."
cat <<'NEXT'

  pnpm dev            api → http://localhost:3001   web → http://localhost:3000

  Worker portal   http://localhost:3000/worker
  Driver portal   http://localhost:3000/driver
  Admin           http://localhost:3000/admin

  Sign in with the credentials the seed printed above.

NEXT
