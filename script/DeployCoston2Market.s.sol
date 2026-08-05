// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IMorpho, MarketParams, Id} from "morpho-blue/interfaces/IMorpho.sol";
import {MarketParamsLib} from "morpho-blue/libraries/MarketParamsLib.sol";
import {TestToken, FtsoMorphoOracle, ZeroIrm, OracleQuotedVenue} from "../src/coston2/TestMarket.sol";

/// @notice Stands up a real, protectable lending position on Coston2.
///
/// @dev Coston2 has Flare Confidential Compute but no lending market; Flare mainnet has the
///      market but no FCC. To demonstrate a confidential trigger actually protecting something,
///      the market has to be built here.
///
///      What is genuine: Morpho Blue's own unmodified code, and the **real FTSOv2 XRP/USD
///      block-latency feed** as the oracle. What is scaffolding: the two ERC20s and the swap
///      venue, both clearly named and documented as such. Slippage claims come from the
///      mainnet fork tests, not from here.
///
///   forge script script/DeployCoston2Market.s.sol --rpc-url coston2 --broadcast
contract DeployCoston2Market is Script {
    using MarketParamsLib for MarketParams;

    /// @dev FtsoV2 on Coston2, and the feed id for "XRP/USD" (category 01, name right-padded).
    address constant FTSO_V2 = 0xC4e9c78EA53db782E28f28Fdf80BaF59336B304d;
    bytes21 constant XRP_USD_FEED = bytes21(0x015852502f55534400000000000000000000000000);

    /// @dev 77%, the same LLTV as the live FXRP/USD₮0 market on Flare mainnet.
    uint256 constant LLTV = 0.77e18;

    function run() external {
        address deployer = msg.sender;
        vm.startBroadcast();

        TestToken collateral = new TestToken("Ballast Test XRP", "tXRP");
        TestToken loan = new TestToken("Ballast Test USD", "tUSD");

        FtsoMorphoOracle oracle = new FtsoMorphoOracle(FTSO_V2, XRP_USD_FEED);
        ZeroIrm irm = new ZeroIrm();

        IMorpho morpho = IMorpho(deployCode("Morpho.sol:Morpho", abi.encode(deployer)));

        morpho.enableIrm(address(irm));
        morpho.enableLltv(LLTV);

        MarketParams memory mp = MarketParams({
            loanToken: address(loan),
            collateralToken: address(collateral),
            oracle: address(oracle),
            irm: address(irm),
            lltv: LLTV
        });
        morpho.createMarket(mp);

        OracleQuotedVenue venue = new OracleQuotedVenue(address(oracle), address(collateral), address(loan), 30);

        // Seed: lender liquidity, venue inventory, and the borrower's collateral.
        loan.mint(deployer, 2_000_000e6);
        loan.mint(address(venue), 1_000_000e6);
        collateral.mint(deployer, 1_000_000e6);

        loan.approve(address(morpho), type(uint256).max);
        collateral.approve(address(morpho), type(uint256).max);

        morpho.supply(mp, 500_000e6, 0, deployer, "");
        morpho.supplyCollateral(mp, 100_000e6, deployer, "");

        vm.stopBroadcast();

        console2.log("=== Coston2 market ===");
        console2.log("  Morpho    :", address(morpho));
        console2.log("  collateral:", address(collateral));
        console2.log("  loan      :", address(loan));
        console2.log("  oracle    :", address(oracle));
        console2.log("  irm       :", address(irm));
        console2.log("  venue     :", address(venue));
        console2.log("  marketId  :");
        console2.logBytes32(Id.unwrap(mp.id()));
    }
}
