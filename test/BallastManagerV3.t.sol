// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BallastManagerV3} from "../src/BallastManagerV3.sol";
import {Id} from "../src/interfaces/IMorpho.sol";
import {MockSwapAdapter} from "./mocks/MockSwapAdapter.sol";

contract BallastManagerV3Test is Test {
    uint256 internal constant ADMIN_DELAY = 2 days;
    Id internal constant MARKET_ID = Id.wrap(keccak256("market"));

    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal borrower = makeAddr("borrower");
    address internal nextOwner = makeAddr("nextOwner");
    address internal morpho = makeAddr("morpho");
    address internal oracle = makeAddr("oracle");

    BallastManagerV3 internal ballast;
    MockSwapAdapter internal adapter;

    function setUp() public {
        adapter = new MockSwapAdapter(oracle, 30);
        vm.prank(owner);
        ballast = new BallastManagerV3(morpho, address(adapter), guardian, ADMIN_DELAY);
    }

    function testAdapterUpdateRequiresDelay() public {
        MockSwapAdapter replacement = new MockSwapAdapter(oracle, 20);

        vm.prank(owner);
        ballast.proposeSwapAdapter(address(replacement));

        assertEq(address(ballast.swapAdapter()), address(adapter));
        assertEq(address(ballast.pendingSwapAdapter()), address(replacement));

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(BallastManagerV3.TimelockNotReady.selector, block.timestamp + ADMIN_DELAY)
        );
        ballast.acceptSwapAdapter();

        vm.warp(block.timestamp + ADMIN_DELAY);
        vm.prank(owner);
        ballast.acceptSwapAdapter();

        assertEq(address(ballast.swapAdapter()), address(replacement));
        assertEq(address(ballast.pendingSwapAdapter()), address(0));
    }

    function testAdapterUpdateCanBeCancelled() public {
        MockSwapAdapter replacement = new MockSwapAdapter(oracle, 20);

        vm.startPrank(owner);
        ballast.proposeSwapAdapter(address(replacement));
        ballast.cancelSwapAdapter();
        vm.stopPrank();

        vm.warp(block.timestamp + ADMIN_DELAY);
        vm.prank(owner);
        vm.expectRevert(BallastManagerV3.NoPendingUpdate.selector);
        ballast.acceptSwapAdapter();
        assertEq(address(ballast.swapAdapter()), address(adapter));
    }

    function testOwnershipTransferRequiresDelayAndRecipientAcceptance() public {
        vm.prank(owner);
        ballast.proposeOwnership(nextOwner);

        vm.prank(nextOwner);
        vm.expectRevert(
            abi.encodeWithSelector(BallastManagerV3.TimelockNotReady.selector, block.timestamp + ADMIN_DELAY)
        );
        ballast.acceptOwnership();

        vm.warp(block.timestamp + ADMIN_DELAY);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(BallastManagerV3.NotOwner.selector);
        ballast.acceptOwnership();

        vm.prank(nextOwner);
        ballast.acceptOwnership();
        assertEq(ballast.owner(), nextOwner);
        assertEq(ballast.pendingOwner(), address(0));
    }

    function testGuardianPauseBlocksProtectButNotBorrowerPolicyChanges() public {
        vm.prank(borrower);
        ballast.setPolicy(MARKET_ID, 1.1e18, 1.3e18, 1_000e6, 100, 25, 0, address(0));

        vm.prank(guardian);
        ballast.pause();

        vm.expectRevert(BallastManagerV3.Paused.selector);
        ballast.protect(borrower, MARKET_ID);

        vm.prank(borrower);
        ballast.setPolicy(MARKET_ID, 1.12e18, 1.35e18, 500e6, 75, 10, 60, address(0));
        BallastManagerV3.Policy memory policy = ballast.policyOf(borrower, MARKET_ID);
        assertTrue(policy.enabled);
        assertEq(policy.triggerHealth, 1.12e18);

        vm.prank(borrower);
        ballast.disablePolicy(MARKET_ID);
        policy = ballast.policyOf(borrower, MARKET_ID);
        assertFalse(policy.enabled);
    }

    function testOnlyGuardianCanPauseAndOnlyOwnerCanUnpause() public {
        vm.expectRevert(BallastManagerV3.NotGuardian.selector);
        ballast.pause();

        vm.prank(guardian);
        ballast.pause();

        vm.prank(guardian);
        vm.expectRevert(BallastManagerV3.NotOwner.selector);
        ballast.unpause();

        vm.prank(owner);
        ballast.unpause();
        assertFalse(ballast.paused());
    }

    function testCannotOverwritePendingAdminActions() public {
        MockSwapAdapter first = new MockSwapAdapter(oracle, 20);
        MockSwapAdapter second = new MockSwapAdapter(oracle, 10);

        vm.startPrank(owner);
        ballast.proposeSwapAdapter(address(first));
        vm.expectRevert(BallastManagerV3.TimelockPending.selector);
        ballast.proposeSwapAdapter(address(second));

        ballast.proposeOwnership(nextOwner);
        vm.expectRevert(BallastManagerV3.TimelockPending.selector);
        ballast.proposeOwnership(makeAddr("anotherOwner"));
        vm.stopPrank();
    }
}
