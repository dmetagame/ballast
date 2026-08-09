#!/usr/bin/env bash
set -euo pipefail

: "${RPC_URL:=https://flare-api.flare.network/ext/C/rpc}"
: "${DEPLOYER_ADDRESS:?DEPLOYER_ADDRESS is required}"
: "${OWNER:?OWNER is required}"
: "${GUARDIAN:?GUARDIAN is required}"
: "${KEEPER:?KEEPER is required}"
: "${MIN_DEPLOYER_FLR_WEI:=10000000000000000000}"
: "${MIN_KEEPER_FLR_WEI:=1000000000000000000}"

normalize() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
require_distinct() {
  local left_name="$1" left="$2" right_name="$3" right="$4"
  if [ "$(normalize "$left")" = "$(normalize "$right")" ]; then
    printf 'roles must be distinct: %s and %s\n' "$left_name" "$right_name" >&2
    exit 1
  fi
}
decimal_lt() {
  local left="${1#${1%%[!0]*}}" right="${2#${2%%[!0]*}}"
  [ -n "$left" ] || left=0
  [ -n "$right" ] || right=0
  if [ "${#left}" -ne "${#right}" ]; then
    [ "${#left}" -lt "${#right}" ]
  else
    [[ "$left" < "$right" ]]
  fi
}

for role in DEPLOYER_ADDRESS OWNER GUARDIAN KEEPER; do
  cast to-checksum "${!role}" >/dev/null
done
require_distinct deployer "$DEPLOYER_ADDRESS" owner "$OWNER"
require_distinct deployer "$DEPLOYER_ADDRESS" guardian "$GUARDIAN"
require_distinct deployer "$DEPLOYER_ADDRESS" keeper "$KEEPER"
require_distinct owner "$OWNER" guardian "$GUARDIAN"
require_distinct owner "$OWNER" keeper "$KEEPER"
require_distinct guardian "$GUARDIAN" keeper "$KEEPER"

deployer_balance=$(cast balance "$DEPLOYER_ADDRESS" --rpc-url "$RPC_URL")
keeper_balance=$(cast balance "$KEEPER" --rpc-url "$RPC_URL")
if decimal_lt "$deployer_balance" "$MIN_DEPLOYER_FLR_WEI"; then
  printf 'deployer balance %s wei is below required %s wei\n' "$deployer_balance" "$MIN_DEPLOYER_FLR_WEI" >&2
  exit 1
fi
if decimal_lt "$keeper_balance" "$MIN_KEEPER_FLR_WEI"; then
  printf 'keeper balance %s wei is below required %s wei\n' "$keeper_balance" "$MIN_KEEPER_FLR_WEI" >&2
  exit 1
fi

printf 'production role preflight passed\n'
printf 'deployer=%s\nowner=%s\nguardian=%s\nkeeper=%s\n' "$DEPLOYER_ADDRESS" "$OWNER" "$GUARDIAN" "$KEEPER"
printf 'deployerWei=%s\nkeeperWei=%s\n' "$deployer_balance" "$keeper_balance"
