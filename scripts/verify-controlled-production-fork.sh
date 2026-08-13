#!/usr/bin/env bash
set -euo pipefail

: "${RPC_ALIAS:=flare}"
: "${RPC_TIMEOUT:=60}"
: "${FORK_RETRIES:=2}"
: "${VERIFY_TIMEOUT:=720}"

if ! output=$(timeout "$VERIFY_TIMEOUT" forge test \
    --match-contract ControlledProductionFlowForkTest \
    --rpc-url "$RPC_ALIAS" \
    --rpc-timeout "$RPC_TIMEOUT" \
    --fork-retries "$FORK_RETRIES" \
    --summary 2>&1); then
  printf '%s\n' "$output" >&2
  exit 1
fi
printf '%s\n' "$output"
grep -Fq '[PASS] testControlledSetupProtectReceiptAndCleanup()' <<<"$output"
grep -Fq 'Suite result: ok. 1 passed; 0 failed; 0 skipped' <<<"$output"
printf 'controlled production fork verified: setup, protection receipt, and cleanup succeed\n'
