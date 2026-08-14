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
      --match-contract ControlledProductionFlowForkTest \
      --rpc-url "$rpc" \
      --rpc-timeout "$RPC_TIMEOUT" \
      --fork-retries "$FORK_RETRIES" \
      --summary 2>&1); then
    printf 'controlled production fork attempt failed on %s:\n%s\n' "$rpc" "$output" >&2
    return 1
  fi
  printf '%s\n' "$output"
  grep -Fq '[PASS] testControlledSetupProtectReceiptAndCleanup()' <<<"$output" \
    && grep -Fq 'Suite result: ok. 1 passed; 0 failed; 0 skipped' <<<"$output"
}

if attempt "$RPC_ALIAS"; then
  printf 'controlled production fork verified: setup, protection receipt, and cleanup succeed\n'
  exit 0
fi

if [[ -n "$RPC_FALLBACK_URL" && "$RPC_FALLBACK_URL" != "$RPC_ALIAS" ]]; then
  printf 'primary fork RPC failed; retrying with %s\n' "$RPC_FALLBACK_URL" >&2
  if attempt "$RPC_FALLBACK_URL"; then
    printf 'controlled production fork verified: setup, protection receipt, and cleanup succeed\n'
    exit 0
  fi
fi

exit 1
