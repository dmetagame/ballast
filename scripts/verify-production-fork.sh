#!/usr/bin/env bash
set -euo pipefail

: "${RPC_ALIAS:=flare}"
: "${RPC_FALLBACK_URL:=}"
: "${RPC_TIMEOUT:=60}"
: "${FORK_RETRIES:=2}"
: "${VERIFY_TIMEOUT:=720}"

attempt() {
  local rpc="$1"
  local output
  if ! output=$(timeout "$VERIFY_TIMEOUT" forge test \
      --match-contract BallastManagerV3ProductionForkTest \
      --rpc-url "$rpc" \
      --rpc-timeout "$RPC_TIMEOUT" \
      --fork-retries "$FORK_RETRIES" \
      --summary 2>&1); then
    printf 'production fork attempt failed on %s:\n%s\n' "$rpc" "$output" >&2
    return 1
  fi
  printf '%s\n' "$output"
  grep -Fq '[PASS] testProductionDeploymentProtectsRealPosition()' <<<"$output" \
    && grep -Fq 'Suite result: ok. 1 passed; 0 failed; 0 skipped' <<<"$output"
}

if attempt "$RPC_ALIAS"; then
  printf 'production fork verified: deployed V3 manager protects the live position on a fork\n'
  exit 0
fi

if [[ -n "$RPC_FALLBACK_URL" && "$RPC_FALLBACK_URL" != "$RPC_ALIAS" ]]; then
  printf 'primary fork RPC failed; retrying with %s\n' "$RPC_FALLBACK_URL" >&2
  if attempt "$RPC_FALLBACK_URL"; then
    printf 'production fork verified: deployed V3 manager protects the live position on a fork\n'
    exit 0
  fi
fi

exit 1
