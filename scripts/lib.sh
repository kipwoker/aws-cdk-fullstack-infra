#!/usr/bin/env bash
# Shared helpers for the deploy scripts. Source this file, do not execute it.

# Fallback when neither CDK_REGION nor CDK_DEFAULT_REGION is set.
# Keep in sync with DEFAULT_REGION in config/types.ts.
DEFAULT_REGION="${DEFAULT_REGION:-eu-west-1}"

# Load .env without overriding variables already set in the environment.
# Mirrors config/index.ts: quoted values keep their content (including `#`),
# unquoted values end at the first ` #` comment marker.
load_env() {
  [ -f .env ] || return 0
  while IFS='=' read -r key value || [ -n "$key" ]; do
    key="${key#export }"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [ -n "$key" ] || continue
    case "$key" in \#*) continue ;; esac
    # Tolerate CRLF files.
    value="${value%$'\r'}"
    case "$value" in
      \"*\")
        value="${value#\"}"
        value="${value%\"}"
        ;;
      \'*\')
        value="${value#\'}"
        value="${value%\'}"
        ;;
      *)
        # Trim, then drop a trailing ` # comment` only when it is unquoted.
        value="$(printf '%s' "$value" | sed -E 's/^[[:space:]]+//; s/[[:space:]]+#.*$//; s/[[:space:]]+$//')"
        ;;
    esac
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < .env
}

# `cdk deploy --outputs-file` writes one file per stage, so a run for one stage
# can never read another stage's URL, bucket, cluster or service.
default_outputs_file() {
  printf 'cdk-outputs.%s.json' "${CDK_STAGE:-development}"
}

outputs_file() {
  printf '%s' "${CDK_OUTPUTS_FILE:-$(default_outputs_file)}"
}

# Prints a stack output from this stage's CDK outputs file.
# Prints nothing (and succeeds) when the file or key is missing.
stack_output() {
  local key="$1"
  local file
  file="$(outputs_file)"
  [ -f "$file" ] || return 0
  OUT_FILE="$file" OUT_KEY="$key" node -e '
const fs = require("fs")
const file = process.env.OUT_FILE
const key = process.env.OUT_KEY
if (!fs.existsSync(file)) process.exit(0)
try {
  const outputs = JSON.parse(fs.readFileSync(file, "utf8"))
  for (const values of Object.values(outputs)) {
    if (values && values[key] !== undefined) {
      console.log(values[key])
      process.exit(0)
    }
  }
} catch (error) {
  console.error(`Could not read ${file}: ${error.message}`)
}
'
}

# Fail early with a readable message instead of a raw AWS CLI error.
require_aws() {
  if ! aws sts get-caller-identity >/dev/null 2>&1; then
    echo "AWS credentials not found. Configure a profile (AWS_PROFILE) or run 'aws configure'." >&2
    exit 1
  fi
}
