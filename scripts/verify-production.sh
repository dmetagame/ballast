#!/usr/bin/env bash
set -euo pipefail

: "${BALLAST_V3:=0x746066ACe5dc89a3692137b8cdE3c31328629d09}"
: "${ADAPTER_V2:=0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202}"
: "${OWNER:=0x302a6505c225bBB145569F35B89611d0677195a9}"
: "${GUARDIAN:=0xFf97ED39EAe2a4f5fa79097EdDbFD4c27876f8ce}"
: "${RPC_ALIAS:=flare}"

call() { cast call "$@" --rpc-url "$RPC_ALIAS"; }
normalize() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
expect_address() {
  local label="$1" actual="$2" expected="$3"
  if [ "$(normalize "$actual")" != "$(normalize "$expected")" ]; then
    printf '%s mismatch: actual=%s expected=%s\n' "$label" "$actual" "$expected" >&2
    exit 1
  fi
}

pool_key=$(cast keccak 0xAd552A648C74D49E10027AB8a618A3ad4901c5bEe7cd86e13AC4309349F30B3435a9d337750fC82D)
manager_adapter=$(call "$BALLAST_V3" 'swapAdapter()(address)' | awk '{print $1}')
adapter_manager=$(call "$ADAPTER_V2" 'manager()(address)' | awk '{print $1}')
manager_owner=$(call "$BALLAST_V3" 'owner()(address)' | awk '{print $1}')
adapter_owner=$(call "$ADAPTER_V2" 'owner()(address)' | awk '{print $1}')
manager_guardian=$(call "$BALLAST_V3" 'guardian()(address)' | awk '{print $1}')
active_pool=$(call "$ADAPTER_V2" 'poolFor(bytes32)(address)' "$pool_key" | awk '{print $1}')
paused=$(call "$BALLAST_V3" 'paused()(bool)' | awk '{print $1}')
pending_pool=$(call "$ADAPTER_V2" 'pendingPool(bytes32)(address)' "$pool_key" | awk '{print $1}')
pending_manager_owner=$(call "$BALLAST_V3" 'pendingOwner()(address)' | awk '{print $1}')
pending_adapter_owner=$(call "$ADAPTER_V2" 'pendingOwner()(address)' | awk '{print $1}')

expect_address manager_adapter "$manager_adapter" "$ADAPTER_V2"
expect_address adapter_manager "$adapter_manager" "$BALLAST_V3"
expect_address manager_owner "$manager_owner" "$OWNER"
expect_address adapter_owner "$adapter_owner" "$OWNER"
expect_address guardian "$manager_guardian" "$GUARDIAN"
expect_address active_pool "$active_pool" 0x927485d88a66253c63Af9163dca5f21c25A57393
[ "$(normalize "$paused")" = false ] || { printf 'manager is paused\n' >&2; exit 1; }
[ "$(normalize "$pending_pool")" = 0x0000000000000000000000000000000000000000 ] || { printf 'pool proposal remains pending\n' >&2; exit 1; }
[ "$(normalize "$pending_manager_owner")" = 0x0000000000000000000000000000000000000000 ] || { printf 'manager ownership remains pending\n' >&2; exit 1; }
[ "$(normalize "$pending_adapter_owner")" = 0x0000000000000000000000000000000000000000 ] || { printf 'adapter ownership remains pending\n' >&2; exit 1; }
printf 'production state verified: V3 active, owned, wired, and unpaused\n'
