#!/usr/bin/env bash
# Spin up a throwaway local PostgreSQL 16 with the Supabase shim + all migrations.
# Usage: bash scripts/local-db.sh   (prints the connection string)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
DATA="${MEETWISE_PGDATA:-/tmp/meetwise-pg}"
PORT="${MEETWISE_PGPORT:-54329}"
if [ -f "$DATA/postmaster.pid" ]; then
  su postgres -c "$PGBIN/pg_ctl -D $DATA -m immediate stop" >/dev/null 2>&1 || true
fi
rm -rf "$DATA"; mkdir -p "$DATA"; chown postgres "$DATA"
su postgres -c "$PGBIN/initdb -D $DATA -A trust -U postgres" >/dev/null
su postgres -c "$PGBIN/pg_ctl -D $DATA -o '-p $PORT -k /tmp' -l $DATA/log.txt start" >/dev/null
sleep 1
PSQL="psql -h /tmp -p $PORT -U postgres -v ON_ERROR_STOP=1 -q"
$PSQL -c "create database meetwise" >/dev/null
$PSQL -d meetwise -f "$ROOT/tests/db/shim/00_supabase_shim.sql" >/dev/null
for f in "$ROOT"/supabase/migrations/*.sql; do
  $PSQL -d meetwise -f "$f" >/dev/null
done
echo "postgres://postgres@localhost:$PORT/meetwise?host=/tmp"
