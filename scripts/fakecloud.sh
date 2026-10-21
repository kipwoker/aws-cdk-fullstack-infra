#!/usr/bin/env bash
# Deploys every stack to fakecloud in Docker - no AWS account, no paid token.
#
#   npm run validate:fakecloud            # start, bootstrap, deploy, verify
#   npm run validate:fakecloud -- --down  # stop the container/proxy afterwards
#
# fakecloud (AGPL-3.0, github.com/faiscadev/fakecloud) emulates ECS with real
# Docker tasks, RDS as a real PostgreSQL container, plus ELBv2, CloudFront, ACM,
# API Gateway v2, Route53, ECR, Secrets Manager and CloudFormation. That is the
# part LocalStack Community (frozen, proprietary since March 2026) cannot do.
#
# Two adapters make it work with the CDK CLI:
#   * scripts/s3-path-proxy.js - CDK uploads assets virtual-hosted; fakecloud
#     only parses path-style S3 requests.
#   * the CDK CLI caches account IDs per access key; a previous LocalStack run
#     leaves `test -> 000000000000` behind, so the stale entry is dropped.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
load_env

CONTAINER="${FAKECLOUD_CONTAINER:-fullstack-fakecloud}"
IMAGE="${FAKECLOUD_IMAGE:-ghcr.io/faiscadev/fakecloud}"
PROXY_PORT="${FAKECLOUD_S3_PROXY_PORT:-4567}"
ENDPOINT="${FAKECLOUD_ENDPOINT:-http://localhost:4566}"
STAGE="${CDK_STAGE:-development}"
# fakecloud defaults to us-east-1; the zone and certificate stacks live there too.
REGION="${FAKECLOUD_REGION:-us-east-1}"
DOWN=false
PROXY_PID=""

for arg in "$@"; do
  case "$arg" in
    --down) DOWN=true ;;
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

