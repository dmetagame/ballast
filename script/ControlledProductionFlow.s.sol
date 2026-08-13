// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {BallastManagerV3} from "../src/BallastManagerV3.sol";
import {ControlledFxrpSwapper, IControlledWflr} from "../src/helpers/ControlledFxrpSwapper.sol";
import {IMorpho, IOracle, Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../src/libraries/SafeTransfer.sol";

abstract contract ControlledProductionBase is Script {
    using SafeTransfer for address;

    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_SCALE = 1e36;
    address internal constant QUOTE_ACTOR = 0x0000000000000000000000000000000000000420;
    address internal constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant WFLR = 0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d;
    address internal constant WFLR_FXRP_POOL = 0x9f6c46f190351275e47D7aD8D3F2c9487569211E;
    address internal constant MANAGER = 0x746066ACe5dc89a3692137b8cdE3c31328629d09;
    address internal constant PRODUCTION_KEEPER = 0xA20a59090f609329405F5DcA785Af9357F6965E7;
    address internal constant PUBLIC_ANVIL_ACCOUNT = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;
    Id internal constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);

    function _borrower() internal view returns (address borrower) {
        borrower = vm.envAddress("BORROWER");
        require(borrower != address(0) && borrower != PUBLIC_ANVIL_ACCOUNT, "unsafe borrower");
    }

    function _marketParams() internal view returns (MarketParams memory marketParams) {
        (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) =
            IMorpho(MORPHO).idToMarketParams(MARKET_ID);
        require(loanToken == USDT0 && collateralToken == FXRP, "unexpected market");
        marketParams = MarketParams(loanToken, collateralToken, oracle, irm, lltv);
    }

    function _swapper() internal view returns (ControlledFxrpSwapper swapper) {
        swapper = ControlledFxrpSwapper(payable(vm.envAddress("SWAPPER")));
        require(
            address(swapper).codehash == keccak256(type(ControlledFxrpSwapper).runtimeCode), "unexpected swapper code"
        );
        require(swapper.POOL() == WFLR_FXRP_POOL && swapper.WFLR() == WFLR && swapper.FXRP() == FXRP, "bad swapper");
    }
}

contract DeployControlledFxrpSwapper is ControlledProductionBase {
    function run() external returns (ControlledFxrpSwapper swapper) {
        vm.startBroadcast();
        swapper = new ControlledFxrpSwapper();
        vm.stopBroadcast();
        console2.log("controlled swapper:", address(swapper));
    }
}

contract QuoteControlledProductionFlow is ControlledProductionBase {
    using SafeTransfer for address;

    function run() external {
        uint256 flrInput = vm.envOr("FLR_INPUT_WEI", uint256(1 ether));
        uint256 minimumBps = vm.envOr("MINIMUM_BPS", uint256(9_900));
        require(flrInput > 0 && minimumBps > 0 && minimumBps <= 10_000, "invalid quote inputs");

        ControlledFxrpSwapper swapper = new ControlledFxrpSwapper();
        vm.deal(QUOTE_ACTOR, flrInput);
        vm.startPrank(QUOTE_ACTOR);
        uint256 fxrpOut = swapper.buyFxrp{value: flrInput}(QUOTE_ACTOR, 1);
        FXRP.safeApproveReset(address(swapper), fxrpOut);
        uint256 wflrOut = swapper.sellFxrp(fxrpOut, QUOTE_ACTOR, 1);
        vm.stopPrank();

        console2.log("quoted FXRP output units:", fxrpOut);
        console2.log("recommended MIN_FXRP_OUT:", (fxrpOut * minimumBps) / 10_000);
        console2.log("quoted round-trip WFLR units:", wflrOut);
        console2.log("reference full-size WFLR minimum (not for cleanup):", (wflrOut * minimumBps) / 10_000);
    }
}

