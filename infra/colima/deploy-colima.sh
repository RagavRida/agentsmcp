#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/docker-compose.colima.yml"
ENV_FILE="${AGENTSMCP_COLIMA_ENV:-$SCRIPT_DIR/.env.colima}"

command -v colima >/dev/null || { echo "colima is required" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker CLI is required for the Colima socket" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  compose=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  compose=(docker-compose)
else
  echo "Docker Compose is required. Install with: brew install docker-compose" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Missing $ENV_FILE. Create it from .env.colima.example and load secrets from your secret manager." >&2
  exit 1
fi

if grep -q "replace-with" "$ENV_FILE"; then
  echo "$ENV_FILE still contains placeholder secrets or endpoints" >&2
  exit 1
fi

set -a
source "$ENV_FILE"
set +a

if ! colima status >/dev/null 2>&1; then
  colima start \
    --cpu "${COLIMA_CPU:-4}" \
    --memory "${COLIMA_MEMORY:-8}" \
    --disk "${COLIMA_DISK:-60}"
fi

docker context use colima >/dev/null
"${compose[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --build
"${compose[@]}" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps

echo "AgentMailbox is available at https://localhost:${HTTPS_PORT:-443}"
