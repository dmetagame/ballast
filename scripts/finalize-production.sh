#!/usr/bin/env bash
set -euo pipefail

: "${BALLAST_V3:=0x746066ACe5dc89a3692137b8cdE3c31328629d09}"
: "${ADAPTER_V2:=0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202}"
: "${OWNER:=0x302a6505c225bBB145569F35B89611d0677195a9}"
: "${DEPLOYER_ACCOUNT:=/home/rouma/.foundry/keystores/botfun-agent}"
: "${DEPLOYER_PASSWORD_FILE:=/home/rouma/.foundry/keystores/botfun-agent.password}"
: "${OWNER_ACCOUNT:=/home/rouma/.foundry/keystores/mainnet-owner}"
: "${OWNER_PASSWORD_FILE:=/home/rouma/.config/ballast/mainnet-owner.password}"
: "${RPC_ALIAS:=flare}"

call() { cast call "$@" --rpc-url "$RPC_ALIAS"; }

pool_key=$(cast keccak 0xAd552A648C74D49E10027AB8a618A3ad4901c5bEe7cd86e13AC4309349F30B3435a9d337750fC82D)
pool_eta=$(call "$ADAPTER_V2" 'poolEta(bytes32)(uint256)' "$pool_key" | awk '{print $1}')
owner_eta=$(call "$BALLAST_V3" 'ownershipTransferEta()(uint256)' | awk '{print $1}')
now=$(cast block latest --field timestamp --rpc-url "$RPC_ALIAS")

if [ "$now" -lt "$pool_eta" ] || [ "$now" -lt "$owner_eta" ]; then
  printf 'timelock not ready: now=%s poolEta=%s ownershipEta=%s\n' "$now" "$pool_eta" "$owner_eta" >&2
  exit 2
fi

if [ "$(call "$ADAPTER_V2" 'pendingPool(bytes32)(address)' "$pool_key" | awk '{print tolower($1)}')" != "0x0000000000000000000000000000000000000000" ]; then
  BALLAST_V3="$BALLAST_V3" ADAPTER_V2="$ADAPTER_V2" ACCEPT_OWNERSHIP=false \
    forge script script/FinalizeV3.s.sol --rpc-url "$RPC_ALIAS" --broadcast \
    --account "$DEPLOYER_ACCOUNT" --password-file "$DEPLOYER_PASSWORD_FILE"
fi

if [ "$(call "$BALLAST_V3" 'pendingOwner()(address)' | awk '{print tolower($1)}')" = "$(printf '%s' "$OWNER" | tr '[:upper:]' '[:lower:]')" ]; then
  BALLAST_V3="$BALLAST_V3" ADAPTER_V2="$ADAPTER_V2" ACCEPT_OWNERSHIP=true \
    forge script script/FinalizeV3.s.sol --rpc-url "$RPC_ALIAS" --broadcast \
    --account "$OWNER_ACCOUNT" --password-file "$OWNER_PASSWORD_FILE"
fi

printf 'finalization commands completed; run scripts/verify-production.sh next\n'
