#!/usr/bin/env bash
# =============================================================================
# Creates a LOCAL PostgreSQL database for the Experiment API and points .env
# at it (the previous DATABASE_URL is kept in .env as a comment).
#
#   ./setup-local-db.sh            use Docker (recommended) or local Postgres
#   ./setup-local-db.sh --reset    drop existing local data and start fresh
#
# After this, just ./run.sh — the schema is created automatically on startup.
# =============================================================================
set -euo pipefail
cd "$(dirname "$0")"

DB_NAME=experiments
DB_PASS=secret
CONTAINER=experiments-db
RESET=false
[ "${1:-}" = "--reset" ] && RESET=true

say()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

LOCAL_URL=""

if command -v docker >/dev/null && docker info >/dev/null 2>&1; then
  # ----- Option A: Docker container ----------------------------------------
  if [ "$RESET" = true ]; then
    say "Removing existing container + data..."
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  fi
  if docker ps --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    say "Container '$CONTAINER' already running."
  elif docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    say "Starting existing container '$CONTAINER'..."
    docker start "$CONTAINER" >/dev/null
  else
    say "Creating Postgres 16 container '$CONTAINER'..."
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_PASSWORD="$DB_PASS" \
      -e POSTGRES_DB="$DB_NAME" \
      -p 5432:5432 \
      -v "$CONTAINER-data:/var/lib/postgresql/data" \
      postgres:16 >/dev/null
  fi
  say "Waiting for Postgres to accept connections..."
  for _ in $(seq 1 30); do
    docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1 \
    || fail "Postgres container did not become ready."
  LOCAL_URL="postgresql://postgres:$DB_PASS@localhost:5432/$DB_NAME"

elif command -v createdb >/dev/null; then
  # ----- Option B: locally installed PostgreSQL ----------------------------
  if [ "$RESET" = true ]; then
    say "Dropping database '$DB_NAME'..."
    dropdb --if-exists "$DB_NAME" || true
  fi
  if psql -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw "$DB_NAME"; then
    say "Database '$DB_NAME' already exists."
  else
    say "Creating database '$DB_NAME'..."
    createdb "$DB_NAME" || fail "createdb failed — is PostgreSQL running? (brew services start postgresql)"
  fi
  LOCAL_URL="postgresql://$(whoami)@localhost:5432/$DB_NAME"

else
  fail "Neither Docker nor PostgreSQL found. Install one:
  Docker Desktop:  https://docker.com  (easiest)
  or Postgres:     brew install postgresql@16 && brew services start postgresql@16"
fi

# ----- Point .env at the local DB (keep the old URL as a comment) ------------
if [ -f .env ]; then
  cp .env .env.bak
  {
    while IFS= read -r line; do
      case "$line" in
        DATABASE_URL=*) echo "# (previous) $line"; echo "DATABASE_URL=$LOCAL_URL" ;;
        PGSSL=*)        echo "# (previous) $line" ;;  # local DB has no SSL
        *)              echo "$line" ;;
      esac
    done < .env.bak
  } > .env
  say "Updated .env — DATABASE_URL now points to the local database"
  say "(previous values kept as comments; backup in .env.bak)"
else
  printf 'DATABASE_URL=%s\nDATA_DIR=./data\nPORT=3000\n' "$LOCAL_URL" > .env
  say "Created .env with the local database"
fi

say "Local database ready: $LOCAL_URL"
say "Start the server with: ./run.sh  (schema is created automatically)"
