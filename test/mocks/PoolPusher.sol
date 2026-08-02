// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../../src/interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../../src/libraries/SafeTransfer.sol";

interface IPool {
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function globalState() external view returns (uint160 price, int24 tick, uint16 lastFee, uint8 pluginConfig, uint16 communityFee, bool unlocked);
    function token0() external view returns (address);
}

/// @notice Test helper that walks a concentrated-liquidity pool's price down to a target.
///
/// @dev Mocking only the Morpho oracle is not a faithful drawdown: the DEX would keep paying
///      pre-drop prices, so every deleverage looks cheaper than it would really be. This pushes
///      the pool itself to the new price by swapping into it with a `limitSqrtPrice`, which
///      makes the pool stop exactly at the target rather than requiring a sized trade.
contract PoolPusher {
    using SafeTransfer for address;

    address private _pool;

    /// @param sqrtFactorE9 sqrt(1 - drop) scaled by 1e9. For -10% pass 948683298; for -20%, 894427191.
    function pushDown(address pool, uint256 sqrtFactorE9) external returns (uint160 newSqrtPrice) {
        (uint160 sqrtPrice,,,,,) = IPool(pool).globalState();
        uint160 limit = uint160((uint256(sqrtPrice) * sqrtFactorE9) / 1e9);

        _pool = pool;
        // Huge amountSpecified: the pool fills only as far as `limit` allows.
        IPool(pool).swap(address(this), true, int256(type(int128).max), limit, abi.encode(pool));
        _pool = address(0);

        (newSqrtPrice,,,,,) = IPool(pool).globalState();
    }

    function algebraSwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _pay(a0, a1, data);
    }

    function uniswapV3SwapCallback(int256 a0, int256 a1, bytes calldata data) external {
        _pay(a0, a1, data);
    }

    function _pay(int256 a0, int256 a1, bytes calldata data) internal {
        address pool = abi.decode(data, (address));
        require(msg.sender == pool && pool == _pool, "PoolPusher: bad callback");
        uint256 owed = a0 > 0 ? uint256(a0) : uint256(a1);
        IPool(pool).token0().safeTransfer(pool, owed);
    }
}
