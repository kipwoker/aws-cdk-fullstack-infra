#!/usr/bin/env bash
# Uploads a built frontend to the private bucket and invalidates CloudFront.
#
#   npm run deploy-site -- examples/web/dist
#
# Bucket and distribution come from cdk-outputs.<stage>.json (written by
# `cdk deploy --outputs-file`); set CDK_STAGE to pick the stage. Override with
# SITE_BUCKET / DISTRIBUTION_ID.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
load_env

SOURCE="${1:?usage: deploy-site.sh <built-frontend-dir>}"
BUCKET="${SITE_BUCKET:-$(stack_output SiteBucketName)}"
DISTRIBUTION="${DISTRIBUTION_ID:-$(stack_output DistributionId)}"

if [ -z "$BUCKET" ] || [ -z "$DISTRIBUTION" ]; then
  echo "Missing SiteBucketName/DistributionId. Run 'npm run deploy:demo' first." >&2
  exit 1
fi
if [ ! -d "$SOURCE" ]; then
  echo "Build output not found: $SOURCE" >&2
  exit 1
fi

aws s3 sync "$SOURCE" "s3://${BUCKET}" --delete

INVALIDATION="$(aws cloudfront create-invalidation \
  --distribution-id "$DISTRIBUTION" \
  --paths '/*' \
  --query 'Invalidation.Id' \
  --output text)"

echo "Uploaded ${SOURCE} to s3://${BUCKET} (invalidation ${INVALIDATION})"