stop_proxy() {
  if [ -n "$PROXY_PID" ] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
cleanup() {
  stop_proxy
}
trap cleanup EXIT

# ECS tasks, RDS, Lambda custom resources and EC2 stand-ins are sibling
# containers that fakecloud spawns; removing the emulator leaves them behind.
remove_emulator_containers() {
  local ids
  ids="$(docker ps -aq --filter 'label=fakecloud-instance' 2>/dev/null || true)"
  if [ -n "$ids" ]; then
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null 2>&1 || true
  fi
}

if [ "$DOWN" = true ]; then
  stop_proxy
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  remove_emulator_containers
  echo "Removed $CONTAINER and the containers it spawned"
  exit 0
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker is not running. Start Docker Desktop (or the docker daemon) and retry." >&2
  exit 1
fi

if ! docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  echo "Starting fakecloud ($IMAGE) as $CONTAINER..."
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  # The socket is required: ECS tasks, RDS and Lambda custom resources are real
  # sibling containers. `//var/run/docker.sock` is the portable spelling.
  MSYS_NO_PATHCONV=1 docker run -d --name "$CONTAINER" \
    -p 4566:4566 \
    -v //var/run/docker.sock:/var/run/docker.sock \
    --add-host host.docker.internal:host-gateway \
    -e FAKECLOUD_LOG=warn \
    "$IMAGE" >/dev/null
fi

echo "Waiting for fakecloud at $ENDPOINT ..."
for _ in $(seq 1 60); do
  if curl -fsS "$ENDPOINT/_fakecloud/health" >/dev/null 2>&1; then
    break
  fi
  sleep 2
done
if ! curl -fsS "$ENDPOINT/_fakecloud/health" >/dev/null 2>&1; then
  echo "fakecloud did not become ready. Inspect it with: docker logs $CONTAINER" >&2
  exit 1
fi

export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_SESSION_TOKEN=
export AWS_REGION="$REGION"
export AWS_DEFAULT_REGION="$REGION"
export CDK_REGION="$REGION"
export CDK_DEFAULT_REGION="$REGION"
export ROOT_DOMAIN="${ROOT_DOMAIN:-fullstack.localhost}"
export CDK_STAGE="$STAGE"
export CDK_OFFLINE=1

# fakecloud owns the account id; never hardcode one.
CDK_ACCOUNT="$(aws --endpoint-url "$ENDPOINT" sts get-caller-identity --query Account --output text)"
export CDK_ACCOUNT

# The CDK CLI caches "access key -> account" on disk and trusts it over STS.
# A previous LocalStack run leaves test -> 000000000000 there, which makes every
# bootstrap/deploy fail with an account mismatch.
CACHE="$HOME/.cdk/cache/accounts_partitions.json"
if [ -f "$CACHE" ]; then
  node -e '
const fs = require("fs")
const [file, expected] = process.argv.slice(1)
const data = JSON.parse(fs.readFileSync(file, "utf8"))
if (!data.test || data.test.accountId === expected) process.exit(0)
const stale = data.test.accountId
fs.copyFileSync(file, `${file}.bak`)
delete data.test
fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
console.log(`Dropped stale cached account ${stale} for the "test" key (backup: ${file}.bak)`)
' "$CACHE" "$CDK_ACCOUNT"
fi

# CDK publishes assets virtual-hosted; fakecloud only parses path-style.
node scripts/s3-path-proxy.js "$PROXY_PORT" "$ENDPOINT" >/dev/null 2>&1 &
PROXY_PID=$!
export AWS_ENDPOINT_URL_S3="http://localhost:${PROXY_PORT}"
export AWS_ENDPOINT_URL="$ENDPOINT"

OUTPUTS_FILE="$(outputs_file)"

echo "Bootstrapping CDK inside fakecloud (account $CDK_ACCOUNT)..."
npx cdklocal bootstrap "aws://${CDK_ACCOUNT}/${REGION}" --require-approval never >/dev/null

echo "Deploying the registry first..."
npx cdklocal deploy "fullstack-registry-${STAGE}" -c stage="$STAGE" --require-approval never \
  --outputs-file "$OUTPUTS_FILE" >/dev/null

REPOSITORY="$(stack_output RepositoryUri)"
if [ -z "$REPOSITORY" ]; then
  echo "Missing RepositoryUri after deploying the registry." >&2
  exit 1
fi

# ECS cannot stabilize without an image, so push the sample API into fakecloud's
# ECR first. Docker treats localhost as an insecure registry, so no daemon config
# is needed.
echo "Building and pushing the sample API image..."
# Docker talks to fakecloud's registry on the emulator endpoint; the task
# definition keeps the AWS-shaped URI and fakecloud resolves it internally.
REGISTRY="${ENDPOINT#http://}"
REPOSITORY_NAME="${REPOSITORY#*/}"
LOCAL_IMAGE="${REGISTRY}/${REPOSITORY_NAME}"
aws --endpoint-url "$ENDPOINT" ecr get-login-password \
  | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker build --quiet --build-arg APP_VERSION="$STAGE" -t "${LOCAL_IMAGE}:latest" examples/api >/dev/null
docker push "${LOCAL_IMAGE}:latest" >/dev/null

echo "Deploying every stack..."
npx cdklocal deploy --all -c stage="$STAGE" --require-approval never \
  --outputs-file "$OUTPUTS_FILE" >/dev/null

echo
echo "Checking what actually runs..."
CLUSTER="$(stack_output ClusterName)"
SERVICE="$(stack_output ServiceName)"
RUNNING="$(aws --endpoint-url "$ENDPOINT" ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
  --query 'services[0].runningCount' --output text)"
DB_STATUS="$(aws --endpoint-url "$ENDPOINT" rds describe-db-instances \
  --query 'DBInstances[0].DBInstanceStatus' --output text)"
DISTRIBUTION="$(aws --endpoint-url "$ENDPOINT" cloudfront list-distributions \
  --query 'DistributionList.Items[0].Id' --output text)"

if [ "$RUNNING" != "1" ]; then
  echo "ECS service is not running a task (runningCount=$RUNNING)." >&2
  exit 1
fi
if [ "$DB_STATUS" != "available" ]; then
  echo "RDS instance is not available (status=$DB_STATUS)." >&2
  exit 1
fi

# The task container is a real Docker container: ask it directly.
CONTAINER_ID="$(docker ps -q --filter "ancestor=${REPOSITORY}:latest" | head -1)"
HEALTH="skipped"
if [ -n "$CONTAINER_ID" ]; then
  HEALTH="$(docker exec "$CONTAINER_ID" node -e '
require("http").get("http://127.0.0.1:8080/health", (res) => {
  let body = ""
  res.on("data", (chunk) => (body += chunk))
  res.on("end", () => console.log(`${res.statusCode} ${body}`))
}).on("error", (error) => console.log(`error ${error.message}`))
' 2>/dev/null || echo "skipped")"
fi

echo "  api        $(stack_output ApiUrl)"
echo "  site       $(stack_output SiteUrl)"
echo "  analytics  $(stack_output ClickHouseUrl)"
echo "  ecs        $RUNNING task running"
echo "  rds        $DB_STATUS"
echo "  cloudfront $DISTRIBUTION"
echo "  health     $HEALTH"
echo
echo "fakecloud is still running (npm run validate:fakecloud -- --down to stop it)."
