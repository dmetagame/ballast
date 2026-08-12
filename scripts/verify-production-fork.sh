#!/usr/bin/env bash
set -euo pipefail

: "${RPC_ALIAS:=flare}"
: "${RPC_TIMEOUT:=60}"
: "${FORK_RETRIES:=2}"
: "${VERIFY_TIMEOUT:=720}"

if ! output=$(timeout "$VERIFY_TIMEOUT" forge test \
    --match-contract BallastManagerV3ProductionForkTest \
    --rpc-url "$RPC_ALIAS" \
    --rpc-timeout "$RPC_TIMEOUT" \
    --fork-retries "$FORK_RETRIES" \
    --summary 2>&1); then
  printf '%s\n' "$output" >&2
  exit 1
fi
printf '%s\n' "$output"
grep -Fq '[PASS] testProductionDeploymentProtectsRealPosition()' <<<"$output"
grep -Fq 'Suite result: ok. 1 passed; 0 failed; 0 skipped' <<<"$output"
printf 'production fork verified: deployed V3 manager protects the live position on a fork\n'
