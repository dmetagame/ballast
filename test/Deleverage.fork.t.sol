// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BallastManager} from "../src/BallastManager.sol";
import {IMorpho, IOracle, Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";
import {HealthMath} from "../src/libraries/HealthMath.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

/// @notice Fork tests against the live Morpho Blue FXRP -> USD₮0 market on Flare mainnet,
///         using a real borrower's real position.
///
/// The borrowers referenced here are genuine mainnet addresses discovered by scanning
/// Morpho's Borrow events. They have not authorized Ballast, so the test grants that
/// authorization via `vm.prank` — the point is to prove the mechanism works against real
/// state and real collateral, not to touch anyone's funds.
contract DeleverageForkTest is Test {
    /// @dev Pinned so measured slippage and health numbers are reproducible.
    uint256 constant FORK_BLOCK = 66470000;

    address constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address constant ORACLE = 0x183fe314130c9d4C1dcdC9695DAe6C92d913d29A;

    Id constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);

    // Real mainnet borrowers in this market, discovered by event scan.
    address constant BORROWER_SMALL = 0xbAB1059A5dDAeE7f716051f81795b952cb86dAac; // ~$44k debt
    address constant BORROWER_MID = 0x94743510608B2D49Cf9E7509Fcd4018801Bb5506; // ~$83k debt
    address constant BORROWER_WHALE = 0xbD482552AF79FE7Ce532D1ed857954903942079e; // ~$699k debt

    BallastManager ballast;
    MockSwapAdapter adapter;
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("flare"), FORK_BLOCK);
        adapter = new MockSwapAdapter(ORACLE, 30); // 0.30% swap fee
        ballast = new BallastManager(MORPHO, address(adapter));
        // Seed the venue so it can actually deliver USD₮0 for sold collateral.
        deal(USDT0, address(adapter), 5_000_000e6);
    }

    /// @dev Drop the reported XRP price by `dropBps` to simulate a market move.
    function _dropPrice(uint256 dropBps) internal returns (uint256 newPrice) {
        uint256 p = IOracle(ORACLE).price();
        newPrice = (p * (10_000 - dropBps)) / 10_000;
        vm.mockCall(ORACLE, abi.encodeWithSelector(IOracle.price.selector), abi.encode(newPrice));
    }

    function _enroll(address borrower, uint128 trigger, uint128 target, uint64 cap) internal {
        vm.startPrank(borrower);
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(MARKET_ID, trigger, target, cap, 100, 25, 0); // 1% slippage, 0.25% keeper fee
        vm.stopPrank();
    }

    function testRealPositionsAreReadable() public view {
        uint256 h1 = ballast.healthOf(BORROWER_SMALL, MARKET_ID);
        uint256 h2 = ballast.healthOf(BORROWER_MID, MARKET_ID);
        uint256 h3 = ballast.healthOf(BORROWER_WHALE, MARKET_ID);
        console2.log("health small :", h1);
        console2.log("health mid   :", h2);
        console2.log("health whale :", h3);
        // All three are live, solvent positions on mainnet right now.
        assertGt(h1, 1e18, "small should be solvent");
        assertGt(h2, 1e18, "mid should be solvent");
        assertGt(h3, 1e18, "whale should be solvent");
        assertLt(h1, 1.3e18, "small should be the riskiest of the three");
    }

    function testDeleverageRestoresHealthAfterPriceDrop() public {
        address borrower = BORROWER_MID;
        _enroll(borrower, 1.15e18, 1.35e18, type(uint64).max);

        uint256 healthStart = ballast.healthOf(borrower, MARKET_ID);
        _dropPrice(1000); // XRP -10%
        uint256 healthDropped = ballast.healthOf(borrower, MARKET_ID);

        console2.log("health before drop :", healthStart);
        console2.log("health after -10%  :", healthDropped);
        assertLt(healthDropped, 1.15e18, "should now be below trigger");

        (bool actionable,, uint256 repay, uint256 collNeeded) = ballast.previewProtect(borrower, MARKET_ID);
        assertTrue(actionable, "should be actionable");
        console2.log("repay assets (USDT0) :", repay);
        console2.log("collateral to sell   :", collNeeded);

        vm.prank(keeper);
        ballast.protect(borrower, MARKET_ID);

        uint256 healthAfter = ballast.healthOf(borrower, MARKET_ID);
        console2.log("health after protect :", healthAfter);

        assertGt(healthAfter, healthDropped, "health must improve");
        assertGe(healthAfter, 1.3e18, "should land near the 1.35 target");
        assertGt(IERC20(USDT0).balanceOf(keeper), 0, "keeper earns its fee");
    }

    function testProtectRevertsWhenPositionIsHealthy() public {
        address borrower = BORROWER_MID;
        _enroll(borrower, 1.15e18, 1.35e18, type(uint64).max);
        // no price drop: position is above trigger
        vm.prank(keeper);
        vm.expectRevert();
        ballast.protect(borrower, MARKET_ID);
    }

    function testProtectRevertsWithoutMorphoAuthorization() public {
        address borrower = BORROWER_SMALL;
        vm.prank(borrower);
        ballast.setPolicy(MARKET_ID, 1.15e18, 1.35e18, type(uint64).max, 100, 25, 0);
        _dropPrice(1500);

        vm.prank(keeper);
        vm.expectRevert(BallastManager.NotAuthorizedOnMorpho.selector);
        ballast.protect(borrower, MARKET_ID);
    }

    function testCollateralCapBoundsTheKeeper() public {
        address borrower = BORROWER_MID;
        // cap of 1 FXRP: far too small for the required deleverage
        _enroll(borrower, 1.15e18, 1.35e18, 1e6);
        _dropPrice(1000);

        vm.prank(keeper);
        vm.expectRevert();
        ballast.protect(borrower, MARKET_ID);
    }

    function testWhaleDeleverageAtDeeperDrop() public {
        address borrower = BORROWER_WHALE;
        _enroll(borrower, 1.1e18, 1.3e18, type(uint64).max);

        _dropPrice(2000); // XRP -20%
        uint256 healthDropped = ballast.healthOf(borrower, MARKET_ID);
        console2.log("whale health after -20% :", healthDropped);
        assertLt(healthDropped, 1.1e18);

        vm.prank(keeper);
        ballast.protect(borrower, MARKET_ID);

        uint256 healthAfter = ballast.healthOf(borrower, MARKET_ID);
        console2.log("whale health after protect :", healthAfter);
        assertGe(healthAfter, 1.25e18, "whale restored near target");
    }
}
