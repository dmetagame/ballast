// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Pluggable venue for turning withdrawn collateral into loan token during a deleverage.
/// @dev Kept behind an interface so the protection logic is independent of which DEX is live
///      on a given network (SparkDEX/Algebra on Flare mainnet, a mock in fork and unit tests).
interface ISwapAdapter {
    /// @param tokenIn Token being sold (the borrower's collateral).
    /// @param tokenOut Token needed to clear the debt (the market's loan token).
    /// @param amountIn Exact amount of `tokenIn` transferred to the adapter before the call.
    /// @param minAmountOut Slippage bound; the adapter MUST revert if it cannot meet this.
    /// @param to Recipient of `tokenOut`.
    /// @return amountOut Amount of `tokenOut` delivered to `to`.
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut);
}

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function transfer(address, uint256) external returns (bool);
    function transferFrom(address, address, uint256) external returns (bool);
    function decimals() external view returns (uint8);
}
