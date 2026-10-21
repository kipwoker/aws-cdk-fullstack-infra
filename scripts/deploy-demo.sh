#!/usr/bin/env bash
# One command for the whole sample stack: infrastructure, demo API image and
# the React frontend. Values are read from CDK outputs, nothing is hardcoded.
# Outputs land in cdk-outputs.<stage>.json so stages never read each other's
# bucket, cluster or URL.
#
#   npm run deploy:demo                  # deploy everything (development stage)
#   npm run deploy:demo -- --skip-infra  # rebuild and re-upload only the frontend
#   CDK_STAGE=production npm run deploy:demo
#
# The first run with a brand-new domain needs DNS delegation first:
#   npx cdk deploy <project>-zone   ->   set the NameServers at your registrar
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
load_env

STAGE="${CDK_STAGE:-development}"
# Keep the outputs file (and every later stack_output call) on this stage.
export CDK_STAGE="$STAGE"
OUTPUTS_FILE="$(outputs_file)"
SKIP_INFRA=false

for arg in "$@"; do
  case "$arg" in
    --skip-infra) SKIP_INFRA=true ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

require_aws

TAG="${IMAGE_TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"

if [ "$SKIP_INFRA" = false ]; then
  # 1. Registry first: the API service needs an image before it can start.
  REGISTRY_STACK="$(npx cdk list -c stage="$STAGE" | grep -E -- "-registry-${STAGE}$" | head -1 || true)"
  if [ -z "$REGISTRY_STACK" ]; then
    echo "Could not find the registry stack. Inspect names with: npx cdk list -c stage=$STAGE" >&2
    exit 1
  fi
  npx cdk deploy "$REGISTRY_STACK" -c stage="$STAGE" --require-approval broadening --outputs-file "$OUTPUTS_FILE"

  # 2. Build and push the sample API image (the ECS service does not exist yet).
  ECR_REPOSITORY="$(stack_output RepositoryUri)" \
    bash scripts/push-image.sh examples/api "$TAG" --no-deploy

  # 3. Everything else: certificate, network, database, API, ClickHouse, frontend hosting.
  npx cdk deploy --all -c stage="$STAGE" --require-approval broadening --outputs-file "$OUTPUTS_FILE"
fi

# 4. Build the React app against the deployed API and upload it.
API_URL="$(stack_output ApiUrl)"
SITE_URL="$(stack_output SiteUrl)"
if [ -z "$API_URL" ] || [ -z "$SITE_URL" ]; then
  echo "Missing stack outputs. Run 'npm run deploy:demo' without --skip-infra first." >&2
  exit 1
fi

npm --prefix examples/web ci --no-audit --no-fund
VITE_API_URL="$API_URL" npm --prefix examples/web run build
bash scripts/deploy-site.sh examples/web/dist

echo
echo "Demo deployed"
echo "  frontend  $SITE_URL"
echo "  api       $API_URL/health"
echo "  image     $TAG"
