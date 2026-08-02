// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BallastManager} from "../src/BallastManager.sol";
import {IMorpho, IOracle, Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";

/// @notice Opens a leveraged FXRP position, enrols it in Ballast, and has a keeper rescue it.
///
/// @dev Runs against a local node forked from Flare mainnet, so Morpho, FXRP, USD₮0, the
///      oracle and the SparkDEX pool are all the real contracts. The demo borrower is funded
///      by the harness (see `demo.sh`) before this script runs.
///
///      No price manipulation is needed: the borrower simply opens at a health the policy
///      already considers unsafe, which exercises the identical code path a real drawdown
///      would take, without mocking anything.
contract Demo is Script {
    address constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    Id constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);

    uint256 constant COLLATERAL = 100_000e6; // 100k FXRP

    function run() external {
        BallastManager ballast = BallastManager(vm.envAddress("BALLAST"));
        uint256 borrowerPk = vm.envUint("BORROWER_PK");
        uint256 keeperPk = vm.envUint("KEEPER_PK");
        address borrower = vm.addr(borrowerPk);
        address keeper = vm.addr(keeperPk);

        MarketParams memory mp = _marketParams();

        // ---------------------------------------------------- open a leveraged position
        vm.startBroadcast(borrowerPk);

        IERC20(FXRP).approve(MORPHO, COLLATERAL);
        IMorpho(MORPHO).supplyCollateral(mp, COLLATERAL, borrower, "");

        // Borrow to roughly health 1.25.
        uint256 price = IOracle(mp.oracle).price();
        uint256 collateralValue = (COLLATERAL * price) / 1e36;
        uint256 maxBorrow = (collateralValue * mp.lltv) / 1e18;
        uint256 borrowAmount = (maxBorrow * 1e18) / 1.25e18;
        IMorpho(MORPHO).borrow(mp, borrowAmount, 0, borrower, borrower);

        // Arm Ballast: authorize it on Morpho, then set the policy bounds.
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(
            MARKET_ID,
            1.50e18, // trigger: act below 1.50
            1.80e18, // target: restore to 1.80
            uint64(COLLATERAL), // never touch more than the collateral supplied
            200, // 2% max slippage
            25, // 0.25% keeper fee
            0 // no cooldown for the demo
        );

        vm.stopBroadcast();

        uint256 healthBefore = ballast.healthOf(borrower, MARKET_ID);
        (bool actionable,, uint256 repay, uint256 collNeeded) = ballast.previewProtect(borrower, MARKET_ID);

        console2.log("=== position opened ===");
        console2.log("  borrower           :", borrower);
        console2.log("  collateral (FXRP)  :", COLLATERAL / 1e6);
        console2.log("  borrowed (USD0)    :", borrowAmount / 1e6);
        console2.log("  health             :", healthBefore);
        console2.log("  below trigger?     :", healthBefore < 1.50e18);
        console2.log("");
        console2.log("=== keeper preview ===");
        console2.log("  actionable         :", actionable);
        console2.log("  would repay (USD0) :", repay / 1e6);
        console2.log("  would sell (FXRP)  :", collNeeded / 1e6);

        // ------------------------------------------------------------- keeper acts
        uint256 keeperBalBefore = IERC20(USDT0).balanceOf(keeper);
        uint256 borrowerBalBefore = IERC20(USDT0).balanceOf(borrower);

        vm.startBroadcast(keeperPk);
        ballast.protect(borrower, MARKET_ID);
        vm.stopBroadcast();

        uint256 healthAfter = ballast.healthOf(borrower, MARKET_ID);
        (,, uint128 collateralAfter) = IMorpho(MORPHO).position(MARKET_ID, borrower);

        console2.log("");
        console2.log("=== after protect ===");
        console2.log("  health             :", healthBefore, "->", healthAfter);
        console2.log("  collateral left    :", uint256(collateralAfter) / 1e6, "FXRP");
        console2.log("  keeper fee (USD0)  :", (IERC20(USDT0).balanceOf(keeper) - keeperBalBefore) / 1e6);
        console2.log("  surplus to borrower:", (IERC20(USDT0).balanceOf(borrower) - borrowerBalBefore) / 1e6);
        console2.log("  ballast holds FXRP :", IERC20(FXRP).balanceOf(address(ballast)));
        console2.log("  ballast holds USD0 :", IERC20(USDT0).balanceOf(address(ballast)));

        require(healthAfter > healthBefore, "health did not improve");
        require(healthAfter >= 1.70e18, "did not reach target band");
    }

    function _marketParams() internal view returns (MarketParams memory mp) {
        (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) =
            IMorpho(MORPHO).idToMarketParams(MARKET_ID);
        mp = MarketParams(loanToken, collateralToken, oracle, irm, lltv);
    }
}
