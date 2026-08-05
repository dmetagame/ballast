// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ConfidentialTrigger, IGatedProtect} from "../src/ConfidentialTrigger.sol";
import {ITeeMachineRegistry} from "../src/interfaces/ITeeMachineRegistry.sol";
import {Id} from "../src/interfaces/IMorpho.sol";

/// @dev Stands in for Flare's `MachineManagerFacet`. Only the three reads Ballast makes.
contract MockTeeRegistry is ITeeMachineRegistry {
    mapping(address => uint256) public ext;
    mapping(address => uint8) public status;

    function set(address teeId, uint256 extensionId, uint8 s) external {
        ext[teeId] = extensionId;
        status[teeId] = s;
    }

    function getExtensionId(address teeId) external view returns (uint256) {
        return ext[teeId];
    }

    function getTeeMachineStatus(address teeId) external view returns (uint8) {
        return status[teeId];
    }

    function getActiveTeeMachines(uint256) external pure returns (address[] memory, string[] memory) {
        return (new address[](0), new string[](0));
    }

    function getPublicKey(address) external pure returns (PublicKey memory) {
        return PublicKey({x: bytes32(0), y: bytes32(0)});
    }
}

contract MockGatedBallast is IGatedProtect {
    uint256 public calls;
    address public lastBorrower;
    uint128 public lastTarget;

    function protectFor(address borrower, Id, uint128 targetHealth, uint32) external returns (uint256, uint256) {
        calls++;
        lastBorrower = borrower;
        lastTarget = targetHealth;
        return (1234, 5678);
    }
}

