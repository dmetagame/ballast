// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BallastManager} from "../src/BallastManager.sol";
import {SparkDexAdapter} from "../src/adapters/SparkDexAdapter.sol";

/// @notice Deploys Ballast against an existing Morpho Blue deployment.
///
/// @dev Morpho Blue lives only on Flare mainnet, so this targets either mainnet or a forked
///      local node. Addresses default to the Flare mainnet FXRP/USD₮0 market and can be
///      overridden with env vars for another market.
///
///   forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
///     --private-key $PRIVATE_KEY
contract Deploy is Script {
    address constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address constant POOL_ALGEBRA = 0x927485d88a66253c63Af9163dca5f21c25A57393;

    function run() external returns (BallastManager ballast, SparkDexAdapter adapter) {
        address morpho = vm.envOr("MORPHO", MORPHO);
        address collateral = vm.envOr("COLLATERAL_TOKEN", FXRP);
        address loan = vm.envOr("LOAN_TOKEN", USDT0);
        address pool = vm.envOr("SWAP_POOL", POOL_ALGEBRA);

        vm.startBroadcast();

        adapter = new SparkDexAdapter();
        adapter.setPool(collateral, loan, pool);
        ballast = new BallastManager(morpho, address(adapter));
        adapter.setManager(address(ballast));

        vm.stopBroadcast();

        console2.log("=== Ballast deployed ===");
        console2.log("  BallastManager  :", address(ballast));
        console2.log("  SparkDexAdapter :", address(adapter));
        console2.log("  Morpho          :", morpho);
        console2.log("  swap route      :", collateral, "->", loan);
        console2.log("  via pool        :", pool);
    }
}
