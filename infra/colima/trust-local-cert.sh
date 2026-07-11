#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_PATH="${1:-$SCRIPT_DIR/certs/ca.pem}"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Local certificate trust automation is currently supported on macOS only." >&2
  exit 1
fi

if [[ ! -f "$CERT_PATH" ]]; then
  echo "Certificate not found at $CERT_PATH. Run infra/colima/create-local-cert.sh first." >&2
  exit 1
fi

security add-trusted-cert \
  -d \
  -r trustRoot \
  -p ssl \
  -k "$KEYCHAIN" \
  "$CERT_PATH"

echo "Trusted $CERT_PATH for SSL in $KEYCHAIN"