contract ControlledProductionSetup is ControlledProductionBase {
    using SafeTransfer for address;

    function run() external {
        address borrower = _borrower();
        address keeper = vm.envOr("KEEPER", PRODUCTION_KEEPER);
        ControlledFxrpSwapper swapper = _swapper();
        MarketParams memory marketParams = _marketParams();
        BallastManagerV3 manager = BallastManagerV3(MANAGER);

        uint256 flrInput = vm.envOr("FLR_INPUT_WEI", uint256(1 ether));
        uint256 minFxrpOut = vm.envUint("MIN_FXRP_OUT");
        uint256 openHealth = vm.envOr("OPEN_HEALTH", uint256(1.25e18));
        uint128 triggerHealth = uint128(vm.envOr("TRIGGER_HEALTH", uint256(1.5e18)));
        uint128 targetHealth = uint128(vm.envOr("TARGET_HEALTH", uint256(1.8e18)));
        uint32 maxSlippageBps = uint32(vm.envOr("MAX_SLIPPAGE_BPS", uint256(200)));
        uint32 keeperFeeBps = uint32(vm.envOr("KEEPER_FEE_BPS", uint256(25)));
        uint32 cooldown = uint32(vm.envOr("COOLDOWN", uint256(0)));

        (uint256 supplyShares, uint128 borrowShares, uint128 collateralBefore) =
            IMorpho(MORPHO).position(MARKET_ID, borrower);
        require(supplyShares == 0 && borrowShares == 0 && collateralBefore == 0, "position already exists");
        require(!IMorpho(MORPHO).isAuthorized(borrower, MANAGER), "manager already authorized");
        require(!manager.policyOf(borrower, MARKET_ID).enabled, "policy already enabled");
        require(IERC20(FXRP).balanceOf(borrower) == 0, "borrower already holds FXRP");
        require(IERC20(WFLR).balanceOf(borrower) == 0, "borrower already holds WFLR");
        require(IERC20(USDT0).balanceOf(borrower) == 0, "borrower already holds USDT0");
        require(keeper == PRODUCTION_KEEPER, "unexpected keeper");
        require(openHealth > WAD && openHealth < triggerHealth && triggerHealth < targetHealth, "invalid health bounds");
        require(flrInput > 0 && minFxrpOut > 0 && borrower.balance > flrInput, "insufficient setup funding");

        vm.startBroadcast(borrower);
        uint256 collateral = swapper.buyFxrp{value: flrInput}(borrower, minFxrpOut);
        require(collateral <= type(uint64).max, "collateral exceeds policy type");
        FXRP.safeApproveReset(MORPHO, collateral);
        IMorpho(MORPHO).supplyCollateral(marketParams, collateral, borrower, "");

        uint256 price = IOracle(marketParams.oracle).price();
        uint256 collateralValue = (collateral * price) / ORACLE_SCALE;
        uint256 maxBorrow = (collateralValue * marketParams.lltv) / WAD;
        uint256 borrowAmount = (maxBorrow * WAD) / openHealth;
        require(borrowAmount > 0, "borrow rounds to zero");
        IMorpho(MORPHO).borrow(marketParams, borrowAmount, 0, borrower, borrower);
        IMorpho(MORPHO).setAuthorization(MANAGER, true);
        manager.setPolicy(
            MARKET_ID, triggerHealth, targetHealth, uint64(collateral), maxSlippageBps, keeperFeeBps, cooldown, keeper
        );
        vm.stopBroadcast();

        (bool actionable, uint256 health, uint256 repayAssets, uint256 collateralNeeded) =
            manager.previewProtect(borrower, MARKET_ID);
        require(actionable && health < triggerHealth, "position is not actionable");
        require(IMorpho(MORPHO).isAuthorized(borrower, MANAGER), "authorization missing");

        console2.log("borrower:", borrower);
        console2.log("collateral FXRP units:", collateral);
        console2.log("borrowed USDT0 units:", borrowAmount);
        console2.log("health:", health);
        console2.log("preview repay units:", repayAssets);
        console2.log("preview collateral units:", collateralNeeded);
    }
}