contract ConfidentialTriggerTest is Test {
    uint256 constant EXTENSION_ID = 0x10001;

    ConfidentialTrigger trigger;
    MockTeeRegistry registry;
    MockGatedBallast ballast;

    uint256 teeKey = 0xA11CE;
    address teeId;

    uint256 rogueKey = 0xBAD;
    address rogueId;

    address borrower = address(0xB0B);
    Id constant MARKET = Id.wrap(bytes32(uint256(1)));

    uint128 constant TRIGGER_HEALTH = 1.05e18;
    uint128 constant TARGET_HEALTH = 1.35e18;
    bytes32 constant SALT = bytes32(uint256(0xDEADBEEF));

    function setUp() public {
        teeId = vm.addr(teeKey);
        rogueId = vm.addr(rogueKey);

        registry = new MockTeeRegistry();
        ballast = new MockGatedBallast();
        trigger = new ConfidentialTrigger(address(registry), address(ballast), EXTENSION_ID);

        // A machine attested as running our extension, in PRODUCTION.
        registry.set(teeId, EXTENSION_ID, 2);

        vm.prank(borrower);
        trigger.commit(MARKET, _commitment());

        vm.roll(1_000);
    }

    function _commitment() internal pure returns (bytes32) {
        return keccak256(abi.encode(TRIGGER_HEALTH, TARGET_HEALTH, SALT));
    }

    function _verdict() internal view returns (ConfidentialTrigger.Verdict memory) {
        return ConfidentialTrigger.Verdict({
            borrower: borrower,
            id: MARKET,
            commitment: _commitment(),
            targetHealth: TARGET_HEALTH,
            maxSlippageBps: 100,
            evaluatedAtBlock: uint64(block.number),
            salt: SALT
        });
    }

    function _sign(ConfidentialTrigger.Verdict memory v, uint256 key) internal pure returns (bytes memory) {
        bytes32 digest = keccak256(abi.encode(v));
        (uint8 sv, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, sv);
    }

    // ------------------------------------------------------------------ tests

    function testCommitmentHidesTheTrigger() public view {
        // The only thing on-chain is a hash. Recomputing it needs the salt.
        bytes32 stored = trigger.commitmentOf(borrower, MARKET);
        assertEq(stored, _commitment());
        assertTrue(stored != bytes32(uint256(TRIGGER_HEALTH)));
        assertEq(trigger.commitmentFor(TRIGGER_HEALTH, TARGET_HEALTH, SALT), stored);
    }

    function testAttestedMachineVerdictExecutes() public {
        ConfidentialTrigger.Verdict memory v = _verdict();
        (uint256 repaid, uint256 sold) = trigger.execute(v, _sign(v, teeKey));

        assertEq(repaid, 1234);
        assertEq(sold, 5678);
        assertEq(ballast.calls(), 1);
        assertEq(ballast.lastBorrower(), borrower);
        assertEq(ballast.lastTarget(), TARGET_HEALTH);
    }

    function testUnregisteredSignerIsRejected() public {
        ConfidentialTrigger.Verdict memory v = _verdict();
        vm.expectRevert(abi.encodeWithSelector(ConfidentialTrigger.NotAttestedMachine.selector, rogueId));
        trigger.execute(v, _sign(v, rogueKey));
    }

    function testMachineFromAnotherExtensionIsRejected() public {
        registry.set(rogueId, 0x10002, 2);
        ConfidentialTrigger.Verdict memory v = _verdict();
        vm.expectRevert(abi.encodeWithSelector(ConfidentialTrigger.WrongExtension.selector, rogueId, 0x10002));
        trigger.execute(v, _sign(v, rogueKey));
    }

    function testMachineNotYetInProductionIsRejected() public {
        // status 1 = INITIALIZED: registered, attested, but not serving.
        registry.set(rogueId, EXTENSION_ID, 1);
        ConfidentialTrigger.Verdict memory v = _verdict();
        vm.expectRevert(abi.encodeWithSelector(ConfidentialTrigger.MachineNotInProduction.selector, rogueId, 1));
        trigger.execute(v, _sign(v, rogueKey));
    }

    function testTamperedTargetBreaksTheSignature() public {
        ConfidentialTrigger.Verdict memory v = _verdict();
        bytes memory sig = _sign(v, teeKey);

        // A keeper raising the target to sell more collateral than the enclave decided.
        v.targetHealth = 2e18;
        vm.expectRevert(abi.encodeWithSelector(ConfidentialTrigger.NotAttestedMachine.selector, _wrongSigner(v, sig)));
        trigger.execute(v, sig);
    }

    function testVerdictCannotBeReplayed() public {
        ConfidentialTrigger.Verdict memory v = _verdict();
        bytes memory sig = _sign(v, teeKey);
        trigger.execute(v, sig);

        bytes32 verdictId = keccak256(abi.encode(v));
        vm.expectRevert(abi.encodeWithSelector(ConfidentialTrigger.VerdictAlreadyUsed.selector, verdictId));
        trigger.execute(v, sig);
    }

    function testStaleEvaluationIsRejected() public {
        ConfidentialTrigger.Verdict memory v = _verdict();
        bytes memory sig = _sign(v, teeKey);

        vm.roll(block.number + trigger.MAX_EVALUATION_AGE_BLOCKS() + 1);
        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialTrigger.EvaluationTooOld.selector, v.evaluatedAtBlock, block.number)
        );
        trigger.execute(v, sig);
    }

    function testVerdictForUncommittedPositionIsRejected() public {
        Id other = Id.wrap(bytes32(uint256(99)));
        ConfidentialTrigger.Verdict memory v = _verdict();
        v.id = other;

        vm.expectRevert(abi.encodeWithSelector(ConfidentialTrigger.NoCommitment.selector, borrower));
        trigger.execute(v, _sign(v, teeKey));
    }

    function testCommitmentMismatchIsRejected() public {
        ConfidentialTrigger.Verdict memory v = _verdict();
        v.commitment = keccak256("not the committed policy");

        vm.expectRevert(
            abi.encodeWithSelector(ConfidentialTrigger.CommitmentMismatch.selector, _commitment(), v.commitment)
        );
        trigger.execute(v, _sign(v, teeKey));
    }

    /// @dev Recovers whatever address a tampered verdict resolves to, so the expected revert
    ///      can name it. Tampering changes the digest, so ecrecover yields a junk address.
    function _wrongSigner(ConfidentialTrigger.Verdict memory v, bytes memory sig) internal pure returns (address) {
        bytes32 digest = keccak256(abi.encode(v));
        bytes32 r;
        bytes32 s;
        uint8 sv;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            sv := byte(0, mload(add(sig, 96)))
        }
        return ecrecover(digest, sv, r, s);
    }
}
