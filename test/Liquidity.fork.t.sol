// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {SparkDexAdapter} from "../src/adapters/SparkDexAdapter.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";
import {IOracle} from "../src/interfaces/IMorpho.sol";

/// @notice Measures the real slippage curve for selling FXRP into USD₮0 on Flare mainnet.
///
/// This is the load-bearing question for Ballast: a deleverage is only as good as the venue
/// it can sell collateral into. FXRP/USD₮0 depth is thin, so this test establishes the
/// largest position size the design can actually rescue.
contract LiquidityForkTest is Test {
    /// @dev Pinned so measured slippage and health numbers are reproducible.
    uint256 constant FORK_BLOCK = 66470000;

    address constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address constant ORACLE = 0x183fe314130c9d4C1dcdC9695DAe6C92d913d29A;

    address constant POOL_ALGEBRA = 0x927485d88a66253c63Af9163dca5f21c25A57393; // ~911k FXRP
    address constant POOL_UNIV3_500 = 0x88D46717b16619B37fa2DfD2F038DEFB4459F1F7; // ~210k FXRP

    /// @dev The Firelight vault holds ~59M FXRP. We fund tests from it rather than with
    ///      `deal`: FAsset tokens keep checkpointed internal accounting, so writing the raw
    ///      balance slot leaves an inconsistent state and the next transfer underflows.
    address constant FXRP_WHALE = 0x4C18Ff3C89632c3Dd62E796c0aFA5c07c4c1B2b3;

    SparkDexAdapter adapter;
    address manager = makeAddr("manager");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("flare"), FORK_BLOCK);
        adapter = new SparkDexAdapter();
        adapter.setPool(FXRP, USDT0, POOL_ALGEBRA);
        vm.etch(manager, hex"00");
        adapter.setManager(manager);
    }

    /// @dev Sell `amountIn` FXRP and report the effective price against the Morpho oracle.
    function _sell(uint256 amountIn, address pool) internal returns (uint256 out, int256 slipBps) {
        adapter.setPool(FXRP, USDT0, pool);
        _fundFxrp(address(adapter), amountIn);

        uint256 oraclePrice = IOracle(ORACLE).price(); // 1e36-scaled, 6dp/6dp market
        uint256 fair = (amountIn * oraclePrice) / 1e36;

        uint256 before = IERC20(USDT0).balanceOf(address(this));
        vm.prank(manager);
        out = adapter.swapExactIn(FXRP, USDT0, amountIn, 0, address(this));
        assertEq(IERC20(USDT0).balanceOf(address(this)) - before, out, "output must land on recipient");

        slipBps = int256((int256(out) - int256(fair)) * 10_000) / int256(fair);
    }

    function _fundFxrp(address to, uint256 amount) internal {
        vm.prank(FXRP_WHALE);
        IERC20(FXRP).transfer(to, amount);
    }

    function _report(uint256 amountIn, uint256 out, int256 slipBps) internal pure {
        console2.log("  in FXRP:", amountIn / 1e6);
        console2.log("    out USD0:", out / 1e6);
        console2.log("    slippage bps:", slipBps);
    }

    function testSlippageCurveOnAlgebraPool() public {
        uint256[8] memory sizes =
            [uint256(1_000e6), 5_000e6, 10_000e6, 25_000e6, 45_360e6, 100_000e6, 250_000e6, 500_000e6];

        console2.log("--- FXRP -> USD0 on SparkDEX Algebra pool ---");
        console2.log("   amountIn(FXRP)   out(USD0)   slippage(bps, negative = worse than oracle)");
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            (uint256 out, int256 slip) = _sell(sizes[i], POOL_ALGEBRA);
            _report(sizes[i], out, slip);
            vm.revertToState(snap);
        }
    }

    function testSlippageCurveOnUniV3Pool() public {
        uint256[5] memory sizes = [uint256(1_000e6), 10_000e6, 45_360e6, 100_000e6, 250_000e6];

        console2.log("--- FXRP -> USD0 on SparkDEX UniV3 fee=500 pool ---");
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 snap = vm.snapshotState();
            (uint256 out, int256 slip) = _sell(sizes[i], POOL_UNIV3_500);
            _report(sizes[i], out, slip);
            vm.revertToState(snap);
        }
    }

    /// @notice Establishes the size at which a 1% slippage bound stops being achievable.
    /// @dev At 25k FXRP the sale costs ~84bps and fits inside a 1% policy bound; at the 45,360
    ///      FXRP the mid borrower actually needs, it costs ~110bps and would revert. The 1%
    ///      default is therefore only safe for sales up to roughly 35-40k FXRP on this venue.
    function testOnePercentBoundHoldsOnlyBelowAboutFortyThousand() public {
        uint256 snap = vm.snapshotState();
        (, int256 slipAt25k) = _sell(25_000e6, POOL_ALGEBRA);
        vm.revertToState(snap);
        (, int256 slipAt45k) = _sell(45_360e6, POOL_ALGEBRA);

        console2.log("slippage bps @ 25k FXRP:", slipAt25k);
        console2.log("slippage bps @ 45.36k FXRP:", slipAt45k);
        assertGt(slipAt25k, -100, "25k clears a 1% bound");
        assertLt(slipAt45k, -100, "45k does not");
    }

    /// @notice Deleveraging only helps while it costs less than being liquidated.
    /// @dev Morpho's liquidation incentive at 77% LLTV is ~7.4%, so a sale is worth doing
    ///      while slippage stays inside ~740bps. That holds comfortably at 250k FXRP
    ///      (~392bps) and fails badly at 500k (~1816bps): above roughly 300k FXRP in a single
    ///      sale the borrower is better off being liquidated. This is why policies must cap
    ///      `maxCollateralPerAction` and deleverage in chunks across the cooldown.
    function testDeleverageBeatsLiquidationOnlyUpToAboutThreeHundredThousand() public {
        int256 LIQUIDATION_COST_BPS = -740;

        uint256 snap = vm.snapshotState();
        (, int256 at250k) = _sell(250_000e6, POOL_ALGEBRA);
        vm.revertToState(snap);
        (, int256 at500k) = _sell(500_000e6, POOL_ALGEBRA);

        console2.log("slippage bps @ 250k FXRP:", at250k);
        console2.log("slippage bps @ 500k FXRP:", at500k);
        assertGt(at250k, LIQUIDATION_COST_BPS, "250k sale still beats a liquidation");
        assertLt(at500k, LIQUIDATION_COST_BPS, "500k sale is worse than a liquidation");
    }

    /// @notice minAmountOut must abort the swap rather than dump collateral cheaply.
    function testSlippageBoundReverts() public {
        uint256 amountIn = 250_000e6;
        adapter.setPool(FXRP, USDT0, POOL_ALGEBRA);
        _fundFxrp(address(adapter), amountIn);
        uint256 fair = (amountIn * IOracle(ORACLE).price()) / 1e36;
        vm.prank(manager);
        vm.expectRevert();
        adapter.swapExactIn(FXRP, USDT0, amountIn, fair, address(this)); // demand the full oracle price
    }

    function testUnrelatedCallerCannotConsumeAdapterDust() public {
        uint256 amountIn = 1_000e6;
        _fundFxrp(address(adapter), amountIn);

        address attacker = makeAddr("attacker");
        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(SparkDexAdapter.NotManager.selector, attacker));
        adapter.swapExactIn(FXRP, USDT0, amountIn, 0, attacker);
    }
}
