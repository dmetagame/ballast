// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ISwapAdapter} from "../interfaces/ISwapAdapter.sol";
import {IIrm} from "morpho-blue/interfaces/IIrm.sol";
import {MarketParams, Market} from "morpho-blue/interfaces/IMorpho.sol";
import {SafeTransfer} from "../libraries/SafeTransfer.sol";

/// @notice Flare's FTSOv2 block-latency feed reader.
interface IFtsoV2 {
    function getFeedById(bytes21 feedId) external view returns (uint256 value, int8 decimals, uint64 timestamp);
    function getFeedByIdInWei(bytes21 feedId) external view returns (uint256 value, uint64 timestamp);
}

/// @title TestToken
/// @notice Minimal mintable ERC20 for the Coston2 market. **Testnet scaffolding, not product.**
/// @dev Six decimals to match FXRP and USD₮0 on Flare mainnet, so position sizes and health
///      numbers on Coston2 are directly comparable to the mainnet ones.
contract TestToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 6;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory n, string memory s) {
        name = n;
        symbol = s;
    }

    /// @dev Open mint. This is a testnet faucet token; there is nothing to protect.
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title FtsoMorphoOracle
/// @notice A Morpho Blue oracle backed by Flare's **real** XRP/USD block-latency feed.
///
/// @dev This is the piece that makes the Coston2 market worth deploying rather than mocking.
///      The price is not invented: it comes from the same FTSOv2 feed, updating roughly every
///      two seconds, that makes liquidation protection viable on Flare at all. A protective
///      action on this market is racing a genuine oracle.
///
///      Morpho's convention is that `price()` returns the price of one unit of collateral
///      quoted in loan token, scaled by `1e36 * 10^(loanDecimals - collateralDecimals)`. Both
///      tokens here are 6 decimals, so those cancel and the scale is exactly 1e36.
contract FtsoMorphoOracle {
    IFtsoV2 public immutable FTSO;
    bytes21 public immutable FEED_ID;

    /// @notice Test-only override. Zero means "use the live feed".
    /// @dev A demo has to be able to show a price move on demand. Coston2 XRP will not
    ///      helpfully drop 10% while a video is recording.
    uint256 public priceOverride;
    address public immutable OWNER;

    error NotOwner();
    error StalePrice(uint64 timestamp);

    constructor(address ftso, bytes21 feedId) {
        FTSO = IFtsoV2(ftso);
        FEED_ID = feedId;
        OWNER = msg.sender;
    }

    /// @notice Force a price for demonstration. Set to zero to return to the live feed.
    function setPriceOverride(uint256 p) external {
        if (msg.sender != OWNER) revert NotOwner();
        priceOverride = p;
    }

    /// @notice Price of 1 collateral unit in loan token, scaled by 1e36.
    /// @dev Must be `view`: Morpho declares IOracle.price() as view and STATICCALLs it, so any
    ///      state write here would revert every borrow, liquidation and protective action.
    function price() external view returns (uint256) {
        if (priceOverride != 0) return priceOverride;

        (uint256 value, int8 decimals,) = FTSO.getFeedById(FEED_ID);

        // value / 10^decimals is USD per XRP. Morpho wants that scaled by 1e36.
        if (decimals >= 0) {
            return value * (10 ** (36 - uint8(decimals)));
        }
        return value * (10 ** (36 + uint8(-decimals)));
    }

    /// @notice The live feed, unmodified, for inspection.
    function livePrice() external view returns (uint256 value, int8 decimals, uint64 timestamp) {
        return FTSO.getFeedById(FEED_ID);
    }
}

/// @title ZeroIrm
/// @notice An interest rate model that charges nothing.
/// @dev Morpho requires an enabled IRM per market. Interest accrual is irrelevant to what the
///      Coston2 deployment demonstrates (a confidential trigger firing), and a zero rate keeps
///      health changes attributable purely to the oracle rather than to elapsed time.
/// @dev Implements Morpho's own IIrm rather than hand-rolled signatures. Morpho calls
///      `borrowRate(MarketParams,Market)` with structs; a `bytes` stand-in compiles fine and
///      then reverts at `createMarket` with an unrecognised selector.
contract ZeroIrm is IIrm {
    function borrowRate(MarketParams memory, Market memory) external pure returns (uint256) {
        return 0;
    }

    function borrowRateView(MarketParams memory, Market memory) external pure returns (uint256) {
        return 0;
    }
}

/// @title OracleQuotedVenue
/// @notice A swap venue that fills at the oracle price minus a fee, from its own inventory.
///
/// @dev Coston2 has no DEX for these tokens, so a deleverage needs somewhere to sell
///      collateral. This is not a constant-product pool and does not pretend to be: there is
///      no price impact and no liquidity curve, so **it cannot be used to make claims about
///      slippage**. Those claims come from the mainnet fork tests against real SparkDEX pools,
///      which is where they belong.
///
///      What it does provide is a venue that fills at a real FTSO-derived price, so the
///      deleverage arithmetic on Coston2 is exercised against genuine numbers.
contract OracleQuotedVenue is ISwapAdapter {
    using SafeTransfer for address;

    FtsoMorphoOracle public immutable ORACLE;
    address public immutable COLLATERAL;
    address public immutable LOAN;

    /// @notice Fee charged on the sale, in basis points.
    uint256 public immutable FEE_BPS;

    error WrongPair(address tokenIn, address tokenOut);
    error InsufficientOutput(uint256 got, uint256 minWanted);
    error VenueOutOfInventory(uint256 needed, uint256 available);

    constructor(address oracle, address collateral, address loan, uint256 feeBps) {
        ORACLE = FtsoMorphoOracle(oracle);
        COLLATERAL = collateral;
        LOAN = loan;
        FEE_BPS = feeBps;
    }

    /// @inheritdoc ISwapAdapter
    function swapExactIn(address tokenIn, address tokenOut, uint256 amountIn, uint256 minAmountOut, address to)
        external
        override
        returns (uint256 amountOut)
    {
        if (tokenIn != COLLATERAL || tokenOut != LOAN) revert WrongPair(tokenIn, tokenOut);

        uint256 p = ORACLE.price();
        amountOut = (amountIn * p) / 1e36;
        amountOut = (amountOut * (10_000 - FEE_BPS)) / 10_000;

        if (amountOut < minAmountOut) revert InsufficientOutput(amountOut, minAmountOut);

        uint256 available = TestToken(LOAN).balanceOf(address(this));
        if (amountOut > available) revert VenueOutOfInventory(amountOut, available);

        LOAN.safeTransfer(to, amountOut);
    }
}
