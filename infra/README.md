# agentsmcp — AWS hosted-tier infra

Provision the hosted free tier on AWS: App Runner (compute) → RDS Postgres
(state), with rate-limited public access. Everything is driven by the
scripts in this directory; no console clicks except the initial root
login to create the isolated IAM user.

This is the *hosted* path. Self-hosters skip it and run sqlite locally
or point `AGENTSMCP_DB` at any Postgres URL.

## Colima on macOS

Colima is the supported local container runtime for macOS. The Colima stack
uses Modal for GLM inference and embeddings because macOS/Colima cannot expose
an NVIDIA GPU to the Linux vLLM container.

```bash
brew install colima docker docker-compose
cp infra/colima/.env.colima.example infra/colima/.env.colima
# Populate secrets, Modal endpoints, and TLS file paths from your secret manager.
bash infra/colima/deploy-colima.sh
```

The launcher starts Colima when needed, selects the `colima` Docker context,
builds the application, and starts the private PostgreSQL, Neo4j, and MinIO
services. Only the Nginx HTTPS proxy publishes host ports.

The Colima initializer creates a local development CA and localhost server
certificate. To make Chrome trust `https://localhost:8443` on macOS, run:

```bash
./infra/colima/trust-local-cert.sh
```

---

## What gets created

| Resource | Name | Where |
|---|---|---|
| IAM user | `agentsmcp-deploy` | account-wide |
| IAM group + customer-managed policy | `agentsmcp-deploy-grp`, `agentsmcp-deploy-policy` | account-wide |
| VPC security group (App Runner) | `agentsmcp-app-runner-sg` | default VPC unless overridden |
| VPC security group (RDS) | `agentsmcp-rds-sg` | default VPC unless overridden |
| RDS Postgres 16 instance | `agentsmcp-db` (db.t3.micro, 20GB gp3, not publicly accessible) | private subnets |
| App Runner service env update | existing `agentsmcp-server` service | App Runner |

Every resource is tagged `project=agentsmcp`. The IAM policy enforces
tag-based isolation — the deploy user cannot touch resources outside
this tag.

---

## Prereqs

- `aws` CLI v2 (`aws --version`)
- `jq` and `python3` (already on macOS / most Linux)
- An AWS account you control. The first step needs root or an existing
  admin user — after that, everything runs as `agentsmcp-deploy`.

---

## One-time setup

### 1. Create the isolated IAM identity

```bash
# Run as root or an existing admin profile.
./infra/iam-user.sh
```

The script:
- Creates the customer-managed policy with tag-gated permissions.
- Creates the group, attaches the policy.
- Creates the user, adds it to the group.
- Mints an access key **once** and prints it. Save it now — the secret
  cannot be retrieved later.

Then configure the CLI to use this identity for all subsequent steps:

```bash
aws configure --profile agentsmcp
# paste the Access Key ID + Secret from the previous step
# region: us-east-1 (or whatever you prefer)
export AWS_PROFILE=agentsmcp
```

### 2. Create the VPC security groups

```bash
./infra/security-group.sh
# emits JSON: {"appRunnerSgId":"sg-...","rdsSgId":"sg-...","vpcId":"vpc-..."}
```

Capture the IDs. The RDS SG only accepts ingress from the App Runner SG
on port 5432 — Postgres is otherwise unreachable from the public
internet.

### 3. Provision RDS

```bash
export AGENTSMCP_DB_PASSWORD='choose-something-long-and-random'
export SECURITY_GROUP_ID='sg-...'   # the rdsSgId from step 2
./infra/rds.sh

# Wait until the instance is available (~5–10 min).
aws rds wait db-instance-available --db-instance-identifier agentsmcp-db

# Capture the endpoint hostname.
export AGENTSMCP_DB_HOST=$(aws rds describe-db-instances \
  --db-instance-identifier agentsmcp-db \
  --query 'DBInstances[0].Endpoint.Address' --output text)
```

### 4. Point App Runner at RDS

The App Runner service itself must already exist (use the existing
`deploy/aws-deploy.sh` to create it from ECR). Then patch its runtime
env to enable `CLOUD_MODE` and the new Postgres URL:

```bash
export AGENTSMCP_SERVICE_NAME='agentsmcp-server'
# AGENTSMCP_DB_PASSWORD + AGENTSMCP_DB_HOST already set above.
# Leave AGENTSMCP_API_KEY UNSET — that's what activates the rate limiter.
./infra/app-runner-update.sh
```

The service rolls out the new env in ~2 minutes. Verify with:

```bash
curl https://<your-app-runner-url>/health
curl https://<your-app-runner-url>/.well-known/agent-card.json
```

The Agent Card should now show `"authentication": "none"` (rate limiting
guards the public tier; no bearer key required).

---

## What changed inside the app

- `CLOUD_MODE=true` switches on:
  - `app.set('trust proxy', true)` — needed so the limiter sees real
    client IPs through the App Runner load balancer.
  - CORS for the dashboard origins (override via `corsOrigins` option).
  - Per-IP / per-agent rate limiting (defaults: 10 agents/IP, 500
    messages/day/agent, 60 req/min/IP).
  - `GET /usage/:identifier` returning current counters.
- `AGENTSMCP_DB=postgresql://…` routes storage through the new
  Postgres adapter (`src/storage/postgres.ts`). SQLite is still the
  default everywhere else.
- Setting `AGENTSMCP_API_KEY` while `CLOUD_MODE=true` is a supported
  override for "private deploys behind a bearer key" — it skips rate
  limiting since you've already gated access via the key.

---

## Rollback

The scripts are idempotent on create (skip if present). Teardown is
explicit and destructive — only run if you mean it:

```bash
# 1. Revert App Runner env (point AGENTSMCP_DB back to :memory: in console).
# 2. Delete RDS (snapshot first if you want the data):
aws rds delete-db-instance --db-instance-identifier agentsmcp-db \
  --skip-final-snapshot

# 3. Delete security groups (after RDS is gone — they hold the dependency):
aws ec2 delete-security-group --group-id <rdsSgId>
aws ec2 delete-security-group --group-id <appRunnerSgId>

# 4. (Optional) Detach + delete the IAM identity:
aws iam remove-user-from-group --group-name agentsmcp-deploy-grp \
  --user-name agentsmcp-deploy
aws iam delete-access-key --user-name agentsmcp-deploy --access-key-id <id>
aws iam delete-user --user-name agentsmcp-deploy
```

---

## Cost notes (free-tier sizing)

- App Runner: `1 vCPU / 2 GB` is the smallest config; bills per second
  of active request handling. Idle services scale to zero.
- RDS db.t3.micro: ~\$13/mo when always-on. Free tier covers it the
  first 12 months.
- gp3 storage 20 GB: ~\$2.30/mo, free tier-eligible.

For real free-tier operation, stop the RDS instance overnight or
auto-stop when idle — `db.t3.micro` is billable while running, not
while stopped.

## Backup and recovery

RDS is provisioned with seven days of automated backups. For self-managed
PostgreSQL, run the checked-in dump job from a scheduler with credentials
provided by your secret manager:

```bash
PGHOST=... PGDATABASE=agentsmcp PGUSER=... PGPASSWORD=... \
  BACKUP_DIR=/secure/backups ./infra/backup-postgres.sh
```

Recovery must be tested regularly, not only when an incident occurs:

```bash
BACKUP_FILE=/secure/backups/agentsmcp-latest.dump \
PGHOST=... PGUSER=... PGPASSWORD=... \
  ./infra/test-postgres-restore.sh
```

The restore script creates a temporary database, restores the dump with
`pg_restore --exit-on-error`, and removes the temporary database afterward.
