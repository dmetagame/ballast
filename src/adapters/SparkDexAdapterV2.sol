// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISwapAdapter, IERC20} from "../interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

interface IConcentratedPoolV2 {
    function swap(address recipient, bool zeroToOne, int256 amountRequired, uint160 limitSqrtPrice, bytes calldata data)
        external
        returns (int256 amount0, int256 amount1);
    function token0() external view returns (address);
}

/// @title SparkDexAdapterV2
/// @notice Direct SparkDEX adapter with delayed administrative changes.
contract SparkDexAdapterV2 is ISwapAdapter {
    using SafeTransfer for address;

    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    address public owner;
    address public pendingOwner;
    uint256 public ownershipEta;
    uint256 public immutable adminDelay;
    address public manager;
    address private _activePool;

    mapping(bytes32 => address) public poolFor;
    mapping(bytes32 => address) public pendingPool;
    mapping(bytes32 => uint256) public poolEta;

    event PoolUpdateProposed(address indexed tokenIn, address indexed tokenOut, address indexed pool, uint256 eta);
    event PoolSet(address indexed tokenIn, address indexed tokenOut, address indexed pool);
    event PoolUpdateCancelled(address indexed tokenIn, address indexed tokenOut);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner, uint256 eta);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    error NotOwner();
    error NotManager(address caller);
    error ManagerAlreadySet();
    error InvalidAddress();
    error NoPendingPool();
    error TimelockNotReady(uint256 eta);
    error TimelockPending();
    error NoPool(address tokenIn, address tokenOut);
    error UnexpectedCallback(address caller);
    error InsufficientOutput(uint256 got, uint256 minWanted);
    error ZeroAmount();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(uint256 adminDelay_) {
        if (adminDelay_ == 0) revert InvalidAddress();
        owner = msg.sender;
        adminDelay = adminDelay_;
    }

    function setManager(address manager_) external onlyOwner {
        if (manager != address(0)) revert ManagerAlreadySet();
        if (manager_ == address(0) || manager_.code.length == 0) revert InvalidAddress();
        manager = manager_;
    }

    function proposePool(address tokenIn, address tokenOut, address pool) external onlyOwner {
        if (pool == address(0) || pool.code.length == 0) revert InvalidAddress();
        bytes32 key = _key(tokenIn, tokenOut);
        if (pendingPool[key] != address(0)) revert TimelockPending();
        uint256 eta = block.timestamp + adminDelay;
        pendingPool[key] = pool;
        poolEta[key] = eta;
        emit PoolUpdateProposed(tokenIn, tokenOut, pool, eta);
    }

    function acceptPool(address tokenIn, address tokenOut) external onlyOwner {
        bytes32 key = _key(tokenIn, tokenOut);
        address pool = pendingPool[key];
        if (pool == address(0)) revert NoPendingPool();
        if (block.timestamp < poolEta[key]) revert TimelockNotReady(poolEta[key]);
        pendingPool[key] = address(0);
        poolEta[key] = 0;
        poolFor[key] = pool;
        emit PoolSet(tokenIn, tokenOut, pool);
    }

    function cancelPool(address tokenIn, address tokenOut) external onlyOwner {
        bytes32 key = _key(tokenIn, tokenOut);
        if (pendingPool[key] == address(0)) revert NoPendingPool();
        pendingPool[key] = address(0);
        poolEta[key] = 0;
        emit PoolUpdateCancelled(tokenIn, tokenOut);
    }

    function proposeOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        if (pendingOwner != address(0)) revert TimelockPending();
        pendingOwner = newOwner;
        ownershipEta = block.timestamp + adminDelay;
        emit OwnershipTransferProposed(owner, newOwner, ownershipEta);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        if (block.timestamp < ownershipEta) revert TimelockNotReady(ownershipEta);
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        ownershipEta = 0;
        emit OwnershipTransferred(previous, owner);
    }

    function cancelOwnership() external onlyOwner {
        if (pendingOwner == address(0)) revert NoPendingPool();
        pendingOwner = address(0);
        ownershipEta = 0;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address to)
        external
        returns (uint256 amountOut)
    {
        if (msg.sender != manager) revert NotManager(msg.sender);
        if (amountIn == 0) revert ZeroAmount();
        address pool = poolFor[_key(tokenIn, tokenOut)];
        if (pool == address(0)) revert NoPool(tokenIn, tokenOut);
        bool zeroForOne = tokenIn == IConcentratedPoolV2(pool).token0();
        _activePool = pool;
        (int256 amount0, int256 amount1) = IConcentratedPoolV2(pool).swap(
            to,
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            abi.encode(tokenIn, pool)
        );
        _activePool = address(0);
        int256 outDelta = zeroForOne ? amount1 : amount0;
        amountOut = outDelta < 0 ? uint256(-outDelta) : 0;
        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut);
    }

    function algebraSwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payPool(amount0Delta, amount1Delta, data);
    }

    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata data) external {
        _payPool(amount0Delta, amount1Delta, data);
    }

    function _payPool(int256 amount0Delta, int256 amount1Delta, bytes calldata data) internal {
        (address tokenIn, address pool) = abi.decode(data, (address, address));
        if (msg.sender != pool || msg.sender != _activePool) revert UnexpectedCallback(msg.sender);
        uint256 owed = amount0Delta > 0 ? uint256(amount0Delta) : uint256(amount1Delta);
        tokenIn.safeTransfer(pool, owed);
    }

    function _key(address tokenIn, address tokenOut) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(tokenIn, tokenOut));
    }

    function rescue(address token, address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
    }
}
