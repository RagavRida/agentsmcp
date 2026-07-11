#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env.colima"
CERT_DIR="$SCRIPT_DIR/certs"

: "${AGENTSMCP_MODAL_ENDPOINT_URL:?AGENTSMCP_MODAL_ENDPOINT_URL is required}"
: "${AGENTSMCP_MODAL_EMBED_URL:?AGENTSMCP_MODAL_EMBED_URL is required}"
command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
mkdir -p "$CERT_DIR"

if [[ ! -f "$CERT_DIR/ca.pem" || ! -f "$CERT_DIR/privkey.pem" || ! -f "$CERT_DIR/fullchain.pem" ]]; then
  "$SCRIPT_DIR/create-local-cert.sh"
fi

postgres_password="$(openssl rand -hex 32)"
neo4j_password="$(openssl rand -hex 32)"
s3_access_key="$(openssl rand -hex 16)"
s3_secret_key="$(openssl rand -hex 32)"
api_key="$(openssl rand -hex 32)"

{
  printf 'POSTGRES_DB=agentsmcp\n'
  printf 'POSTGRES_USER=agentsmcp\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$postgres_password"
  printf 'NEO4J_USER=neo4j\n'
  printf 'NEO4J_PASS=%s\n' "$neo4j_password"
  printf 'S3_ACCESS_KEY=%s\n' "$s3_access_key"
  printf 'S3_SECRET_KEY=%s\n' "$s3_secret_key"
  printf 'S3_BUCKET=agentmailbox\n'
  printf 'AGENTSMCP_API_KEY=%s\n' "$api_key"
  printf 'AGENTSMCP_MODAL_ENDPOINT_URL=%s\n' "$AGENTSMCP_MODAL_ENDPOINT_URL"
  printf 'AGENTSMCP_MODAL_EMBED_URL=%s\n' "$AGENTSMCP_MODAL_EMBED_URL"
  printf 'AGENTSMCP_MODEL=zai-org/GLM-5.2-FP8\n'
  printf 'HTTP_PORT=8080\n'
  printf 'HTTPS_PORT=8443\n'
  printf 'TLS_CERT_PATH=./certs/fullchain.pem\n'
  printf 'TLS_KEY_PATH=./certs/privkey.pem\n'
  printf 'COLIMA_CPU=4\n'
  printf 'COLIMA_MEMORY=8\n'
  printf 'COLIMA_DISK=60\n'
} > "$ENV_FILE"

chmod 600 "$ENV_FILE" "$CERT_DIR/privkey.pem"
echo "Created $ENV_FILE and localhost development TLS material"
