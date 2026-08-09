// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BallastManagerV3} from "../src/BallastManagerV3.sol";
import {SparkDexAdapterV2} from "../src/adapters/SparkDexAdapterV2.sol";

contract DeployV3 is Script {
    address internal constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant POOL_ALGEBRA = 0x927485d88a66253c63Af9163dca5f21c25A57393;
    uint256 internal constant DEFAULT_ADMIN_DELAY = 2 days;

    function run() external returns (BallastManagerV3 ballast, SparkDexAdapterV2 adapter) {
        address morpho = vm.envOr("MORPHO", MORPHO);
        address collateral = vm.envOr("COLLATERAL_TOKEN", FXRP);
        address loan = vm.envOr("LOAN_TOKEN", USDT0);
        address pool = vm.envOr("SWAP_POOL", POOL_ALGEBRA);
        address guardian = vm.envAddress("GUARDIAN");
        address finalOwner = vm.envAddress("OWNER");
        uint256 adminDelay = vm.envOr("ADMIN_DELAY", DEFAULT_ADMIN_DELAY);
        require(guardian != address(0) && finalOwner != address(0), "zero admin address");
        require(adminDelay > 0, "zero admin delay");

        vm.startBroadcast();

        adapter = new SparkDexAdapterV2(adminDelay);
        adapter.proposePool(collateral, loan, pool);
        ballast = new BallastManagerV3(morpho, address(adapter), guardian, adminDelay);
        adapter.setManager(address(ballast));
        ballast.proposeOwnership(finalOwner);
        adapter.proposeOwnership(finalOwner);

        vm.stopBroadcast();

        console2.log("=== Ballast v3 deployed ===");
        console2.log("  BallastManagerV3:", address(ballast));
        console2.log("  SparkDexAdapterV2:", address(adapter));
        console2.log("  Guardian        :", guardian);
        console2.log("  Admin delay     :", adminDelay);
        console2.log("  Final owner     :", finalOwner);
        console2.log("  Ownership acceptance available after:", ballast.ownershipTransferEta());
    }
}
