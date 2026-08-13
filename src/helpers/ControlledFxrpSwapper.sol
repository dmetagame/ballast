// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "../interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

interface IControlledWflr is IERC20 {
    function deposit() external payable;
    function withdraw(uint256 amount) external;
}

interface IControlledPool {
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);

    function token0() external view returns (address);
    function token1() external view returns (address);
}

contract ControlledFxrpSwapper {
    using SafeTransfer for address;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public constant POOL = 0x9f6c46f190351275e47D7aD8D3F2c9487569211E;
    address public constant WFLR = 0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d;
    address public constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address private _activeToken;

    error InvalidAddress();
    error InvalidPool();
    error InvalidAmount();
    error UnexpectedCallback(address caller);
    error UnexpectedSwapDeltas(int256 amount0, int256 amount1);
    error InsufficientOutput(uint256 actual, uint256 minimum);

    constructor() {
        if (IControlledPool(POOL).token0() != WFLR || IControlledPool(POOL).token1() != FXRP) revert InvalidPool();
    }

    function buyFxrp(address recipient, uint256 minAmountOut) external payable returns (uint256 amountOut) {
        if (recipient == address(0)) revert InvalidAddress();
        if (msg.value == 0 || msg.value > uint256(type(int256).max)) revert InvalidAmount();

        IControlledWflr(WFLR).deposit{value: msg.value}();
        _activeToken = WFLR;
        (int256 amount0, int256 amount1) =
            IControlledPool(POOL).swap(recipient, true, int256(msg.value), MIN_SQRT_RATIO + 1, bytes(""));
        _activeToken = address(0);

        if (amount0 <= 0 || amount1 >= 0) revert UnexpectedSwapDeltas(amount0, amount1);
        amountOut = uint256(-amount1);
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        uint256 residual = IERC20(WFLR).balanceOf(address(this));
        if (residual > 0) WFLR.safeTransfer(msg.sender, residual);
    }

    function sellFxrp(uint256 amountIn, address recipient, uint256 minAmountOut) external returns (uint256 amountOut) {
        if (recipient == address(0)) revert InvalidAddress();
        if (amountIn == 0 || amountIn > uint256(type(int256).max)) revert InvalidAmount();

        FXRP.safeTransferFrom(msg.sender, address(this), amountIn);
        _activeToken = FXRP;
        (int256 amount0, int256 amount1) =
            IControlledPool(POOL).swap(recipient, false, int256(amountIn), MAX_SQRT_RATIO - 1, bytes(""));
        _activeToken = address(0);

        if (amount0 >= 0 || amount1 <= 0) revert UnexpectedSwapDeltas(amount0, amount1);
        amountOut = uint256(-amount0);
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        uint256 residual = IERC20(FXRP).balanceOf(address(this));
        if (residual > 0) FXRP.safeTransfer(msg.sender, residual);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payPool(amount0Delta, amount1Delta);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        _payPool(amount0Delta, amount1Delta);
    }

    function _payPool(int256 amount0Delta, int256 amount1Delta) internal {
        address activeToken = _activeToken;
        if (msg.sender != POOL || activeToken == address(0)) revert UnexpectedCallback(msg.sender);

        uint256 owed;
        if (activeToken == WFLR) {
            if (amount0Delta <= 0 || amount1Delta >= 0) revert UnexpectedSwapDeltas(amount0Delta, amount1Delta);
            owed = uint256(amount0Delta);
        } else {
            if (amount1Delta <= 0 || amount0Delta >= 0) revert UnexpectedSwapDeltas(amount0Delta, amount1Delta);
            owed = uint256(amount1Delta);
        }
        activeToken.safeTransfer(POOL, owed);
    }
}
