#!/usr/bin/env bash
#
# End-to-end Ballast demo on a local node forked from Flare mainnet.
#
# Everything the demo touches is a real mainnet contract: Morpho Blue, FXRP, USD₮0, the
# market oracle and the SparkDEX pool. Only the borrower is synthetic, and they are funded
# by impersonating a real FXRP holder. No testnet, no keys, no faucet.
#
#   ./demo.sh
#
set -euo pipefail

export PATH="$HOME/.foundry/bin:$PATH"

FORK_RPC="${FORK_RPC:-https://flare-api.flare.network/ext/C/rpc}"
FORK_BLOCK="${FORK_BLOCK:-66470000}"
RPC="http://127.0.0.1:8545"

# Anvil's default deterministic accounts. These keys are published in Foundry's own docs,
# exist only on a local throwaway node, and hold nothing on any real network.
BORROWER_PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
KEEPER_PK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
BORROWER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266

FXRP=0xAd552A648C74D49E10027AB8a618A3ad4901c5bE
# Firelight vault: holds ~59M FXRP. `deal` cannot be used on FAsset tokens (checkpointed
# balances make the next transfer underflow), so we impersonate a real holder instead.
FXRP_WHALE=0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3

cleanup() { [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> starting anvil forked from Flare mainnet @ block $FORK_BLOCK"
anvil --fork-url "$FORK_RPC" --fork-block-number "$FORK_BLOCK" --silent &
ANVIL_PID=$!

for _ in $(seq 1 60); do
  cast block-number --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
cast block-number --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil failed to start"; exit 1; }
echo "    up at block $(cast block-number --rpc-url "$RPC")"

echo "==> funding demo borrower with 100k FXRP from a real holder"
cast rpc anvil_impersonateAccount "$FXRP_WHALE" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$FXRP_WHALE" 0xde0b6b3a7640000 --rpc-url "$RPC" >/dev/null
cast send "$FXRP" "transfer(address,uint256)(bool)" "$BORROWER" 100000000000 \
  --from "$FXRP_WHALE" --unlocked --rpc-url "$RPC" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$FXRP_WHALE" --rpc-url "$RPC" >/dev/null
echo "    borrower FXRP balance: $(cast call "$FXRP" "balanceOf(address)(uint256)" "$BORROWER" --rpc-url "$RPC")"

echo "==> deploying Ballast"
DEPLOY_OUT=$(forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
  --private-key "$BORROWER_PK" 2>&1)
BALLAST=$(echo "$DEPLOY_OUT" | grep -oE 'BallastManager  : 0x[0-9a-fA-F]{40}' | awk '{print $3}')
ADAPTER=$(echo "$DEPLOY_OUT" | grep -oE 'SparkDexAdapter : 0x[0-9a-fA-F]{40}' | awk '{print $3}')
[[ -z "$BALLAST" ]] && { echo "$DEPLOY_OUT" | tail -30; echo "deploy failed"; exit 1; }
echo "    BallastManager  : $BALLAST"
echo "    SparkDexAdapter : $ADAPTER"

echo "==> running the demo: open a leveraged position, then let a keeper rescue it"
BALLAST="$BALLAST" BORROWER_PK="$BORROWER_PK" KEEPER_PK="$KEEPER_PK" \
  forge script script/Demo.s.sol --rpc-url "$RPC" --broadcast --private-key "$BORROWER_PK" 2>&1 \
  | sed -n '/=== position opened ===/,/ballast holds USD0/p'

echo
echo "==> demo complete. anvil is still running on $RPC until this script exits."
