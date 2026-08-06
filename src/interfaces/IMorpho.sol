// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Market identifier: keccak256(abi.encode(MarketParams)).
type Id is bytes32;

struct MarketParams {
    address loanToken;
    address collateralToken;
    address oracle;
    address irm;
    uint256 lltv;
}

struct MorphoMarket {
    uint128 totalSupplyAssets;
    uint128 totalSupplyShares;
    uint128 totalBorrowAssets;
    uint128 totalBorrowShares;
    uint128 lastUpdate;
    uint128 fee;
}

interface IIrm {
    function borrowRateView(MarketParams memory marketParams, MorphoMarket memory market)
        external
        view
        returns (uint256);
}

/// @dev Minimal Morpho Blue surface used by Ballast.
/// Deployed on Flare mainnet at 0xF4346F5132e810f80a28487a79c7559d9797E8B0.
interface IMorpho {
    function position(Id id, address user)
        external
        view
        returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral);

    function market(Id id)
        external
        view
        returns (
            uint128 totalSupplyAssets,
            uint128 totalSupplyShares,
            uint128 totalBorrowAssets,
            uint128 totalBorrowShares,
            uint128 lastUpdate,
            uint128 fee
        );

    function idToMarketParams(Id id)
        external
        view
        returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv);

    function accrueInterest(MarketParams memory marketParams) external;

    /// @dev Ballast never custodies funds; it acts on the borrower's position under this authorization.
    function isAuthorized(address authorizer, address authorized) external view returns (bool);
    function setAuthorization(address authorized, bool newIsAuthorized) external;

    function repay(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        bytes memory data
    ) external returns (uint256 assetsRepaid, uint256 sharesRepaid);

    function borrow(
        MarketParams memory marketParams,
        uint256 assets,
        uint256 shares,
        address onBehalf,
        address receiver
    ) external returns (uint256 assetsBorrowed, uint256 sharesBorrowed);

    function withdrawCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, address receiver)
        external;

    function supplyCollateral(MarketParams memory marketParams, uint256 assets, address onBehalf, bytes memory data)
        external;

    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}

interface IOracle {
    /// @notice Price of 1 collateral unit in loan units, scaled by 1e36 * 10^(loanDec - collDec).
    function price() external view returns (uint256);
}