contract ControlledProductionProtect is ControlledProductionBase {
    function run() external {
        address borrower = _borrower();
        BallastManagerV3 manager = BallastManagerV3(MANAGER);
        BallastManagerV3.Policy memory policy = manager.policyOf(borrower, MARKET_ID);
        require(policy.enabled && policy.keeper == PRODUCTION_KEEPER, "controlled policy missing");

        (bool actionable, uint256 healthBefore,,) = manager.previewProtect(borrower, MARKET_ID);
        require(actionable, "position is not actionable");
        uint256 keeperBalanceBefore = IERC20(USDT0).balanceOf(PRODUCTION_KEEPER);

        vm.startBroadcast(PRODUCTION_KEEPER);
        manager.protect(borrower, MARKET_ID);
        vm.stopBroadcast();

        uint256 healthAfter = manager.healthOf(borrower, MARKET_ID);
        uint256 keeperFee = IERC20(USDT0).balanceOf(PRODUCTION_KEEPER) - keeperBalanceBefore;
        require(healthAfter > healthBefore, "health did not improve");
        require(keeperFee > 0, "keeper fee rounded to zero");
        require(
            IERC20(FXRP).balanceOf(MANAGER) == 0 && IERC20(USDT0).balanceOf(MANAGER) == 0, "manager retained tokens"
        );

        console2.log("borrower:", borrower);
        console2.log("health before:", healthBefore);
        console2.log("health after:", healthAfter);
        console2.log("keeper fee units:", keeperFee);
    }
}

contract ControlledProductionCleanup is ControlledProductionBase {
    using SafeTransfer for address;

    function run() external {
        address borrower = _borrower();
        ControlledFxrpSwapper swapper = _swapper();
        MarketParams memory marketParams = _marketParams();
        BallastManagerV3 manager = BallastManagerV3(MANAGER);
        uint256 minWflrOut = vm.envUint("MIN_WFLR_OUT");
        uint256 minimumBps = vm.envOr("MINIMUM_BPS", uint256(9_900));
        require(minimumBps > 0 && minimumBps <= 10_000, "invalid minimum bps");

        uint256 fxrpSold;
        uint256 wflrOut;

        vm.startBroadcast(borrower);
        if (manager.policyOf(borrower, MARKET_ID).enabled) manager.disablePolicy(MARKET_ID);

        (, uint128 borrowShares,) = IMorpho(MORPHO).position(MARKET_ID, borrower);
        if (borrowShares > 0) {
            USDT0.safeApproveReset(MORPHO, type(uint256).max);
            IMorpho(MORPHO).repay(marketParams, 0, borrowShares, borrower, "");
            USDT0.safeApprove(MORPHO, 0);
        }

        (,, uint128 collateral) = IMorpho(MORPHO).position(MARKET_ID, borrower);
        if (collateral > 0) IMorpho(MORPHO).withdrawCollateral(marketParams, collateral, borrower, borrower);
        if (IMorpho(MORPHO).isAuthorized(borrower, MANAGER)) IMorpho(MORPHO).setAuthorization(MANAGER, false);

        uint256 fxrpBalance = IERC20(FXRP).balanceOf(borrower);
        if (fxrpBalance > 0) {
            require(minWflrOut > 0, "minimum WFLR output required");
            fxrpSold = fxrpBalance;
            FXRP.safeApproveReset(address(swapper), fxrpBalance);
            wflrOut = swapper.sellFxrp(fxrpBalance, borrower, minWflrOut);
        }

        uint256 wflrBalance = IERC20(WFLR).balanceOf(borrower);
        if (wflrBalance > 0) IControlledWflr(WFLR).withdraw(wflrBalance);
        vm.stopBroadcast();

        (, uint128 remainingBorrowShares, uint128 remainingCollateral) = IMorpho(MORPHO).position(MARKET_ID, borrower);
        require(remainingBorrowShares == 0 && remainingCollateral == 0, "position not unwound");
        require(!manager.policyOf(borrower, MARKET_ID).enabled, "policy still enabled");
        require(!IMorpho(MORPHO).isAuthorized(borrower, MANAGER), "authorization still active");
        require(
            IERC20(FXRP).balanceOf(MANAGER) == 0 && IERC20(USDT0).balanceOf(MANAGER) == 0, "manager retained tokens"
        );

        console2.log("borrower:", borrower);
        console2.log("cleanup FXRP input units:", fxrpSold);
        console2.log("cleanup WFLR output units:", wflrOut);
        console2.log("recommended MIN_WFLR_OUT for immediate rerun:", (wflrOut * minimumBps) / 10_000);
        console2.log("remaining FLR wei:", borrower.balance);
        console2.log("remaining USDT0 units:", IERC20(USDT0).balanceOf(borrower));
    }
}
