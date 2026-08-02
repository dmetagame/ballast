// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISwapAdapter, IERC20} from "../../src/interfaces/ISwapAdapter.sol";
import {IOracle} from "../../src/interfaces/IMorpho.sol";
import {SafeTransfer} from "../../src/libraries/SafeTransfer.sol";

/// @notice Test venue that prices swaps off the market's own oracle, minus a fixed fee.
/// @dev Lets the deleverage logic be tested against real Morpho state without depending on
///      whatever DEX liquidity happens to exist at a given fork block. The production
///      SparkDEX/Algebra adapter implements the same interface.
contract MockSwapAdapter is ISwapAdapter {
    using SafeTransfer for address;

    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;

    address public immutable ORACLE;
    uint256 public feeBps;

    constructor(address oracle, uint256 _feeBps) {
        ORACLE = oracle;
        feeBps = _feeBps;
    }

    function setFeeBps(uint256 v) external {
        feeBps = v;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address to)
        external
        override
        returns (uint256 amountOut)
    {
        // tokenIn was transferred to this adapter by the caller before the call.
        uint256 price = IOracle(ORACLE).price();
        amountOut = (amountIn * price) / ORACLE_PRICE_SCALE;
        amountOut = (amountOut * (10_000 - feeBps)) / 10_000;

        require(amountOut >= minAmountOut, "MockSwapAdapter: slippage");
        require(IERC20(tokenOut).balanceOf(address(this)) >= amountOut, "MockSwapAdapter: no liquidity");

        tokenIn; // consumed, retained by the adapter
        tokenOut.safeTransfer(to, amountOut);
    }
}
