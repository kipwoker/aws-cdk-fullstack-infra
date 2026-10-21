#!/usr/bin/env bash
# Bootstraps CDK in the app region and in us-east-1 (CloudFront certificates).
# Usage: npm run bootstrap [-- --profile my-profile]
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
load_env

ACCOUNT="${CDK_ACCOUNT:-${CDK_DEFAULT_ACCOUNT:-}}"
REGION="${CDK_REGION:-${CDK_DEFAULT_REGION:-$DEFAULT_REGION}}"
# CloudFront only trusts us-east-1; keep in sync with config/types.ts.
CERTIFICATE_REGION="${CERTIFICATE_REGION:-us-east-1}"
PROFILE_ARGS=()

if [ -n "${AWS_PROFILE:-}" ]; then
  PROFILE_ARGS=(--profile "$AWS_PROFILE")
elif [ $# -gt 0 ]; then
  PROFILE_ARGS=("$@")
fi

if [ -z "$ACCOUNT" ]; then
  echo "Set CDK_ACCOUNT in .env (or export CDK_ACCOUNT) before bootstrapping." >&2
  exit 1
fi

REGIONS=("$REGION")
if [ "$CERTIFICATE_REGION" != "$REGION" ]; then
  REGIONS+=("$CERTIFICATE_REGION")
fi

for target_region in "${REGIONS[@]}"; do
  echo "Bootstrapping aws://${ACCOUNT}/${target_region}"
  npx cdk bootstrap "aws://${ACCOUNT}/${target_region}" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"}
done
