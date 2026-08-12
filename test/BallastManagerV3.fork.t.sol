// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BallastManagerV3} from "../src/BallastManagerV3.sol";
import {IMorpho, IOracle, Id} from "../src/interfaces/IMorpho.sol";
import {IERC20} from "../src/interfaces/ISwapAdapter.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";
import {SparkDexAdapterV2} from "../src/adapters/SparkDexAdapterV2.sol";

contract BallastManagerV3ForkTest is Test {
    uint256 internal constant FORK_BLOCK = 66_470_000;
    uint256 internal constant ADMIN_DELAY = 2 days;

    address internal constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant ORACLE = 0x183fe314130c9d4C1dcdC9695DAe6C92d913d29A;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant POOL_ALGEBRA = 0x927485d88a66253c63Af9163dca5f21c25A57393;
    address internal constant BORROWER = 0x94743510608B2D49Cf9E7509Fcd4018801Bb5506;
    Id internal constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);

    BallastManagerV3 internal ballast;
    MockSwapAdapter internal adapter;
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("flare"), FORK_BLOCK);
        adapter = new MockSwapAdapter(ORACLE, 30);
        ballast = new BallastManagerV3(MORPHO, address(adapter), guardian, ADMIN_DELAY);
        deal(USDT0, address(adapter), 5_000_000e6);
    }

    function testV3PreservesBoundedDeleverage() public {
        vm.startPrank(BORROWER);
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(MARKET_ID, 1.15e18, 1.35e18, type(uint64).max, 100, 25, 0, address(0));
        vm.stopPrank();

        uint256 price = IOracle(ORACLE).price();
        vm.mockCall(ORACLE, abi.encodeWithSelector(IOracle.price.selector), abi.encode((price * 9_000) / 10_000));

        uint256 healthBefore = ballast.healthOf(BORROWER, MARKET_ID);
        vm.prank(keeper);
        ballast.protect(BORROWER, MARKET_ID);
        uint256 healthAfter = ballast.healthOf(BORROWER, MARKET_ID);

        assertLt(healthBefore, 1.15e18);
        assertGt(healthAfter, healthBefore);
        assertGt(IERC20(USDT0).balanceOf(keeper), 0);
    }

    function testPauseLeavesBorrowerEscapeHatchOpen() public {
        vm.startPrank(BORROWER);
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(MARKET_ID, 1.15e18, 1.35e18, type(uint64).max, 100, 25, 0, address(0));
        vm.stopPrank();

        vm.prank(guardian);
        ballast.pause();

        vm.prank(keeper);
        vm.expectRevert(BallastManagerV3.Paused.selector);
        ballast.protect(BORROWER, MARKET_ID);

        vm.prank(BORROWER);
        ballast.disablePolicy(MARKET_ID);
        assertFalse(ballast.policyOf(BORROWER, MARKET_ID).enabled);
    }

    function testV3ProtectsThroughHardenedSparkDexAdapter() public {
        SparkDexAdapterV2 liveAdapter = new SparkDexAdapterV2(ADMIN_DELAY);
        liveAdapter.proposePool(FXRP, USDT0, POOL_ALGEBRA);
        vm.warp(block.timestamp + ADMIN_DELAY);
        liveAdapter.acceptPool(FXRP, USDT0);

        BallastManagerV3 liveBallast = new BallastManagerV3(MORPHO, address(liveAdapter), guardian, ADMIN_DELAY);
        liveAdapter.setManager(address(liveBallast));

        vm.startPrank(BORROWER);
        IMorpho(MORPHO).setAuthorization(address(liveBallast), true);
        liveBallast.setPolicy(MARKET_ID, 1.18e18, 1.35e18, type(uint64).max, 200, 25, 0, keeper);
        vm.stopPrank();

        // The pool timelock advances the fork beyond the historical FTSO freshness window.
        // Pin the oracle response after the warp so this test exercises the swap path rather
        // than depending on a live feed remaining fresh at an old block timestamp.
        vm.mockCall(
            ORACLE,
            abi.encodeWithSelector(IOracle.price.selector),
            abi.encode(1_027_279_650_000_000_000_000_000_000_000_000_000)
        );
        uint256 beforeHealth = liveBallast.healthOf(BORROWER, MARKET_ID);

        vm.prank(keeper);
        liveBallast.protect(BORROWER, MARKET_ID);

        assertGt(liveBallast.healthOf(BORROWER, MARKET_ID), beforeHealth);
        assertEq(IERC20(FXRP).balanceOf(address(liveBallast)), 0);
        assertEq(IERC20(USDT0).balanceOf(address(liveBallast)), 0);
    }
}

contract BallastManagerV3ProductionForkTest is Test {
    uint256 internal constant PRODUCTION_FORK_BLOCK = 67_260_848;
    address internal constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address internal constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address internal constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address internal constant POOL_ALGEBRA = 0x927485d88a66253c63Af9163dca5f21c25A57393;
    address internal constant BORROWER = 0x94743510608B2D49Cf9E7509Fcd4018801Bb5506;
    address internal constant PRODUCTION_MANAGER = 0x746066ACe5dc89a3692137b8cdE3c31328629d09;
    address internal constant PRODUCTION_ADAPTER = 0xA3B9822228b6d0DE77089B0C67Ec0A73A9A9C202;
    Id internal constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);

    function testProductionDeploymentProtectsRealPosition() public {
        vm.createSelectFork(vm.rpcUrl("flare"), PRODUCTION_FORK_BLOCK);

        BallastManagerV3 ballast = BallastManagerV3(PRODUCTION_MANAGER);
        SparkDexAdapterV2 adapter = SparkDexAdapterV2(PRODUCTION_ADAPTER);
        address keeper = makeAddr("productionForkKeeper");

        assertEq(address(ballast.swapAdapter()), PRODUCTION_ADAPTER);
        assertEq(adapter.manager(), PRODUCTION_MANAGER);
        assertEq(adapter.poolFor(keccak256(abi.encodePacked(FXRP, USDT0))), POOL_ALGEBRA);

        uint256 healthBefore = ballast.healthOf(BORROWER, MARKET_ID);
        uint128 trigger = 1.35e18;
        uint128 target = 1.50e18;
        assertLt(healthBefore, trigger);

        vm.startPrank(BORROWER);
        IMorpho(MORPHO).setAuthorization(PRODUCTION_MANAGER, true);
        ballast.setPolicy(MARKET_ID, trigger, target, type(uint64).max, 1_000, 25, 0, keeper);
        vm.stopPrank();

        (bool actionable,,,) = ballast.previewProtect(BORROWER, MARKET_ID);
        assertTrue(actionable);

        vm.prank(keeper);
        ballast.protect(BORROWER, MARKET_ID);

        assertGt(ballast.healthOf(BORROWER, MARKET_ID), healthBefore);
        assertEq(IERC20(FXRP).balanceOf(PRODUCTION_MANAGER), 0);
        assertEq(IERC20(USDT0).balanceOf(PRODUCTION_MANAGER), 0);
    }
}
