// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {SparkDexAdapterV2} from "../src/adapters/SparkDexAdapterV2.sol";

contract MockPoolCode {
    function token0() external pure returns (address) { return address(1); }
}

contract SparkDexAdapterV2Test is Test {
    uint256 internal constant DELAY = 2 days;
    address internal owner = makeAddr("owner");
    address internal nextOwner = makeAddr("nextOwner");
    address internal tokenIn = makeAddr("tokenIn");
    address internal tokenOut = makeAddr("tokenOut");
    SparkDexAdapterV2 internal adapter;
    MockPoolCode internal pool;

    function setUp() public {
        vm.prank(owner);
        adapter = new SparkDexAdapterV2(DELAY);
        pool = new MockPoolCode();
    }

    function testPoolChangeRequiresDelay() public {
        vm.prank(owner);
        adapter.proposePool(tokenIn, tokenOut, address(pool));

        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(SparkDexAdapterV2.TimelockNotReady.selector, block.timestamp + DELAY));
        adapter.acceptPool(tokenIn, tokenOut);

        vm.warp(block.timestamp + DELAY);
        vm.prank(owner);
        adapter.acceptPool(tokenIn, tokenOut);
        assertEq(adapter.poolFor(keccak256(abi.encodePacked(tokenIn, tokenOut))), address(pool));
    }

    function testOwnershipRequiresDelayAndAcceptance() public {
        vm.prank(owner);
        adapter.proposeOwnership(nextOwner);

        vm.prank(nextOwner);
        vm.expectRevert(abi.encodeWithSelector(SparkDexAdapterV2.TimelockNotReady.selector, block.timestamp + DELAY));
        adapter.acceptOwnership();

        vm.warp(block.timestamp + DELAY);
        vm.prank(nextOwner);
        adapter.acceptOwnership();
        assertEq(adapter.owner(), nextOwner);
    }

    function testManagerIsSetOnce() public {
        vm.prank(owner);
        adapter.setManager(address(pool));
        vm.prank(owner);
        vm.expectRevert(SparkDexAdapterV2.ManagerAlreadySet.selector);
        adapter.setManager(address(pool));
    }
}
