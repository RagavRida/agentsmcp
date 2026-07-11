#!/usr/bin/env bash
set -Eeuo pipefail

: "${BACKUP_FILE:?BACKUP_FILE is required}"
: "${PGHOST:?PGHOST is required}"
: "${PGPORT:=5432}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${RESTORE_DATABASE:=agentsmcp_restore_test}"

dropdb --if-exists --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$RESTORE_DATABASE"
createdb --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$RESTORE_DATABASE"
trap 'dropdb --if-exists --host="$PGHOST" --port="$PGPORT" --username="$PGUSER" "$RESTORE_DATABASE" >/dev/null' EXIT
pg_restore --exit-on-error --no-owner --host="$PGHOST" --port="$PGPORT" \
  --username="$PGUSER" --dbname="$RESTORE_DATABASE" "$BACKUP_FILE"
echo "Restore verification passed for $BACKUP_FILE"
