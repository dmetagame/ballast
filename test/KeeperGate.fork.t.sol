// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {BallastManagerV2} from "../src/BallastManagerV2.sol";
import {IMorpho, IOracle, Id} from "../src/interfaces/IMorpho.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

/// @notice Proves the two properties v2 exists for, against real mainnet state.
///
/// @dev The confidential design only holds if both are true. The **gate** stops a searcher
///      calling `protect()` around the enclave once they notice a position is enrolled. The
///      **clamp** means delegating the decision to a TEE never delegates authority: a
///      compromised enclave can at worst do something the borrower already authorised.
contract KeeperGateForkTest is Test {
    uint256 constant FORK_BLOCK = 66470000;

    address constant MORPHO = 0xF4346F5132e810f80a28487a79c7559d9797E8B0;
    address constant FXRP = 0xAd552A648C74D49E10027AB8a618A3ad4901c5bE;
    address constant USDT0 = 0xe7cd86e13AC4309349F30B3435a9d337750fC82D;
    address constant ORACLE = 0x183fe314130c9d4C1dcdC9695DAe6C92d913d29A;

    Id constant MARKET_ID = Id.wrap(0x2f31ab3fc12d6d10d1de9e5c74053126f03ac1f80a2e6d69d36a411fef7d942f);
    address constant BORROWER = 0x94743510608B2D49Cf9E7509Fcd4018801Bb5506; // ~$83k debt

    BallastManagerV2 ballast;
    MockSwapAdapter adapter;

    address trigger = makeAddr("confidentialTrigger");
    address searcher = makeAddr("searcher");

    uint128 constant PUBLIC_BOUND = 1.10e18; // ceiling on when the enclave may act
    uint128 constant BASELINE_HEALTH = 1.167e18; // this borrower, unstressed, at the pinned block
    uint128 constant POLICY_TARGET = 1.35e18; // must exceed the bound, or protection re-triggers forever
    uint32 constant POLICY_SLIPPAGE_BPS = 100; // 1%

    function setUp() public {
        vm.createSelectFork(vm.rpcUrl("flare"), FORK_BLOCK);
        adapter = new MockSwapAdapter(ORACLE, 30);
        ballast = new BallastManagerV2(MORPHO, address(adapter));
        deal(USDT0, address(adapter), 5_000_000e6);
    }

    /// @dev Idempotent on purpose. `vm.mockCall` survives `vm.createSelectFork`, so without the
    ///      clear a second call in the same test reads the already-mocked price and compounds
    ///      the drop, silently making the two halves of a comparison test incomparable.
    function _dropPrice(uint256 dropBps) internal {
        vm.clearMockedCalls();
        uint256 p = IOracle(ORACLE).price();
        vm.mockCall(
            ORACLE, abi.encodeWithSelector(IOracle.price.selector), abi.encode((p * (10_000 - dropBps)) / 10_000)
        );
    }

    function _enroll(address keeper) internal {
        vm.startPrank(BORROWER);
        IMorpho(MORPHO).setAuthorization(address(ballast), true);
        ballast.setPolicy(MARKET_ID, PUBLIC_BOUND, POLICY_TARGET, 200_000e6, POLICY_SLIPPAGE_BPS, 25, 0, keeper);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------- gate

    /// @dev The v1 hole. Without the gate, anyone can trip a position the moment it is enrolled.
    function testSearcherCannotCallProtectWhenKeeperIsSet() public {
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(searcher);
        vm.expectRevert(abi.encodeWithSelector(BallastManagerV2.NotKeeper.selector, searcher, trigger));
        ballast.protect(BORROWER, MARKET_ID);
    }

    function testSearcherCannotCallProtectForEither() public {
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(searcher);
        vm.expectRevert(abi.encodeWithSelector(BallastManagerV2.NotKeeper.selector, searcher, trigger));
        ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, POLICY_SLIPPAGE_BPS);
    }

    function testNamedKeeperCanAct() public {
        _enroll(trigger);
        _dropPrice(1000);

        uint256 healthBefore = ballast.healthOf(BORROWER, MARKET_ID);
        vm.prank(trigger);
        (uint256 repaid, uint256 sold) = ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, POLICY_SLIPPAGE_BPS);
        uint256 healthAfter = ballast.healthOf(BORROWER, MARKET_ID);

        console2.log("health before :", healthBefore);
        console2.log("health after  :", healthAfter);
        console2.log("repaid (USD0) :", repaid / 1e6);
        console2.log("sold  (FXRP)  :", sold / 1e6);

        assertLt(healthBefore, PUBLIC_BOUND);
        assertGt(healthAfter, healthBefore, "keeper action must improve health");
        assertGt(repaid, 0);
    }

    /// @dev With no keeper named, v2 keeps v1's permissionless behaviour.
    function testProtectStaysPermissionlessWhenNoKeeperIsSet() public {
        _enroll(address(0));
        _dropPrice(1000);

        uint256 healthBefore = ballast.healthOf(BORROWER, MARKET_ID);
        vm.prank(searcher);
        ballast.protect(BORROWER, MARKET_ID);
        assertGt(ballast.healthOf(BORROWER, MARKET_ID), healthBefore);
    }

    // ------------------------------------------------------------------ clamp

    /// @dev The safety invariant. A verdict asking to restore health to 3.0 would sell far more
    ///      collateral than the borrower agreed to; the policy target must win.
    function testGreedyTargetIsClampedToThePolicy() public {
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(trigger);
        (uint256 repaidGreedy,) = ballast.protectFor(BORROWER, MARKET_ID, 3e18, POLICY_SLIPPAGE_BPS);

        // Re-run from a clean fork asking for exactly the policy target.
        setUp();
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(trigger);
        (uint256 repaidHonest,) = ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, POLICY_SLIPPAGE_BPS);

        assertEq(repaidGreedy, repaidHonest, "a greedy target must buy the keeper nothing");
    }

    /// @dev Likewise for slippage: widening the bound would let a keeper dump collateral into a
    ///      thin pool and pocket the difference through a venue they control.
    function testWideSlippageIsClampedToThePolicy() public {
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(trigger);
        (uint256 repaidWide,) = ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, 9_000);

        setUp();
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(trigger);
        (uint256 repaidBounded,) = ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, POLICY_SLIPPAGE_BPS);

        assertEq(repaidWide, repaidBounded, "a wide slippage bound must buy the keeper nothing");
    }

    /// @dev Asking for *less* than the policy allows is permitted: acting more conservatively
    ///      than authorised is always safe, and the enclave may well want to.
    function testConservativeTargetIsHonoured() public {
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(trigger);
        (uint256 repaidSmall,) = ballast.protectFor(BORROWER, MARKET_ID, 1.15e18, POLICY_SLIPPAGE_BPS);

        setUp();
        _enroll(trigger);
        _dropPrice(1000);

        vm.prank(trigger);
        (uint256 repaidFull,) = ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, POLICY_SLIPPAGE_BPS);

        assertLt(repaidSmall, repaidFull, "a lower target should repay less");
        assertGt(repaidSmall, 0);
    }

    /// @dev The outer bound is still enforced for the keeper. The enclave owns the secret
    ///      trigger somewhere below it, but cannot act on a position that is plainly healthy.
    function testKeeperCannotActAboveThePublicBound() public {
        _enroll(trigger);
        // No price drop: the position sits comfortably above the bound.
        uint256 health = ballast.healthOf(BORROWER, MARKET_ID);
        assertGt(health, PUBLIC_BOUND);

        // `protectFor` accrues interest first, which moves health by a few wei, so match the
        // selector rather than the exact arguments.
        vm.prank(trigger);
        vm.expectPartialRevert(BallastManagerV2.NotAtRisk.selector);
        ballast.protectFor(BORROWER, MARKET_ID, POLICY_TARGET, POLICY_SLIPPAGE_BPS);
    }
}
