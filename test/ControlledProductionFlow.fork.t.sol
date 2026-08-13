// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {BallastManagerV3} from "../src/BallastManagerV3.sol";
import {ControlledFxrpSwapper, IControlledWflr} from "../src/helpers/ControlledFxrpSwapper.sol";
import {IMorpho, IOracle, Id, MarketParams} from "../src/interfaces/IMorpho.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";
import {SafeTransfer} from "../src/libraries/SafeTransfer.sol";

contract ControlledProductionFlowForkTest is Test {
    using SafeTransfer for address;

    uint256 internal constant FORK_BLOCK = 67_260_848;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant ORACLE_SCALE = 1e36;
    address internal constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant WFLR = 0x1D80c49BbBCd1C0911346656B529DF9E5c2F783d;
    address internal constant WFLR_FXRP_POOL = 0x9f6c46f190351275e47D7aD8D3F2c9487569211E;
    address internal constant MANAGER = 0x746066ACe5dc89a3692137b8cdE3c31328629d09;
    Id internal constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);
    bytes32 internal constant PROTECTED_TOPIC =
        keccak256("Protected(address,bytes32,address,uint256,uint256,uint256,uint256,uint256,uint256)");

    address internal borrower = makeAddr("controlledBorrower");
    address internal keeper = makeAddr("controlledKeeper");
    BallastManagerV3 internal manager = BallastManagerV3(MANAGER);
    ControlledFxrpSwapper internal swapper;
    MarketParams internal marketParams;

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("flare"), FORK_BLOCK);
        swapper = new ControlledFxrpSwapper();
        assertEq(address(swapper).codehash, keccak256(type(ControlledFxrpSwapper).runtimeCode));
        (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) =
            IMorpho(MORPHO).idToMarketParams(MARKET_ID);
        marketParams = MarketParams(loanToken, collateralToken, oracle, irm, lltv);
        vm.deal(borrower, 3 ether);
    }

    function testControlledSetupProtectReceiptAndCleanup() public {
        vm.startPrank(borrower);
        uint256 collateral = swapper.buyFxrp{value: 1 ether}(borrower, 1);
        assertLe(collateral, type(uint64).max);
        FXRP.safeApproveReset(MORPHO, collateral);
        IMorpho(MORPHO).supplyCollateral(marketParams, collateral, borrower, "");

        uint256 price = IOracle(marketParams.oracle).price();
        uint256 collateralValue = (collateral * price) / ORACLE_SCALE;
        uint256 maxBorrow = (collateralValue * marketParams.lltv) / WAD;
        uint256 borrowAmount = (maxBorrow * WAD) / 1.25e18;
        IMorpho(MORPHO).borrow(marketParams, borrowAmount, 0, borrower, borrower);
        IMorpho(MORPHO).setAuthorization(MANAGER, true);
        manager.setPolicy(MARKET_ID, 1.5e18, 1.8e18, uint64(collateral), 200, 25, 0, keeper);
        vm.stopPrank();

        (bool actionable, uint256 healthBefore,,) = manager.previewProtect(borrower, MARKET_ID);
        assertTrue(actionable);
        uint256 keeperBalanceBefore = IERC20(USDT0).balanceOf(keeper);

        vm.recordLogs();
        vm.prank(keeper);
        manager.protect(borrower, MARKET_ID);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        bool protectedEventFound;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == MANAGER && logs[i].topics.length == 4 && logs[i].topics[0] == PROTECTED_TOPIC) {
                assertEq(address(uint160(uint256(logs[i].topics[1]))), borrower);
                assertEq(logs[i].topics[2], Id.unwrap(MARKET_ID));
                assertEq(address(uint160(uint256(logs[i].topics[3]))), keeper);
                (uint256 eventHealthBefore, uint256 eventHealthAfter, uint256 repaid, uint256 sold,, uint256 fee) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint256));
                assertEq(eventHealthBefore, healthBefore);
                assertGt(eventHealthAfter, eventHealthBefore);
                assertGt(repaid, 0);
                assertGt(sold, 0);
                assertGt(fee, 0);
                protectedEventFound = true;
            }
        }
        assertTrue(protectedEventFound);
        assertGt(IERC20(USDT0).balanceOf(keeper), keeperBalanceBefore);
        assertEq(IERC20(FXRP).balanceOf(MANAGER), 0);
        assertEq(IERC20(USDT0).balanceOf(MANAGER), 0);

        vm.startPrank(borrower);
        manager.disablePolicy(MARKET_ID);
        (, uint128 borrowShares,) = IMorpho(MORPHO).position(MARKET_ID, borrower);
        USDT0.safeApproveReset(MORPHO, type(uint256).max);
        IMorpho(MORPHO).repay(marketParams, 0, borrowShares, borrower, "");
        USDT0.safeApprove(MORPHO, 0);
        (,, uint128 remainingCollateral) = IMorpho(MORPHO).position(MARKET_ID, borrower);
        IMorpho(MORPHO).withdrawCollateral(marketParams, remainingCollateral, borrower, borrower);
        IMorpho(MORPHO).setAuthorization(MANAGER, false);
        uint256 fxrpBalance = IERC20(FXRP).balanceOf(borrower);
        FXRP.safeApproveReset(address(swapper), fxrpBalance);
        uint256 wflrOut = swapper.sellFxrp(fxrpBalance, borrower, 1);
        assertGt(wflrOut, 0);
        uint256 wflrBalance = IERC20(WFLR).balanceOf(borrower);
        IControlledWflr(WFLR).withdraw(wflrBalance);
        vm.stopPrank();

        (, uint128 finalBorrowShares, uint128 finalCollateral) = IMorpho(MORPHO).position(MARKET_ID, borrower);
        assertEq(finalBorrowShares, 0);
        assertEq(finalCollateral, 0);
        assertFalse(manager.policyOf(borrower, MARKET_ID).enabled);
        assertFalse(IMorpho(MORPHO).isAuthorized(borrower, MANAGER));
        assertEq(IERC20(FXRP).balanceOf(address(swapper)), 0);
        assertEq(IERC20(WFLR).balanceOf(address(swapper)), 0);
    }
}
