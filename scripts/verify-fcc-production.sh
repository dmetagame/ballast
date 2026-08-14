#!/usr/bin/env bash
set -euo pipefail

: "${COSTON2_RPC:=https://coston2-api.flare.network/ext/C/rpc}"
: "${FLARE_TEE_MANAGER:=0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE}"
: "${TEE_ID:=0xd56b33B50F76E126616d9545E3469De45415d152}"
: "${EXTENSION_ID:=0x0000000000000000000000000000000000000000000000000000000000010246}"
: "${EXT_PROXY_URL:=https://ballast.rouma.online}"
: "${VERIFY_ATTEMPTS:=4}"
: "${VERIFY_RETRY_DELAY_SECONDS:=2}"

[[ "$VERIFY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || {
  printf 'VERIFY_ATTEMPTS must be a positive integer\n' >&2
  exit 1
}
[[ "$VERIFY_RETRY_DELAY_SECONDS" =~ ^[0-9]+$ ]] || {
  printf 'VERIFY_RETRY_DELAY_SECONDS must be a non-negative integer\n' >&2
  exit 1
}

retry() {
  local label=$1
  shift
  local attempt status
  for ((attempt = 1; attempt <= VERIFY_ATTEMPTS; attempt += 1)); do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if ((attempt < VERIFY_ATTEMPTS)); then
      printf '%s failed (attempt %d/%d); retrying in %ds\n' \
        "$label" "$attempt" "$VERIFY_ATTEMPTS" "$((VERIFY_RETRY_DELAY_SECONDS * attempt))" >&2
      sleep "$((VERIFY_RETRY_DELAY_SECONDS * attempt))"
    fi
  done
  return "$status"
}

cast_call() {
  (cd /tmp && env -u CHAIN cast call "$@")
}

machine=$(retry 'Coston2 getTeeMachine' cast_call "$FLARE_TEE_MANAGER" \
  'getTeeMachine(address)((address,address,string))' "$TEE_ID" --rpc-url "$COSTON2_RPC")
status=$(retry 'Coston2 getTeeMachineStatus' cast_call "$FLARE_TEE_MANAGER" \
  'getTeeMachineStatus(address)(uint8)' "$TEE_ID" --rpc-url "$COSTON2_RPC" | awk '{print $1}')

[[ "$machine" == *"\"$EXT_PROXY_URL\""* ]] || {
  printf 'FCC URL mismatch: %s\n' "$machine" >&2
  exit 1
}
[[ "$status" = 2 ]] || {
  printf 'FCC machine is not PRODUCTION: status=%s\n' "$status" >&2
  exit 1
}

info=$(retry 'FCC info endpoint' curl --fail --silent --show-error --max-time 20 \
  "$EXT_PROXY_URL/info")
public_extension=$(jq -r '.machineData.extensionId' <<<"$info")
[[ "${public_extension,,}" = "${EXTENSION_ID,,}" ]] || {
  printf 'public proxy extension mismatch: actual=%s expected=%s\n' \
    "$public_extension" "$EXTENSION_ID" >&2
  exit 1
}

printf 'FCC production verified: tee=%s extension=%s url=%s\n' \
  "$TEE_ID" "$EXTENSION_ID" "$EXT_PROXY_URL"
