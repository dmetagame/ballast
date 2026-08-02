// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title HealthMath
/// @notice Morpho Blue position health and deleverage sizing.
/// @dev Mirrors Morpho's own accounting so that a health factor computed here is
///      exactly the one the protocol will liquidate on. Morpho considers a position
///      healthy while `collateralValue * lltv >= borrowedAssets`; we express that as a
///      WAD-scaled ratio so policies can be written against a familiar "health factor".
library HealthMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_PRICE_SCALE = 1e36;

    // Morpho's virtual shares/assets, which make share accounting inflation-resistant.
    uint256 internal constant VIRTUAL_SHARES = 1e6;
    uint256 internal constant VIRTUAL_ASSETS = 1;

    error TargetNotAboveLltv();
    error NothingToRepay();

    function mulDivDown(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y) / d;
    }

    function mulDivUp(uint256 x, uint256 y, uint256 d) internal pure returns (uint256) {
        return (x * y + (d - 1)) / d;
    }

    /// @notice Convert borrow shares to assets, rounding up exactly as Morpho does for debt.
    function toAssetsUp(uint256 shares, uint256 totalAssets, uint256 totalShares) internal pure returns (uint256) {
        return mulDivUp(shares, totalAssets + VIRTUAL_ASSETS, totalShares + VIRTUAL_SHARES);
    }

    /// @notice Value of `collateral` expressed in loan-token units.
    function collateralValue(uint256 collateral, uint256 oraclePrice) internal pure returns (uint256) {
        return mulDivDown(collateral, oraclePrice, ORACLE_PRICE_SCALE);
    }

    /// @notice Health factor in WAD. 1e18 is the liquidation boundary; below it the position is seizable.
    /// @dev Returns type(uint256).max for a debt-free position.
    function healthFactor(uint256 collateralValueInLoan, uint256 borrowedAssets, uint256 lltv)
        internal
        pure
        returns (uint256)
    {
        if (borrowedAssets == 0) return type(uint256).max;
        uint256 maxBorrow = mulDivDown(collateralValueInLoan, lltv, WAD);
        return mulDivDown(maxBorrow, WAD, borrowedAssets);
    }

    /// @notice Loan-token amount to repay so the position lands on `targetHealth`, funded by
    ///         selling collateral at an assumed round-trip cost of `slippageWad`.
    ///
    /// Repaying `R` burns `R` of debt and consumes `R / (1 - s)` of collateral value, so:
    ///
    ///     (C - R/(1-s)) * lltv / (D - R) = H_target
    ///
    /// which rearranges to:
    ///
    ///     R = D * (H_target - H_current) / (H_target - lltv/(1-s))
    ///
    /// @dev Requires `targetHealth > lltv/(1-s)`, otherwise the denominator flips sign and the
    ///      position cannot be repaired by deleveraging alone.
    function repayToReachTarget(
        uint256 collateralValueInLoan,
        uint256 borrowedAssets,
        uint256 lltv,
        uint256 targetHealth,
        uint256 slippageWad
    ) internal pure returns (uint256 repayAssets) {
        uint256 current = healthFactor(collateralValueInLoan, borrowedAssets, lltv);
        if (current >= targetHealth) return 0;

        // effective lltv once swap cost is charged against withdrawn collateral
        uint256 lltvEff = mulDivUp(lltv, WAD, WAD - slippageWad);
        if (targetHealth <= lltvEff) revert TargetNotAboveLltv();

        uint256 numerator = borrowedAssets * (targetHealth - current);
        uint256 denominator = targetHealth - lltvEff;
        repayAssets = numerator / denominator;

        if (repayAssets == 0) revert NothingToRepay();
        if (repayAssets > borrowedAssets) repayAssets = borrowedAssets;
    }

    /// @notice Collateral units to withdraw to raise `repayAssets` of loan token, including slippage.
    function collateralForRepay(uint256 repayAssets, uint256 oraclePrice, uint256 slippageWad)
        internal
        pure
        returns (uint256)
    {
        uint256 grossed = mulDivUp(repayAssets, WAD, WAD - slippageWad);
        return mulDivUp(grossed, ORACLE_PRICE_SCALE, oraclePrice);
    }
}
