# Production secrets

Do not commit `.env` files, API keys, model keys, database passwords, or TLS
private keys. The checked-in `.env.onprem.example` contains placeholders only.

For Kubernetes, inject these values from an external secret manager using
External Secrets Operator or the platform equivalent:

- `AGENTSMCP_API_KEY`
- `POSTGRES_PASSWORD`
- `NEO4J_PASS`
- `S3_SECRET_KEY`
- `VLLM_API_KEY`
- `JWT_SECRET` when `CLOUD_MODE=true`
- TLS certificate and private key files

For Docker Compose, render an environment file at deploy time from Vault,
AWS Secrets Manager, Azure Key Vault, or an equivalent enterprise secret
manager. Set its permissions to `0600`, keep it outside the repository, and
rotate it through the secret manager. The application container receives only
the values required by its role; inference, PostgreSQL, Neo4j, and MinIO stay
on the private Docker network.

Production modes:

- Single tenant: set `NODE_ENV=production`, a PostgreSQL `AGENTSMCP_DB`, and
  `AGENTSMCP_API_KEY`.
- Multi-tenant hosted mode: set `NODE_ENV=production`, `CLOUD_MODE=true`, a
  PostgreSQL `AGENTSMCP_DB`, `JWT_SECRET`, and the configured OAuth credentials.

The server refuses to start in production with SQLite or without an explicit
authentication boundary.
