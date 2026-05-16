#!/usr/bin/env bash
#
# Delete the App Runner service and ECR repo for agentsmcp. Leaves the
# IAM user/role alone — those are yours.

set -euo pipefail

AWS_REGION="${AWS_REGION:-us-east-1}"
AGENTSMCP_SERVICE="${AGENTSMCP_SERVICE:-agentsmcp}"
ECR_REPO="${ECR_REPO:-agentsmcp}"

log() { printf "\033[36m[teardown]\033[0m %s\n" "$*"; }

log "looking for App Runner service '${AGENTSMCP_SERVICE}'..."
SERVICE_ARN="$(aws apprunner list-services --region "$AWS_REGION" \
  --query "ServiceSummaryList[?ServiceName=='${AGENTSMCP_SERVICE}'].ServiceArn | [0]" \
  --output text 2>/dev/null || echo "None")"

if [ "$SERVICE_ARN" != "None" ] && [ -n "$SERVICE_ARN" ]; then
  log "  deleting $SERVICE_ARN ..."
  aws apprunner delete-service --region "$AWS_REGION" \
    --service-arn "$SERVICE_ARN" >/dev/null
  log "  deletion initiated (App Runner deletes asynchronously)."
else
  log "  no service found, skipping."
fi

log "deleting ECR repo '${ECR_REPO}' (force = remove all images)..."
if aws ecr describe-repositories --repository-names "$ECR_REPO" \
      --region "$AWS_REGION" >/dev/null 2>&1; then
  aws ecr delete-repository --repository-name "$ECR_REPO" \
    --region "$AWS_REGION" --force >/dev/null
  log "  deleted."
else
  log "  no repo found, skipping."
fi

log "done. IAM user/role left intact."
