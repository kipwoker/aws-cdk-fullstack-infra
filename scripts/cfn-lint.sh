#!/usr/bin/env bash
# Lints the offline-synthesized templates. No AWS account needed.
#
#   python -m pip install --user cfn-lint   # one-time, Python >= 3.9
#   npm run lint:cfn
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck source=scripts/lib.sh
. scripts/lib.sh

if ! command -v cfn-lint >/dev/null 2>&1; then
  echo "cfn-lint is not installed. Install it once with: python -m pip install --user cfn-lint" >&2
  exit 1
fi

npm run --silent synth:offline
# W3010 is the seeded availability-zone context of the offline synth, not a
# hardcoded AZ in the codebase.
# Fail on errors only: cfn-lint's remaining warnings are CDK internals
# (duplicate DependsOn, the bundled Node 20 runtime of custom resources).
cfn-lint \
  --regions "${CDK_REGION:-${CDK_DEFAULT_REGION:-$DEFAULT_REGION}}" \
  --ignore-checks W3010 \
  --non-zero-exit-code error \
  --template cdk.out/*.template.json
