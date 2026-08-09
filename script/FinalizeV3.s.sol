// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BallastManagerV3} from "../src/BallastManagerV3.sol";
import {SparkDexAdapterV2} from "../src/adapters/SparkDexAdapterV2.sol";

/// @notice Finalizes delayed V3 pool activation and, when signed by the pending owner,
///         accepts the delayed ownership handoff.
contract FinalizeV3 is Script {
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;

    function run() external {
        BallastManagerV3 ballast = BallastManagerV3(vm.envAddress("BALLAST_V3"));
        SparkDexAdapterV2 adapter = SparkDexAdapterV2(vm.envAddress("ADAPTER_V2"));

        vm.startBroadcast();
        if (adapter.pendingPool(keccak256(abi.encodePacked(FXRP, USDT0))) != address(0)) {
            adapter.acceptPool(FXRP, USDT0);
            console2.log("Accepted FXRP -> USD0 pool");
        }
        if (ballast.pendingOwner() == msg.sender) {
            ballast.acceptOwnership();
            console2.log("Accepted Ballast V3 ownership");
        }
        if (adapter.pendingOwner() == msg.sender) {
            adapter.acceptOwnership();
            console2.log("Accepted adapter ownership");
        }
        vm.stopBroadcast();
    }
}
