// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";
import {TeeResultHash} from "./libraries/TeeResultHash.sol";
import {Id} from "./interfaces/IMorpho.sol";

/// @notice What Ballast needs from a protection manager for the confidential path to work.
/// @dev BallastManager v1 (live at 0x379e5B8Cf31fC5D46aEc2fc17F17708951015571) does NOT
///      implement this: its `protect()` is permissionless and gated by a public
///      `triggerHealth`, so a searcher could bypass the enclave entirely by calling it
///      directly. The confidential path therefore requires a manager whose policy names a
///      single permitted caller. v1 stays live and untouched.
interface IGatedProtect {
    function protectFor(address borrower, Id id, uint128 targetHealth, uint32 maxSlippageBps, address feeRecipient)
        external
        returns (uint256 repaid, uint256 collateralSold);
}

/// @title ConfidentialTrigger
/// @notice Lets a borrower keep their liquidation trigger secret while still being protected.
///
/// @dev **The problem.** Ballast v1 stores `Policy.triggerHealth` in public storage. Anyone can
///      read every protected position's exact trip wire, which is precisely the information a
///      searcher wants: push the oracle to just above someone's trigger and you know no
///      protective bid will appear, or push it just below and you know one will.
///
///      **The shape of the fix.** On-chain we keep only `keccak256(trigger, target, salt)`.
///      The plaintext lives in the enclave. Because instructions reach the enclave through a
///      public `TeeInstructionsSent` event, the borrower encrypts the plaintext to the
///      machine's key from `ITeeMachineRegistry.getPublicKey` before sending it; the event
///      carries ciphertext only.
///
///      **Why a signature is enough.** Flare's machine registry answers, on-chain, both
///      "which extension does this machine run" and "is it in PRODUCTION". So recovering a
///      verdict's signer and checking it against the registry proves the verdict came from
///      attested code, without this contract ever learning the trigger.
///
///      **Determinism.** Every verdict pins the block it was evaluated at. Machines that
///      evaluate at different chain heights would otherwise produce different result bytes,
///      and the TEE stack requires result data to be byte-exact.
contract ConfidentialTrigger {
    /// @dev Machine lifecycle status meaning "attested and serving".
    uint8 internal constant STATUS_PRODUCTION = 2;

    /// @notice How stale a pinned evaluation block may be before a verdict is refused.
    /// @dev Flare targets ~1.8s blocks, so this is roughly three minutes. Long enough for a
    ///      keeper round trip through the proxy, short enough that the price the enclave
    ///      judged on is still close to the price the swap will get.
    uint256 public constant MAX_EVALUATION_AGE_BLOCKS = 100;

    ITeeMachineRegistry public immutable TEE_REGISTRY;
    IGatedProtect public immutable BALLAST;

    /// @notice The extension ID whose machines are trusted to sign verdicts.
    /// @dev Assigned by `ExtensionManagerFacet.register`; public extensions start at 0x10000.
    uint256 public immutable EXTENSION_ID;

    /// @notice keccak256(triggerHealth, targetHealth, salt), per borrower per market.
    mapping(address => mapping(Id => bytes32)) public commitmentOf;

    /// @notice Consumed verdict digests, so a keeper cannot replay a favourable verdict.
    mapping(bytes32 => bool) public verdictUsed;

    /// @notice The parts of the TEE's result envelope that the signature commits to.
    /// @dev These are not Ballast's data, they belong to the tee-node protocol, but they are
    ///      inside the signed preimage so the contract has to be given them to recover.
    struct TeeEnvelope {
        bytes32 actionId;
        string submissionTag;
        uint8 status;
    }

    /// @notice A signed instruction from the enclave to act on a position.
    /// @dev `targetHealth` and the bounds are revealed only here, at the moment of action.
    ///      Until a verdict fires, an observer sees a commitment and nothing else.
    struct Verdict {
        address borrower;
        Id id;
        bytes32 commitment;
        uint128 targetHealth;
        uint32 maxSlippageBps;
        uint64 evaluatedAtBlock;
    }

    event Committed(address indexed borrower, Id indexed id, bytes32 commitment);
    event CommitmentCleared(address indexed borrower, Id indexed id);
    event VerdictExecuted(
        address indexed borrower, Id indexed id, address indexed teeId, uint256 repaid, uint256 collateralSold
    );

    error NotAttestedMachine(address signer);
    error MachineNotInProduction(address signer, uint8 status);
    error WrongExtension(address signer, uint256 extensionId);
    error CommitmentMismatch(bytes32 expected, bytes32 got);
    error NoCommitment(address borrower);
    error VerdictAlreadyUsed(bytes32 verdictId);
    error EvaluationTooOld(uint256 evaluatedAtBlock, uint256 currentBlock);
    error EvaluationInFuture(uint256 evaluatedAtBlock, uint256 currentBlock);
    error BadSignature();
    error HandlerFailed(bytes32 actionId);
    error ResultNotFinal(bytes32 actionId, uint8 status);

    constructor(address teeRegistry, address ballast, uint256 extensionId) {
        TEE_REGISTRY = ITeeMachineRegistry(teeRegistry);
        BALLAST = IGatedProtect(ballast);
        EXTENSION_ID = extensionId;
    }

    // ------------------------------------------------------------- commitment

    /// @notice Publish the hash of your trigger. The trigger itself goes to the enclave.
    /// @param commitment `keccak256(abi.encode(triggerHealth, targetHealth, salt))`.
    /// @dev The salt matters. Without it, trigger levels come from a small set of round
    ///      numbers and the commitment would fall to a dictionary attack in milliseconds.
    function commit(Id id, bytes32 commitment) external {
        commitmentOf[msg.sender][id] = commitment;
        emit Committed(msg.sender, id, commitment);
    }

    function clearCommitment(Id id) external {
        delete commitmentOf[msg.sender][id];
        emit CommitmentCleared(msg.sender, id);
    }

    // ---------------------------------------------------------------- execute

    /// @notice Act on a position because the enclave says its secret trigger was crossed.
    /// @dev Permissionless to call, but useless to forge: the verdict must carry a signature
    ///      from a machine the Flare registry says is running our extension in production.
    function execute(Verdict calldata v, TeeEnvelope calldata env, bytes calldata signature)
        external
        returns (uint256 repaid, uint256 collateralSold)
    {
        if (env.status == 0) revert HandlerFailed(env.actionId);
        if (env.status != 1) revert ResultNotFinal(env.actionId, env.status);

        bytes32 stored = commitmentOf[v.borrower][v.id];
        if (stored == bytes32(0)) revert NoCommitment(v.borrower);
        if (stored != v.commitment) revert CommitmentMismatch(stored, v.commitment);

        if (v.evaluatedAtBlock > block.number) {
            revert EvaluationInFuture(v.evaluatedAtBlock, block.number);
        }
        if (block.number - v.evaluatedAtBlock > MAX_EVALUATION_AGE_BLOCKS) {
            revert EvaluationTooOld(v.evaluatedAtBlock, block.number);
        }

        // The enclave's result payload is the verdict itself, ABI-encoded. `block.chainid`
        // binds the signature to this chain, which is the whole point of the domain separator.
        bytes32 digest = TeeResultHash.digest(abi.encode(v), env.actionId, env.submissionTag, env.status, block.chainid);

        if (verdictUsed[digest]) revert VerdictAlreadyUsed(digest);
        verdictUsed[digest] = true;

        address teeId = _recoverAttestedMachine(digest, signature);

        (repaid, collateralSold) = BALLAST.protectFor(v.borrower, v.id, v.targetHealth, v.maxSlippageBps, msg.sender);
        emit VerdictExecuted(v.borrower, v.id, teeId, repaid, collateralSold);
    }

    // ------------------------------------------------------------------ views

    /// @notice Recompute a commitment, so a borrower can check theirs before publishing it.
    function commitmentFor(uint128 triggerHealth, uint128 targetHealth, bytes32 salt) external pure returns (bytes32) {
        return keccak256(abi.encode(triggerHealth, targetHealth, salt));
    }

    /// @notice Whether `teeId` is currently trusted to sign verdicts for this contract.
    function isTrustedMachine(address teeId) public view returns (bool) {
        return TEE_REGISTRY.getExtensionId(teeId) == EXTENSION_ID
            && TEE_REGISTRY.getTeeMachineStatus(teeId) == STATUS_PRODUCTION;
    }

    /// @notice The machines that can currently produce verdicts, and where to reach them.
    function activeMachines() external view returns (address[] memory teeIds, string[] memory urls) {
        return TEE_REGISTRY.getActiveTeeMachines(EXTENSION_ID);
    }

    // --------------------------------------------------------------- internal

    function _recoverAttestedMachine(bytes32 digest, bytes calldata signature) internal view returns (address) {
        address signer = _recover(digest, signature);

        uint256 ext = TEE_REGISTRY.getExtensionId(signer);
        if (ext == 0) revert NotAttestedMachine(signer);
        if (ext != EXTENSION_ID) revert WrongExtension(signer, ext);

        uint8 status = TEE_REGISTRY.getTeeMachineStatus(signer);
        if (status != STATUS_PRODUCTION) revert MachineNotInProduction(signer, status);

        return signer;
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address) {
        if (signature.length != 65) revert BadSignature();

        bytes32 r;
        bytes32 s;
        uint8 vv;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            vv := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (vv < 27) vv += 27;

        // Reject the malleable upper half of the curve order.
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }

        address signer = ecrecover(digest, vv, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
