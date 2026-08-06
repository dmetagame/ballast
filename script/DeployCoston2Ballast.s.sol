// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IMorpho as IMorphoBlue, MarketParams} from "morpho-blue/interfaces/IMorpho.sol";
import {BallastManagerV2} from "../src/BallastManagerV2.sol";
import {ConfidentialTrigger} from "../src/ConfidentialTrigger.sol";
import {Id} from "../src/interfaces/IMorpho.sol";

/// @notice Opens a real leveraged position on the Coston2 market and puts it under
///         confidential protection.
///
/// @dev The result is a position whose liquidation trigger is not readable on-chain. What is
///      public is a commitment and a ceiling; the actual trigger lives inside the enclave.
contract DeployCoston2Ballast is Script {
    address constant MORPHO = 0x5711398A701B9D2BD47Ac8248Cba3A8cA72D053E;
    address constant COLLATERAL = 0x5226DBE5d3Bab718dCb890f726b1dC7C87B5AC02;
    address constant LOAN = 0x40CEC379b12916bc9CDFAbAd59FE112f317A3247;
    address constant ORACLE = 0x3C6379C847Af48e1e33C280Ee00f5D84ae6c02cc;
    address constant IRM = 0xb2E442A442cE5b59Dcfd34D448871932B13De905;
    address constant VENUE = 0x7F7D588Ac92d56d035bD9fce72b4055Af02Fa54F;
    uint256 constant LLTV = 0.77e18;

    address constant TEE_REGISTRY = 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE;
    uint256 constant EXTENSION_ID = 65962;

    Id constant MARKET = Id.wrap(0x545a91465e438930cf9a0173bac3ba354bbd0bb2b38c3965cc5528b40c4ca45d);

    /// @dev Public ceiling on when the enclave may act. The real trigger is below this and
    ///      never appears on-chain. Target must exceed it, or protection re-arms forever.
    uint128 constant PUBLIC_CEILING = 1.1e18;
    uint128 constant POLICY_TARGET = 1.35e18;

    function run() external {
        address borrower = msg.sender;
        bytes32 commitment = vm.envBytes32("POLICY_COMMITMENT");
        require(commitment != bytes32(0), "POLICY_COMMITMENT is zero");
        MarketParams memory mp =
            MarketParams({loanToken: LOAN, collateralToken: COLLATERAL, oracle: ORACLE, irm: IRM, lltv: LLTV});

        vm.startBroadcast();

        // Borrow against the collateral supplied at market creation, leaving health ~1.15.
        IMorphoBlue(MORPHO).borrow(mp, 71_000e6, 0, borrower, borrower);

        BallastManagerV2 ballast = new BallastManagerV2(MORPHO, VENUE);
        ConfidentialTrigger trigger = new ConfidentialTrigger(TEE_REGISTRY, address(ballast), EXTENSION_ID);

        // Non-custodial: the borrower authorises Ballast on Morpho and sets their own bounds.
        IMorphoBlue(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(MARKET, PUBLIC_CEILING, POLICY_TARGET, 60_000e6, 200, 25, 0, address(trigger));

        // Publish only the hash. The trigger itself goes to the enclave, encrypted.
        trigger.commit(MARKET, commitment);

        vm.stopBroadcast();

        console2.log("=== Coston2 confidential protection ===");
        console2.log("  BallastManagerV2   :", address(ballast));
        console2.log("  ConfidentialTrigger:", address(trigger));
        console2.log("  borrower           :", borrower);
        console2.log("  health now         :", ballast.healthOf(borrower, MARKET));
    }
}
