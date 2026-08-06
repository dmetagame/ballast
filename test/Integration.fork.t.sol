// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BallastManager} from "../src/BallastManager.sol";
import {SparkDexAdapter} from "../src/adapters/SparkDexAdapter.sol";
import {PoolPusher} from "./mocks/PoolPusher.sol";
import {IMorpho, IOracle, Id} from "../src/interfaces/IMorpho.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";

/// @notice Full path with no mocks: a real Morpho position on Flare mainnet is deleveraged by
///         selling its real collateral into the real SparkDEX pool.
///
/// The only simulated input is the oracle price, which is mocked downward to stand in for an
/// XRP drawdown. Everything else — the borrower's debt and collateral, Morpho's accounting,
/// the flash loan, and the DEX liquidity absorbing the sale — is live mainnet state.
contract IntegrationForkTest is Test {
    /// @dev Pinned so measured slippage and health numbers are reproducible.
    uint256 constant FORK_BLOCK = 66470000;

    address constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address constant ORACLE = 0x183fe314130c9d4C1dcdC9695DAe6C92d913d29A;
    address constant POOL_ALGEBRA = 0x927485d88a66253c63Af9163dca5f21c25A57393;

    Id constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);
    address constant BORROWER_MID = 0x94743510608B2D49Cf9E7509Fcd4018801Bb5506; // ~$83k debt

    /// @dev Firelight vault; used to fund the pool-pusher (see Liquidity test for why not `deal`).
    address constant FXRP_WHALE = 0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3;

    BallastManager ballast;
    SparkDexAdapter adapter;
    PoolPusher pusher;
    address keeper = makeAddr("keeper");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("flare"), FORK_BLOCK);
        adapter = new SparkDexAdapter();
        adapter.setPool(FXRP, USDT0, POOL_ALGEBRA);
        ballast = new BallastManager(MORPHO, address(adapter));
        adapter.setManager(address(ballast));
        pusher = new PoolPusher();
        vm.prank(FXRP_WHALE);
        IERC20(FXRP).transfer(address(pusher), 3_000_000e6);
    }

    /// @notice Simulate an XRP drawdown faithfully: move the DEX price *and* the Morpho oracle.
    /// @param sqrtFactorE9 sqrt(1 - drop) * 1e9 — 948683298 for -10%, 894427191 for -20%.
    function _dropMarket(uint256 dropBps, uint256 sqrtFactorE9) internal {
        uint256 pusherBefore = IERC20(FXRP).balanceOf(address(pusher));
        pusher.pushDown(POOL_ALGEBRA, sqrtFactorE9);
        console2.log(
            "  [drawdown] FXRP dumped into pool to move price:",
            (pusherBefore - IERC20(FXRP).balanceOf(address(pusher))) / 1e6
        );
        uint256 p = IOracle(ORACLE).price();
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IOracle.price.selector), abi.encode((p * (10_000 - dropBps)) / 10_000)
        );
    }

    function _enroll(uint32 slippageBps) internal {
        vm.startPrank(BORROWER_MID);
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(MARKET_ID, 1.15e18, 1.35e18, type(uint64).max, slippageBps, 25, 0);
        vm.stopPrank();
    }

    /// @notice The whole loop, against live DEX liquidity.
    function testEndToEndDeleverageThroughSparkDex() public {
        // In a faithful drawdown the pool is left imbalanced and the sale costs ~4.8%, not the
        // ~1.17% measured on an undisturbed pool. A 6% bound still clears, and is still far
        // cheaper than Morpho's ~7.4% liquidation incentive.
        _enroll(600);

        _dropMarket(1000, 948683298); // XRP -10%, pool and oracle together
        uint256 healthBefore = ballast.healthOf(BORROWER_MID, MARKET_ID);
        uint256 borrowerUsdtBefore = IERC20(USDT0).balanceOf(BORROWER_MID);

        (bool actionable,, uint256 repay, uint256 collNeeded) = ballast.previewProtect(BORROWER_MID, MARKET_ID);
        assertTrue(actionable);

        vm.prank(keeper);
        ballast.protect(BORROWER_MID, MARKET_ID);

        uint256 healthAfter = ballast.healthOf(BORROWER_MID, MARKET_ID);

        console2.log("health after -10% drop :", healthBefore);
        console2.log("repay (USD0)           :", repay / 1e6);
        console2.log("collateral sold (FXRP) :", collNeeded / 1e6);
        console2.log("health after protect   :", healthAfter);
        console2.log("keeper fee (USD0)      :", IERC20(USDT0).balanceOf(keeper) / 1e6);
        console2.log("surplus to borrower    :", (IERC20(USDT0).balanceOf(BORROWER_MID) - borrowerUsdtBefore) / 1e6);

        assertLt(healthBefore, 1.15e18, "should have been below trigger");
        assertGt(healthAfter, healthBefore, "health must improve");
        assertGt(healthAfter, 1.25e18, "should land near target");
        assertGt(IERC20(USDT0).balanceOf(keeper), 0, "keeper is paid");
        assertEq(IERC20(FXRP).balanceOf(address(ballast)), 0, "no collateral retained");
        assertEq(IERC20(USDT0).balanceOf(address(ballast)), 0, "no loan token retained");
    }

    function testProtectionDoesNotDistributePreExistingManagerBalance() public {
        _enroll(600);
        _dropMarket(1000, 948683298);

        uint256 existingBalance = 1_000e6;
        deal(USDT0, address(ballast), existingBalance);
        uint256 borrowerBefore = IERC20(USDT0).balanceOf(BORROWER_MID);

        vm.prank(keeper);
        ballast.protect(BORROWER_MID, MARKET_ID);

        assertEq(
            IERC20(USDT0).balanceOf(address(ballast)), existingBalance, "unrelated manager funds must be preserved"
        );
        assertLt(
            IERC20(USDT0).balanceOf(BORROWER_MID) - borrowerBefore,
            existingBalance,
            "the borrower must receive only this action's swap surplus"
        );
    }

    /// @notice Under stress, a bound calibrated to calm markets makes Ballast refuse to act.
    /// @dev This is the honest failure mode. Liquidity is worst exactly when protection is
    ///      needed: after the pool has absorbed the drawdown its USD₮0 side is depleted and the
    ///      same sale costs ~4.8% instead of ~1.17%. A 1.5% bound is then unachievable, and
    ///      Ballast reverts rather than dumping the borrower's collateral into a broken book.
    ///      The borrower keeps their position and takes their chances with the liquidators.
    function testTightBoundRefusesInStressedPool() public {
        _enroll(150); // calibrated on a calm pool; unachievable once the pool is stressed

        _dropMarket(1000, 948683298);
        uint256 healthBefore = ballast.healthOf(BORROWER_MID, MARKET_ID);
        (,, uint128 collateralBefore) = IMorpho(MORPHO).position(MARKET_ID, BORROWER_MID);

        vm.prank(keeper);
        vm.expectRevert();
        ballast.protect(BORROWER_MID, MARKET_ID);

        (,, uint128 collateralAfter) = IMorpho(MORPHO).position(MARKET_ID, BORROWER_MID);
        assertEq(collateralAfter, collateralBefore, "position must be untouched after a failed action");
        assertEq(ballast.healthOf(BORROWER_MID, MARKET_ID), healthBefore, "health unchanged");
    }

    /// @notice Chunked deleveraging: capping collateral per action keeps each sale in the
    ///         cheap part of the curve, which is how large positions stay economic.
    function testChunkedDeleverageKeepsSalesSmall() public {
        vm.startPrank(BORROWER_MID);
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        // Restoring all the way to 1.35 needs a ~52k FXRP sale in the stressed pool. Cap each
        // action at 45k FXRP and aim lower, keeping every sale in the cheaper part of the curve.
        ballast.setPolicy(MARKET_ID, 1.15e18, 1.35e18, 45_000e6, 600, 25, 0);
        vm.stopPrank();

        _dropMarket(1000, 948683298);

        // A full one-shot repair exceeds the cap and is refused.
        vm.prank(keeper);
        vm.expectRevert();
        ballast.protect(BORROWER_MID, MARKET_ID);

        // A smaller target fits under the cap and still clears the trigger.
        vm.prank(BORROWER_MID);
        ballast.setPolicy(MARKET_ID, 1.15e18, 1.22e18, 45_000e6, 600, 25, 0);

        vm.prank(keeper);
        ballast.protect(BORROWER_MID, MARKET_ID);

        uint256 health = ballast.healthOf(BORROWER_MID, MARKET_ID);
        console2.log("health after one capped step:", health);
        assertGt(health, 1.15e18, "one capped step already clears the trigger");
    }
}
