// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISwapAdapter, IERC20} from "../interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

interface IConcentratedPool {
    /// @dev Algebra Integral and Uniswap V3 share this signature; only the callback name differs.
    function swap(
        address recipient,
        bool zeroToOne,
        int256 amountRequired,
        uint160 limitSqrtPrice,
        bytes calldata data
    ) external returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @title SparkDexAdapter
/// @notice Sells collateral into SparkDEX concentrated-liquidity pools during a deleverage.
///
/// @dev Swaps go **directly against the pool**, not through a router. That removes a dependency
///      on an unverified router contract, avoids a second hop of fees, and means the adapter
///      works identically on Algebra Integral (SparkDEX V3.1) and Uniswap-V3-style pools, which
///      share a `swap` signature and differ only in the callback name. Both callbacks are
///      implemented and both check that the caller is the pool registered for the pair.
///
///      Pools are registered per directed pair by the owner. `minAmountOut` is enforced here
///      rather than trusted from the pool, so a thin or manipulated pool causes the whole
///      protective transaction to revert rather than dumping a borrower's collateral.
contract SparkDexAdapter is ISwapAdapter {
    using SafeTransfer for address;

    /// @dev Uniswap V3 / Algebra sqrt-price bounds; used as "no price limit" sentinels.
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public owner;

    /// @dev keccak256(tokenIn, tokenOut) => pool
    mapping(bytes32 => address) public poolFor;

    /// @dev Set for the duration of a swap so the callback can authenticate its caller.
    address private _activePool;

    event PoolSet(address indexed tokenIn, address indexed tokenOut, address indexed pool);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    error NotOwner();
    error NoPool(address tokenIn, address tokenOut);
    error UnexpectedCallback(address caller);
    error InsufficientOutput(uint256 got, uint256 minWanted);
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor() {
        owner = msg.sender;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    /// @notice Register the pool to use when selling `tokenIn` for `tokenOut`.
    function setPool(address tokenIn, address tokenOut, address pool) external onlyOwner {
        poolFor[_key(tokenIn, tokenOut)] = pool;
        emit PoolSet(tokenIn, tokenOut, pool);
    }

    /// @inheritdoc ISwapAdapter
    /// @dev `amountIn` of `tokenIn` must already have been transferred to this adapter.
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address to)
        external
        override
        returns (uint256 amountOut)
    {
        if (amountIn == 0) revert ZeroAmount();
        address pool = poolFor[_key(tokenIn, tokenOut)];
        if (pool == address(0)) revert NoPool(tokenIn, tokenOut);

        bool zeroForOne = tokenIn == IConcentratedPool(pool).token0();

        _activePool = pool;
        (int256 amount0, int256 amount1) = IConcentratedPool(pool).swap(
            to,
            zeroForOne,
            int256(amountIn), // positive => exact input
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn, pool)
        );
        _activePool = address(0);

        // The pool reports what it paid out as a negative delta on the output side.
        int256 outDelta = zeroForOne ? amount1 : amount0;
        amountOut = outDelta < 0 ? uint256(-outDelta) : 0;

        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut);
    }

    // ------------------------------------------------------------- callbacks

    /// @notice Algebra Integral (SparkDEX V3.1) swap callback.
    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payPool(amount0Delta, amount1Delta, data);
    }

    /// @notice Uniswap-V3-style swap callback.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payPool(amount0Delta, amount1Delta, data);
    }

    /// @dev Pay the pool whatever it is owed. Positive delta means we owe that token.
    function _payPool(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        (address tokenIn, address pool) = abi.decode(data, (address, address));
        if (msg.sender != pool || msg.sender != _activePool) revert UnexpectedCallback(msg.sender);

        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        tokenIn.safeTransfer(pool, owed);
    }

    // -------------------------------------------------------------- internal

    function _key(address tokenIn, address tokenOut) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }

    /// @notice Sweep any dust left behind by a partial fill.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
