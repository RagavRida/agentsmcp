# Deploying `agentsmcp` to AWS App Runner (CLI)

Public demo deploy using **ECR** for the container image and **App
Runner** for the service. Entirely CLI-driven — no console clicks
after the IAM user is set up.

## Prerequisites

- AWS account with credits (or a payment method)
- `aws` CLI v2 installed (`aws --version` → `aws-cli/2.x`)
- `docker` installed and running
- This repo cloned locally

## One-time setup

### 1. Create a dedicated IAM user

**Don't use root** for daily CLI work. Use the AWS console once to
create a dedicated user (this part can't avoid the console — root is
needed to create the first non-root admin):

1. Sign in to https://console.aws.amazon.com as root.
2. **IAM → Users → Create user**.
3. Name: `agentsmcp-deploy` (or whatever).
4. Permissions: **Attach policies directly** → `AdministratorAccess`.
   (Solo-dev convenience. Tighten later if you want; see "Minimum
   permissions" below.)
5. Create. Then on the user page: **Security credentials →
   Create access key →** "Command Line Interface (CLI)".
6. Download the `.csv` or copy the **Access key ID** and
   **Secret access key**. You won't see the secret again.
7. Enable MFA on this user while you're there.

### 2. Configure the CLI

```bash
aws configure
# AWS Access Key ID:     <paste>
# AWS Secret Access Key: <paste>
# Default region name:   us-east-1
# Default output format: json
```

Verify:

```bash
aws sts get-caller-identity
# {
#   "UserId": "AIDA...",
#   "Account": "123456789012",
#   "Arn": "arn:aws:iam::123456789012:user/agentsmcp-deploy"
# }
```

Note the **Account** number — you'll need it for ECR URLs.

## Deploy (first time)

Run `deploy/aws-deploy.sh` from the repo root. It's idempotent —
re-running it pushes a new image and triggers App Runner to redeploy.

```bash
./deploy/aws-deploy.sh
```

The script does, in order:

1. Resolves your AWS account ID via `sts get-caller-identity`.
2. Creates an ECR repo `agentsmcp` if it doesn't exist.
3. Builds the Docker image from `Dockerfile`.
4. Tags it as `<account>.dkr.ecr.<region>.amazonaws.com/agentsmcp:latest`.
5. Authenticates Docker to ECR and pushes the image.
6. Ensures the `AppRunnerECRAccessRole` service-linked role exists.
7. Creates the App Runner service if it doesn't exist, or starts a
   new deployment if it does.
8. Polls for the service URL and prints it.

Total time: 4–8 minutes on first run, ~2 minutes on redeploy.

## What you get

A public HTTPS endpoint, e.g.:

```
https://abcdef1234.us-east-1.awsapprunner.com
```

Hit it:

```bash
curl https://abcdef1234.us-east-1.awsapprunner.com/health
# {"ok":true}
```

The demo runs with `AGENTSMCP_DB=:memory:` so all data is wiped on
container restart. Set `AGENTSMCP_API_KEY` in the App Runner console
(or via `aws apprunner update-service`) if you want to gate writes.

## Redeploying

Just re-run the script. It'll push a new image and App Runner will
roll the service automatically.

```bash
./deploy/aws-deploy.sh
```

## Tearing down

```bash
./deploy/aws-teardown.sh
```

Deletes the App Runner service and the ECR repo. Won't touch the IAM
user (that's yours; keep or delete in the console).

## Minimum permissions (if you don't want AdministratorAccess)

The IAM user needs:

- `AWSAppRunnerFullAccess` (managed policy) — manage the service
- `AmazonEC2ContainerRegistryFullAccess` (managed policy) — push to ECR
- `IAMReadOnlyAccess` — App Runner needs the service-linked role
  `AWSServiceRoleForAppRunner` which is created automatically on
  first service create. If you want to avoid even that minimal IAM
  read, pre-create the role in the console.

The simpler thing for a solo project is `AdministratorAccess` on a
dedicated user with MFA enabled. Cost of slightly broader perms,
benefit of never debugging IAM denials.

## Troubleshooting

**`AccessDeniedException` when running the script**: the IAM user is
missing one of the permissions above, or you ran `aws configure` with
the wrong keys. Check with `aws sts get-caller-identity`.

**App Runner stays in `OPERATION_IN_PROGRESS` for >10 minutes**: open
the AWS console → App Runner → `agentsmcp` → **Logs**. The container
log will show why startup failed (most common: missing env var, bad
image build).

**`better-sqlite3` errors at runtime**: the Dockerfile builds the
native module against musl (Alpine). If you change base images,
rebuild from scratch — don't cache the npm install layer.
