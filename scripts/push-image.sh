#!/usr/bin/env bash
# Builds an image, pushes `<tag>` + `latest` and rolls the ECS service.
#
#   npm run push-image -- ../my-backend 0.6.71
#   npm run push-image -- examples/api              # tag defaults to the git sha
#   npm run push-image -- examples/api --no-deploy   # push without rolling
#
# Repository, cluster and service come from cdk-outputs.<stage>.json, written by
# `cdk deploy --outputs-file`; set CDK_STAGE to pick the stage. Override with
# ECR_REPOSITORY, ECS_CLUSTER, ECS_SERVICE when needed.
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh
load_env

CONTEXT=""
TAG=""
DEPLOY=true

for arg in "$@"; do
  case "$arg" in
    --no-deploy) DEPLOY=false ;;
    -h | --help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      if [ -z "$CONTEXT" ]; then
        CONTEXT="$arg"
      elif [ -z "$TAG" ]; then
        TAG="$arg"
      else
        echo "Unexpected argument: $arg" >&2
        exit 1
      fi
      ;;
  esac
done

if [ -z "$CONTEXT" ]; then
  echo "usage: push-image.sh <docker-context> [tag] [--no-deploy]" >&2
  exit 1
fi
if [ ! -f "$CONTEXT/Dockerfile" ]; then
  echo "No Dockerfile found in $CONTEXT" >&2
  exit 1
fi

TAG="${TAG:-$(git rev-parse --short HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
REGION="${CDK_REGION:-${CDK_DEFAULT_REGION:-$DEFAULT_REGION}}"
REPOSITORY="${ECR_REPOSITORY:-$(stack_output RepositoryUri)}"

if [ -z "$REPOSITORY" ]; then
  echo "Missing RepositoryUri. Run 'npm run deploy:demo' first (it writes $(outputs_file))." >&2
  exit 1
fi

REGISTRY="${REPOSITORY%%/*}"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "$REGISTRY"

docker build --build-arg APP_VERSION="$TAG" -t "${REPOSITORY}:${TAG}" "$CONTEXT"
docker tag "${REPOSITORY}:${TAG}" "${REPOSITORY}:latest"
docker push "${REPOSITORY}:${TAG}"
docker push "${REPOSITORY}:latest"

echo "Pushed ${REPOSITORY}:${TAG} and ${REPOSITORY}:latest"

if [ "$DEPLOY" = false ]; then
  exit 0
fi

CLUSTER="${ECS_CLUSTER:-$(stack_output ClusterName)}"
SERVICE="${ECS_SERVICE:-$(stack_output ServiceName)}"

if [ -n "$CLUSTER" ] && [ -n "$SERVICE" ]; then
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --force-new-deployment >/dev/null
  echo "Rolling deployment started on ${CLUSTER}/${SERVICE}"
else
  echo "No ECS cluster/service outputs yet - skipping the rolling deployment."
fi
