#!/usr/bin/env bash
#
# Deploy agentsmcp to AWS App Runner via ECR. Idempotent — first run
# creates the ECR repo + App Runner service; subsequent runs push a
# new image and trigger a redeploy.
#
# Reads from environment:
#   AWS_REGION         — defaults to us-east-1
#   AGENTSMCP_SERVICE  — App Runner service name, defaults to agentsmcp
#   ECR_REPO           — ECR repo name, defaults to agentsmcp
#   IMAGE_TAG          — image tag to push, defaults to latest

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AGENTSMCP_SERVICE="${AGENTSMCP_SERVICE:-agentsmcp}"
ECR_REPO="${ECR_REPO:-agentsmcp}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Resolve absolute repo root so this script can be invoked from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

log() { printf "\033[36m[deploy]\033[0m %s\n" "$*"; }
die() { printf "\033[31m[deploy] %s\033[0m\n" "$*" >&2; exit 1; }

# 1. Pre-flight
log "checking aws cli..."
command -v aws >/dev/null || die "aws cli not found. install with: brew install awscli"
command -v docker >/dev/null || die "docker not found. install Docker Desktop or colima."
docker info >/dev/null 2>&1 || die "docker daemon is not running."

log "resolving aws account..."
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)" \
  || die "aws sts call failed. run: aws configure"
log "  account=$ACCOUNT_ID region=$AWS_REGION"

ECR_URI="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO}"
IMAGE_URI="${ECR_URI}:${IMAGE_TAG}"

# 2. ECR repo (idempotent)
log "ensuring ECR repo '${ECR_REPO}' exists..."
if ! aws ecr describe-repositories --repository-names "$ECR_REPO" \
      --region "$AWS_REGION" >/dev/null 2>&1; then
  aws ecr create-repository --repository-name "$ECR_REPO" \
    --region "$AWS_REGION" \
    --image-scanning-configuration scanOnPush=true >/dev/null
  log "  created"
else
  log "  already exists"
fi

# 3. Build image
log "building image (this can take a few minutes the first time)..."
docker build --platform=linux/amd64 -t "${ECR_REPO}:${IMAGE_TAG}" .

# 4. Authenticate Docker to ECR + push
log "authenticating docker to ECR..."
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

log "tagging and pushing $IMAGE_URI ..."
docker tag "${ECR_REPO}:${IMAGE_TAG}" "$IMAGE_URI"
docker push "$IMAGE_URI"

# 5. App Runner ECR access role (service-linked-ish, created on demand)
ACCESS_ROLE_NAME="AppRunnerECRAccessRole"
log "ensuring IAM role '${ACCESS_ROLE_NAME}' exists..."
if ! aws iam get-role --role-name "$ACCESS_ROLE_NAME" >/dev/null 2>&1; then
  TRUST_DOC='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"build.apprunner.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
  aws iam create-role --role-name "$ACCESS_ROLE_NAME" \
    --assume-role-policy-document "$TRUST_DOC" >/dev/null
  aws iam attach-role-policy --role-name "$ACCESS_ROLE_NAME" \
    --policy-arn "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess"
  log "  created and waiting 10s for IAM propagation..."
  sleep 10
else
  log "  already exists"
fi
ACCESS_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ACCESS_ROLE_NAME}"

# 6. App Runner service (create or update)
log "checking if App Runner service '${AGENTSMCP_SERVICE}' exists..."
SERVICE_ARN="$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${AGENTSMCP_SERVICE}'].ServiceArn | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "$SERVICE_ARN" = "None" ] || [ -z "$SERVICE_ARN" ]; then
  log "  creating new service..."
  SOURCE_CONFIG=$(cat <<EOF
{
  "ImageRepository": {
    "ImageIdentifier": "${IMAGE_URI}",
    "ImageRepositoryType": "ECR",
    "ImageConfiguration": {
      "Port": "8080",
      "RuntimeEnvironmentVariables": {
        "AGENTSMCP_DB": ":memory:"
      }
    }
  },
  "AutoDeploymentsEnabled": false,
  "AuthenticationConfiguration": {
    "AccessRoleArn": "${ACCESS_ROLE_ARN}"
  }
}
EOF
)
  INSTANCE_CONFIG='{"Cpu":"0.25 vCPU","Memory":"0.5 GB"}'
  HEALTH_CHECK='{"Protocol":"HTTP","Path":"/health","Interval":10,"Timeout":5,"HealthyThreshold":1,"UnhealthyThreshold":5}'

  SERVICE_ARN="$(aws apprunner create-service \
    --region "$AWS_REGION" \
    --service-name "$AGENTSMCP_SERVICE" \
    --source-configuration "$SOURCE_CONFIG" \
    --instance-configuration "$INSTANCE_CONFIG" \
    --health-check-configuration "$HEALTH_CHECK" \
    --query 'Service.ServiceArn' --output text)"
  log "  created: $SERVICE_ARN"
else
  log "  found: $SERVICE_ARN"
  log "  starting new deployment with the freshly-pushed image..."
  aws apprunner start-deployment \
    --region "$AWS_REGION" \
    --service-arn "$SERVICE_ARN" >/dev/null
fi

# 7. Wait for RUNNING + print URL
log "waiting for service to reach RUNNING (this takes 2-5 minutes)..."
for i in $(seq 1 60); do
  STATUS="$(aws apprunner describe-service --region "$AWS_REGION" \
    --service-arn "$SERVICE_ARN" \
    --query 'Service.Status' --output text)"
  case "$STATUS" in
    RUNNING)
      URL="$(aws apprunner describe-service --region "$AWS_REGION" \
        --service-arn "$SERVICE_ARN" \
        --query 'Service.ServiceUrl' --output text)"
      log ""
      log "READY: https://${URL}"
      log ""
      log "smoke test:"
      log "  curl https://${URL}/health"
      exit 0
      ;;
    CREATE_FAILED|UPDATE_FAILED|DELETED|DELETE_FAILED)
      die "service entered $STATUS — check AWS console → App Runner → ${AGENTSMCP_SERVICE} → Logs"
      ;;
    *)
      printf "  status=%s (attempt %d/60)\n" "$STATUS" "$i"
      sleep 10
      ;;
  esac
done

die "timed out waiting for service to be RUNNING after 10 minutes."
