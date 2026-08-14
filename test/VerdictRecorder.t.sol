// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {VerdictRecorder} from "../src/VerdictRecorder.sol";
import {Id} from "../src/interfaces/IMorpho.sol";

contract RecorderTrigger {
    function record(VerdictRecorder recorder, address borrower, Id id, uint128 targetHealth, uint32 maxSlippageBps)
        external
    {
        recorder.protectFor(borrower, id, targetHealth, maxSlippageBps, address(0));
    }
}

contract VerdictRecorderTest is Test {
    Id internal constant MARKET_ID = Id.wrap(keccak256("market"));

    address internal initializer = makeAddr("initializer");
    address internal borrower = makeAddr("borrower");
    address internal stranger = makeAddr("stranger");
    VerdictRecorder internal recorder;
    RecorderTrigger internal trigger;

    function setUp() public {
        vm.prank(initializer);
        recorder = new VerdictRecorder();
        trigger = new RecorderTrigger();
    }

    function testOnlyInitializerCanSetTrigger() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(VerdictRecorder.OnlyInitializer.selector, stranger));
        recorder.setTrigger(address(trigger));

        vm.prank(initializer);
        recorder.setTrigger(address(trigger));

        assertEq(recorder.trigger(), address(trigger));
    }

    function testTriggerMustBeADeployedContract() public {
        vm.startPrank(initializer);
        vm.expectRevert(abi.encodeWithSelector(VerdictRecorder.InvalidTrigger.selector, address(0)));
        recorder.setTrigger(address(0));
        vm.expectRevert(abi.encodeWithSelector(VerdictRecorder.InvalidTrigger.selector, stranger));
        recorder.setTrigger(stranger);
        vm.stopPrank();
    }

    function testTriggerCanOnlyBeSetOnce() public {
        RecorderTrigger replacement = new RecorderTrigger();
        vm.startPrank(initializer);
        recorder.setTrigger(address(trigger));
        vm.expectRevert(VerdictRecorder.TriggerAlreadySet.selector);
        recorder.setTrigger(address(replacement));
        vm.stopPrank();
    }

    function testConfiguredTriggerRecordsVerdict() public {
        vm.prank(initializer);
        recorder.setTrigger(address(trigger));

        trigger.record(recorder, borrower, MARKET_ID, 1.3e18, 100);

        assertEq(recorder.recordCount(), 1);
        (address recordedBorrower, Id recordedId, uint128 targetHealth, uint32 maxSlippageBps,, address caller) =
            recorder.records(0);
        assertEq(recordedBorrower, borrower);
        assertEq(Id.unwrap(recordedId), Id.unwrap(MARKET_ID));
        assertEq(targetHealth, 1.3e18);
        assertEq(maxSlippageBps, 100);
        assertEq(caller, address(trigger));
    }
}
