#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERT_DIR="${CERT_DIR:-$SCRIPT_DIR/certs}"
HOSTNAME="${LOCAL_TLS_HOSTNAME:-localhost}"
DAYS="${LOCAL_TLS_DAYS:-365}"

command -v openssl >/dev/null || { echo "openssl is required" >&2; exit 1; }

umask 077
mkdir -p "$CERT_DIR"

ca_config_file="$(mktemp)"
server_config_file="$(mktemp)"
trap 'rm -f "$ca_config_file" "$server_config_file"' EXIT

cat > "$ca_config_file" <<EOF
[req]
default_bits = 2048
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
CN = AgentMailbox Local Development CA

[v3_ca]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
EOF

cat > "$server_config_file" <<EOF
[req]
default_bits = 2048
distinguished_name = req_distinguished_name
prompt = no

[req_distinguished_name]
CN = ${HOSTNAME}

[v3_ca]
basicConstraints = critical,CA:true,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash

[v3_server]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = ${HOSTNAME}
IP.1 = 127.0.0.1
IP.2 = ::1
EOF

openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days "$DAYS" \
  -keyout "$CERT_DIR/ca-key.pem" \
  -out "$CERT_DIR/ca.pem" \
  -extensions v3_ca \
  -config "$ca_config_file" >/dev/null 2>&1

openssl req -newkey rsa:2048 -nodes \
  -keyout "$CERT_DIR/privkey.pem" \
  -out "$CERT_DIR/server.csr" \
  -config "$server_config_file" >/dev/null 2>&1

openssl x509 -req -sha256 -days "$DAYS" \
  -in "$CERT_DIR/server.csr" \
  -CA "$CERT_DIR/ca.pem" \
  -CAkey "$CERT_DIR/ca-key.pem" \
  -CAcreateserial \
  -out "$CERT_DIR/server.pem" \
  -extensions v3_server \
  -extfile "$server_config_file" >/dev/null 2>&1

cat "$CERT_DIR/server.pem" "$CERT_DIR/ca.pem" > "$CERT_DIR/fullchain.pem"
chmod 600 "$CERT_DIR/ca-key.pem" "$CERT_DIR/privkey.pem"
chmod 644 "$CERT_DIR/ca.pem" "$CERT_DIR/server.pem" "$CERT_DIR/fullchain.pem"
rm -f "$CERT_DIR/server.csr"

echo "Created localhost certificate signed by $CERT_DIR/ca.pem"
