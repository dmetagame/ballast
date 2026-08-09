// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IMorpho, IMorphoFlashLoanCallback, IOracle, Id, MarketParams, MorphoMarket} from "./interfaces/IMorpho.sol";
import {ISwapAdapter, IERC20} from "./interfaces/ISwapAdapter.sol";
import {HealthMath} from "./libraries/HealthMath.sol";
import {SafeTransfer} from "./libraries/SafeTransfer.sol";

/// @title BallastManagerV3
/// @notice Automated deleveraging for XRP-collateralised borrow positions on Morpho Blue.
///
/// @dev Ballast is non-custodial by construction. A borrower keeps their position and their
///      funds; they grant Ballast an authorization on Morpho (`setAuthorization`) and register
///      a policy that bounds what Ballast may do. Ballast never holds user collateral outside
///      the span of a single transaction, and every action is bounded by caps the borrower set.
///
///      A protective action is a flash-loan deleverage:
///        1. flash-borrow loan token from Morpho
///        2. repay part of the borrower's debt
///        3. withdraw the matching slice of their collateral
///        4. sell it for loan token
///        5. return the flash loan, refund any surplus to the borrower
///
///      The borrower pays a liquidation penalty of ~7.4% if they are liquidated instead; the
///      point of Ballast is to spend a swap fee to avoid that.
///
///      **What v2 adds over v1.** v1's `protect()` is permissionless and gated by a public
///      `Policy.triggerHealth`, which means every protected position's exact trip wire is
///      readable on-chain. That is the single most useful thing a searcher could ask for.
///      v2 adds an optional `Policy.keeper`: when set, only that address may act, which lets
///      a `ConfidentialTrigger` holding a TEE-signed verdict be the sole caller and keeps the
///      real trigger inside the enclave.
///
///      `triggerHealth` survives in v2 as a **public ceiling**, not the real trigger. The
///      borrower's secret trigger sits somewhere at or below it, and the enclave picks the
///      moment within that band. An observer learns "their trigger is at most 1.10" instead of
///      "their trigger is exactly 1.05", so the leak drops from an exact value to a range.
///      Be honest about the size of that win: it is a meaningful reduction, not perfect
///      hiding. What it buys is that a searcher can no longer aim at a precise number.
///
///      The ceiling cannot simply be set very high to widen the band, because `targetHealth`
///      must exceed it. If the target sat below the trigger, a protected position would still
///      be under its own trigger immediately after being protected, and every action would
///      re-arm the next one. That invariant is inherited from v1 and is load-bearing.
///
///      The safety invariant is unchanged and is what makes delegating the decision sound:
///      **the enclave chooses when to act and how much, but can never exceed the bounds the
///      borrower set on-chain.** Target health and slippage arriving from a verdict are
///      clamped to the policy, never taken at face value.
contract BallastManagerV3 is IMorphoFlashLoanCallback {
    using HealthMath for uint256;
    using SafeTransfer for address;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant MAX_BPS = 10_000;

    IMorpho public immutable MORPHO;

    /// @notice Per-borrower, per-market protection policy.
    /// @dev These are the borrower's hard limits. Nothing in this contract may exceed them,
    ///      which is what makes it safe to let a keeper (or later, a TEE) decide *when* to act.
    struct Policy {
        uint128 triggerHealth; // WAD. Act only while health < this.
        uint128 targetHealth; // WAD. Restore health to at least roughly this.
        uint64 maxCollateralPerAction; // collateral units. Anti-drain cap.
        uint32 maxSlippageBps; // bound handed to the swap adapter.
        uint32 keeperFeeBps; // paid out of surplus, on the repaid amount.
        uint32 cooldown; // seconds between actions.
        uint64 lastAction; // timestamp of the last protective action.
        bool enabled;
        /// @dev Zero means v1 behaviour: `protect()` is permissionless. Non-zero restricts
        ///      every protective action to this address, which is how the confidential path
        ///      stops a searcher calling around the enclave.
        address keeper;
    }

    /// @dev borrower => market id => policy
    mapping(address => mapping(Id => Policy)) internal _policies;

    ISwapAdapter public swapAdapter;
    address public owner;
    address public pendingOwner;
    uint256 public ownershipTransferEta;
    ISwapAdapter public pendingSwapAdapter;
    uint256 public swapAdapterEta;
    address public immutable guardian;
    uint256 public immutable adminDelay;
    bool public paused;
    uint256 private _entered;

    event PolicySet(
        address indexed borrower,
        Id indexed id,
        uint128 triggerHealth,
        uint128 targetHealth,
        uint64 maxCollateralPerAction,
        uint32 maxSlippageBps
    );
    event PolicyDisabled(address indexed borrower, Id indexed id);
    event SwapAdapterSet(address indexed adapter);
    event SwapAdapterUpdateProposed(address indexed currentAdapter, address indexed pendingAdapter, uint256 eta);
    event SwapAdapterUpdateCancelled(address indexed adapter);
    event OwnershipTransferProposed(address indexed currentOwner, address indexed pendingOwner, uint256 eta);
    event OwnershipTransferCancelled(address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event GuardianPaused(address indexed guardian);
    event GuardianUnpaused(address indexed owner);

    /// @notice Verifiable receipt for a protective action.
    event Protected(
        address indexed borrower,
        Id indexed id,
        address indexed keeper,
        uint256 healthBefore,
        uint256 healthAfter,
        uint256 repaidAssets,
        uint256 collateralSold,
        uint256 surplusReturned,
        uint256 keeperFee
    );

    error NotOwner();
    error Reentrancy();
    error OnlyMorpho();
    error PolicyNotEnabled();
    error InvalidPolicy();
    error NotAuthorizedOnMorpho();
    error CooldownActive();
    error NotAtRisk(uint256 health, uint256 trigger);
    error CollateralCapExceeded(uint256 needed, uint256 cap);
    error HealthNotImproved(uint256 before_, uint256 after_);
    error NoSwapAdapter();
    error NotKeeper(address caller, address keeper);
    error NotGuardian();
    error Paused();
    error InvalidAddress();
    error TimelockPending();
    error TimelockNotReady(uint256 eta);
    error NoPendingUpdate();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_entered == 1) revert Reentrancy();
        _entered = 1;
        _;
        _entered = 0;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    constructor(address morpho, address adapter, address guardian_, uint256 adminDelay_) {
        if (morpho == address(0) || adapter == address(0) || guardian_ == address(0) || adminDelay_ == 0) {
            revert InvalidAddress();
        }
        MORPHO = IMorpho(morpho);
        swapAdapter = ISwapAdapter(adapter);
        owner = msg.sender;
        guardian = guardian_;
        adminDelay = adminDelay_;
    }

    // ---------------------------------------------------------------- admin

    function proposeSwapAdapter(address adapter) external onlyOwner {
        if (adapter == address(0) || adapter.code.length == 0) revert InvalidAddress();
        if (address(pendingSwapAdapter) != address(0)) revert TimelockPending();
        uint256 eta = block.timestamp + adminDelay;
        pendingSwapAdapter = ISwapAdapter(adapter);
        swapAdapterEta = eta;
        emit SwapAdapterUpdateProposed(address(swapAdapter), adapter, eta);
    }

    function acceptSwapAdapter() external onlyOwner {
        address adapter = address(pendingSwapAdapter);
        if (adapter == address(0)) revert NoPendingUpdate();
        if (block.timestamp < swapAdapterEta) revert TimelockNotReady(swapAdapterEta);
        pendingSwapAdapter = ISwapAdapter(address(0));
        swapAdapterEta = 0;
        swapAdapter = ISwapAdapter(adapter);
        emit SwapAdapterSet(adapter);
    }

    function cancelSwapAdapter() external onlyOwner {
        address adapter = address(pendingSwapAdapter);
        if (adapter == address(0)) revert NoPendingUpdate();
        pendingSwapAdapter = ISwapAdapter(address(0));
        swapAdapterEta = 0;
        emit SwapAdapterUpdateCancelled(adapter);
    }

    function proposeOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert InvalidAddress();
        if (pendingOwner != address(0)) revert TimelockPending();
        uint256 eta = block.timestamp + adminDelay;
        pendingOwner = newOwner;
        ownershipTransferEta = eta;
        emit OwnershipTransferProposed(owner, newOwner, eta);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        if (block.timestamp < ownershipTransferEta) revert TimelockNotReady(ownershipTransferEta);
        address previousOwner = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        ownershipTransferEta = 0;
        emit OwnershipTransferred(previousOwner, owner);
    }

    function cancelOwnership() external onlyOwner {
        if (pendingOwner == address(0)) revert NoPendingUpdate();
        address cancelled = pendingOwner;
        pendingOwner = address(0);
        ownershipTransferEta = 0;
        emit OwnershipTransferCancelled(cancelled);
    }

    function pause() external {
        if (msg.sender != guardian) revert NotGuardian();
        paused = true;
        emit GuardianPaused(msg.sender);
    }

    function unpause() external onlyOwner {
        paused = false;
        emit GuardianUnpaused(msg.sender);
    }

    // --------------------------------------------------------------- policy

    /// @notice Register or update protection for one of your Morpho positions.
    /// @dev You must separately call `morpho.setAuthorization(address(this), true)`.
    function setPolicy(
        Id id,
        uint128 triggerHealth,
        uint128 targetHealth,
        uint64 maxCollateralPerAction,
        uint32 maxSlippageBps,
        uint32 keeperFeeBps,
        uint32 cooldown,
        address keeper
    ) external {
        if (triggerHealth < WAD) revert InvalidPolicy(); // never arm below the liquidation line
        if (targetHealth <= triggerHealth) revert InvalidPolicy();
        if (maxCollateralPerAction == 0) revert InvalidPolicy();
        if (maxSlippageBps > 1_000) revert InvalidPolicy(); // hard ceiling of 10%
        if (keeperFeeBps > 500) revert InvalidPolicy(); // hard ceiling of 5%

        Policy storage p = _policies[msg.sender][id];
        p.triggerHealth = triggerHealth;
        p.targetHealth = targetHealth;
        p.maxCollateralPerAction = maxCollateralPerAction;
        p.maxSlippageBps = maxSlippageBps;
        p.keeperFeeBps = keeperFeeBps;
        p.cooldown = cooldown;
        p.keeper = keeper;
        p.enabled = true;

        emit PolicySet(msg.sender, id, triggerHealth, targetHealth, maxCollateralPerAction, maxSlippageBps);
    }

    function disablePolicy(Id id) external {
        _policies[msg.sender][id].enabled = false;
        emit PolicyDisabled(msg.sender, id);
    }

    function policyOf(address borrower, Id id) external view returns (Policy memory) {
        return _policies[borrower][id];
    }

    // ----------------------------------------------------------------- view

    /// @notice Current health factor of `borrower` in market `id`, in WAD.
    /// @dev Uses the same accounting Morpho liquidates on, so 1e18 is exactly the seizure line.
    function healthOf(address borrower, Id id) public view returns (uint256) {
        MarketParams memory mp = _marketParams(id);
        (, uint128 borrowShares, uint128 collateral) = MORPHO.position(id, borrower);
        MorphoMarket memory market = _market(id);

        uint256 debt = HealthMath.toAssetsUp(
            borrowShares, HealthMath.expectedTotalBorrowAssets(mp, market), market.totalBorrowShares
        );
        uint256 cv = HealthMath.collateralValue(collateral, IOracle(mp.oracle).price());
        return HealthMath.healthFactor(cv, debt, mp.lltv);
    }

    /// @notice Whether a keeper could act on this position right now, and what it would cost.
    function previewProtect(address borrower, Id id)
        external
        view
        returns (bool actionable, uint256 health, uint256 repayAssets, uint256 collateralNeeded)
    {
        Policy memory p = _policies[borrower][id];
        if (!p.enabled) return (false, healthOf(borrower, id), 0, 0);
        if (block.timestamp < uint256(p.lastAction) + p.cooldown) return (false, healthOf(borrower, id), 0, 0);
        if (!MORPHO.isAuthorized(borrower, address(this))) return (false, healthOf(borrower, id), 0, 0);

        MarketParams memory mp = _marketParams(id);
        (, uint128 borrowShares, uint128 collateral) = MORPHO.position(id, borrower);
        MorphoMarket memory market = _market(id);

        uint256 price = IOracle(mp.oracle).price();
        uint256 debt = HealthMath.toAssetsUp(
            borrowShares, HealthMath.expectedTotalBorrowAssets(mp, market), market.totalBorrowShares
        );
        uint256 cv = HealthMath.collateralValue(collateral, price);
        health = HealthMath.healthFactor(cv, debt, mp.lltv);
        if (health >= p.triggerHealth) return (false, health, 0, 0);

        uint256 slip = (uint256(p.maxSlippageBps) * WAD) / MAX_BPS;
        repayAssets = HealthMath.repayToReachTarget(cv, debt, mp.lltv, p.targetHealth, slip);
        collateralNeeded = HealthMath.collateralForRepay(repayAssets, price, slip);
        actionable = repayAssets > 0 && collateralNeeded <= p.maxCollateralPerAction && collateralNeeded <= collateral;
    }

    // -------------------------------------------------------------- keeper

    struct FlashData {
        Id id;
        address borrower;
        address keeper;
        uint256 repayAssets;
        uint256 collateralOut;
        uint256 minAmountOut;
        uint256 keeperFeeBps;
        uint256 balanceBefore;
    }

    /// @notice Deleverage `borrower`'s position back toward their target health.
    /// @dev Permissionless unless the borrower named a keeper, in which case only that keeper
    ///      may act. Either way, only within the borrower's policy bounds.
    function protect(address borrower, Id id) external nonReentrant whenNotPaused {
        Policy storage p = _policies[borrower][id];
        _protect(borrower, id, p.targetHealth, p.maxSlippageBps);
    }

    /// @notice Act on a position using parameters decided off-chain, typically inside a TEE.
    ///
    /// @dev Callable only by the keeper the borrower named, which in the confidential design
    ///      is a `ConfidentialTrigger` that will not call unless it holds a verdict signed by
    ///      an attested machine.
    ///
    ///      `targetHealth` and `maxSlippageBps` are **clamped, not trusted**. A compromised or
    ///      buggy enclave can at worst do something the borrower already authorised: it cannot
    ///      raise the target to sell more collateral, and it cannot widen the slippage bound to
    ///      dump into a thin pool. Passing a lower value than the policy is allowed, since
    ///      acting more conservatively than authorised is always safe.
    function protectFor(address borrower, Id id, uint128 targetHealth, uint32 maxSlippageBps, address feeRecipient)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 repaid, uint256 collateralSold)
    {
        Policy storage p = _policies[borrower][id];
        if (p.keeper == address(0) || msg.sender != p.keeper) revert NotKeeper(msg.sender, p.keeper);

        if (targetHealth > p.targetHealth) targetHealth = p.targetHealth;
        if (maxSlippageBps > p.maxSlippageBps) maxSlippageBps = p.maxSlippageBps;

        return _protect(borrower, id, targetHealth, maxSlippageBps, feeRecipient);
    }

    function _protect(address borrower, Id id, uint128 targetHealth, uint32 maxSlippageBps)
        internal
        returns (uint256, uint256)
    {
        return _protect(borrower, id, targetHealth, maxSlippageBps, msg.sender);
    }

    function _protect(address borrower, Id id, uint128 targetHealth, uint32 maxSlippageBps, address feeRecipient)
        internal
        returns (uint256, uint256)
    {
        if (address(swapAdapter) == address(0)) revert NoSwapAdapter();

        Policy storage p = _policies[borrower][id];
        if (!p.enabled) revert PolicyNotEnabled();
        if (p.keeper != address(0) && msg.sender != p.keeper) revert NotKeeper(msg.sender, p.keeper);
        if (block.timestamp < uint256(p.lastAction) + p.cooldown) revert CooldownActive();
        if (!MORPHO.isAuthorized(borrower, address(this))) revert NotAuthorizedOnMorpho();

        MarketParams memory mp = _marketParams(id);
        MORPHO.accrueInterest(mp);

        (, uint128 borrowShares, uint128 collateral) = MORPHO.position(id, borrower);
        (,, uint128 totalBorrowAssets, uint128 totalBorrowShares,,) = MORPHO.market(id);

        uint256 price = IOracle(mp.oracle).price();
        uint256 debt = HealthMath.toAssetsUp(borrowShares, totalBorrowAssets, totalBorrowShares);
        uint256 cv = HealthMath.collateralValue(collateral, price);
        uint256 healthBefore = HealthMath.healthFactor(cv, debt, mp.lltv);
        if (healthBefore >= p.triggerHealth) revert NotAtRisk(healthBefore, p.triggerHealth);

        uint256 slip = (uint256(maxSlippageBps) * WAD) / MAX_BPS;
        uint256 repayAssets = HealthMath.repayToReachTarget(cv, debt, mp.lltv, targetHealth, slip);
        uint256 collateralOut = HealthMath.collateralForRepay(repayAssets, price, slip);
        if (collateralOut > p.maxCollateralPerAction) {
            revert CollateralCapExceeded(collateralOut, p.maxCollateralPerAction);
        }
        if (collateralOut > collateral) collateralOut = collateral;

        p.lastAction = uint64(block.timestamp);
        uint256 balanceBefore = IERC20(mp.loanToken).balanceOf(address(this));

        MORPHO.flashLoan(
            mp.loanToken,
            repayAssets,
            abi.encode(
                FlashData({
                    id: id,
                    borrower: borrower,
                    keeper: feeRecipient,
                    repayAssets: repayAssets,
                    collateralOut: collateralOut,
                    minAmountOut: repayAssets,
                    keeperFeeBps: p.keeperFeeBps,
                    balanceBefore: balanceBefore
                })
            )
        );

        uint256 healthAfter = healthOf(borrower, id);
        if (healthAfter <= healthBefore) revert HealthNotImproved(healthBefore, healthAfter);

        emit Protected(
            borrower,
            id,
            msg.sender,
            healthBefore,
            healthAfter,
            repayAssets,
            collateralOut,
            _lastSurplus,
            _lastKeeperFee
        );

        return (repayAssets, collateralOut);
    }

    uint256 private _lastSurplus;
    uint256 private _lastKeeperFee;

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (msg.sender != address(MORPHO)) revert OnlyMorpho();
        FlashData memory f = abi.decode(data, (FlashData));
        MarketParams memory mp = _marketParams(f.id);

        // 1. clear part of the borrower's debt with the flash-loaned funds
        _approve(mp.loanToken, address(MORPHO), f.repayAssets);
        MORPHO.repay(mp, f.repayAssets, 0, f.borrower, "");

        // 2. take the matching slice of their collateral
        MORPHO.withdrawCollateral(mp, f.collateralOut, f.borrower, address(this));

        // 3. sell it for loan token, with the borrower's slippage bound enforced by the adapter
        mp.collateralToken.safeTransfer(address(swapAdapter), f.collateralOut);
        swapAdapter.swapExactIn(mp.collateralToken, mp.loanToken, f.collateralOut, f.minAmountOut, address(this));

        // 4. settle: flash loan first, then keeper fee, then refund the borrower
        uint256 balance = IERC20(mp.loanToken).balanceOf(address(this));
        uint256 requiredBalance = f.balanceBefore + assets;
        uint256 surplus = balance > requiredBalance ? balance - requiredBalance : 0;

        uint256 fee = (f.repayAssets * f.keeperFeeBps) / MAX_BPS;
        if (fee > surplus) fee = surplus;
        if (fee > 0) mp.loanToken.safeTransfer(f.keeper, fee);

        uint256 refund = surplus - fee;
        if (refund > 0) mp.loanToken.safeTransfer(f.borrower, refund);

        _lastSurplus = refund;
        _lastKeeperFee = fee;

        _approve(mp.loanToken, address(MORPHO), assets);
    }

    // ------------------------------------------------------------ internal

    function _marketParams(Id id) internal view returns (MarketParams memory mp) {
        (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) =
            MORPHO.idToMarketParams(id);
        mp = MarketParams(loanToken, collateralToken, oracle, irm, lltv);
    }

    function _market(Id id) internal view returns (MorphoMarket memory market) {
        (
            market.totalSupplyAssets,
            market.totalSupplyShares,
            market.totalBorrowAssets,
            market.totalBorrowShares,
            market.lastUpdate,
            market.fee
        ) = MORPHO.market(id);
    }

    function _approve(address token, address spender, uint256 amount) internal {
        token.safeApproveReset(spender, amount);
    }
}
