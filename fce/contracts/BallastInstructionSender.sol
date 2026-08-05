// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import {ITeeExtensionRegistry} from "./interfaces/ITeeExtensionRegistry.sol";
import {ITeeMachineRegistry} from "./interfaces/ITeeMachineRegistry.sol";

/// @title BallastInstructionSender
/// @notice The only on-chain address allowed to send instructions to the Ballast extension.
///
/// @dev The registry enforces this: an extension is registered with one sender address, and
///      `sendInstructions` reverts for any other caller. No EOA, no other contract.
///
///      **Everything passed through here is public.** These calls emit `TeeInstructionsSent`,
///      and the message is readable in the event data forever. That is why `enroll` takes a
///      ciphertext rather than a policy: the borrower encrypts their trigger to the machine
///      key from `getPublicKey` before calling, and the plaintext never touches the chain.
///      Passing a policy in the clear here would defeat the entire design, so there is
///      deliberately no function that accepts one.
contract BallastInstructionSender {
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_TYPE_BALLAST = bytes32("BALLAST");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_ENROLL = bytes32("ENROLL");
    // forge-lint: disable-next-line(unsafe-typecast)
    bytes32 public constant OP_COMMAND_EVALUATE = bytes32("EVALUATE");

    ITeeExtensionRegistry public immutable TEE_EXTENSION_REGISTRY;
    ITeeMachineRegistry public immutable TEE_MACHINE_REGISTRY;

    uint256 private constant FIRST_PUBLIC_EXTENSION_ID = 0x10000;
    uint256 private _extensionId;

    /// @notice Carries a borrower's encrypted policy to the enclave.
    /// @dev `commitment` travels in the clear on purpose so the enclave can check the plaintext
    ///      it decrypts is the policy the borrower published on `ConfidentialTrigger`.
    struct EnrollMessage {
        address borrower;
        bytes32 marketId;
        bytes32 commitment;
        bytes ciphertext;
    }

    /// @notice Asks the enclave whether a position has crossed its secret trigger.
    /// @dev `blockNumber` pins the height every machine reads at, so machines serving the same
    ///      request produce identical result bytes. Without it their signatures disagree.
    struct EvaluateMessage {
        address borrower;
        bytes32 marketId;
        uint64 blockNumber;
    }

    error CiphertextRequired();
    error BlockInFuture(uint64 requested, uint256 current);

    constructor(ITeeExtensionRegistry _extensionRegistry, ITeeMachineRegistry _machineRegistry) {
        require(address(_extensionRegistry).code.length > 0, "TeeExtensionRegistry has no code");
        require(address(_machineRegistry).code.length > 0, "TeeMachineRegistry has no code");
        TEE_EXTENSION_REGISTRY = _extensionRegistry;
        TEE_MACHINE_REGISTRY = _machineRegistry;
    }

    /// @notice Finds and caches this contract's extension id. Settable once.
    /// @dev Boilerplate required by the scaffold; do not modify.
    function setExtensionId() external {
        require(_extensionId == 0, "Extension ID already set.");
        uint256 c = TEE_EXTENSION_REGISTRY.nextPublicExtensionId();
        for (uint256 i = FIRST_PUBLIC_EXTENSION_ID; i < c; ++i) {
            if (TEE_EXTENSION_REGISTRY.getTeeExtensionInstructionsSender(i) == address(this)) {
                _extensionId = i;
                return;
            }
        }
        revert("Extension ID not found.");
    }

    /// @notice Enroll a position by handing the enclave an encrypted policy.
    function enroll(bytes32 marketId, bytes32 commitment, bytes calldata ciphertext) external payable {
        if (ciphertext.length == 0) revert CiphertextRequired();
        _send(
            OP_COMMAND_ENROLL,
            abi.encode(
                EnrollMessage({
                    borrower: msg.sender,
                    marketId: marketId,
                    commitment: commitment,
                    ciphertext: ciphertext
                })
            )
        );
    }

    /// @notice Ask the enclave to evaluate a position at a specific block.
    /// @dev Permissionless. A keeper calls this; the enclave answers only for positions that
    ///      enrolled, and reveals nothing when no action is warranted.
    function evaluate(address borrower, bytes32 marketId, uint64 blockNumber) external payable {
        if (blockNumber > block.number) revert BlockInFuture(blockNumber, block.number);
        _send(
            OP_COMMAND_EVALUATE,
            abi.encode(EvaluateMessage({borrower: borrower, marketId: marketId, blockNumber: blockNumber}))
        );
    }

    function _send(bytes32 opCommand, bytes memory message) internal {
        address[] memory teeIds = TEE_MACHINE_REGISTRY.getRandomTeeIds(_getExtensionId(), 1);

        ITeeExtensionRegistry.TeeInstructionParams memory params = ITeeExtensionRegistry.TeeInstructionParams({
            opType: OP_TYPE_BALLAST,
            opCommand: opCommand,
            message: message,
            cosigners: new address[](0),
            cosignersThreshold: 0,
            claimBackAddress: msg.sender
        });

        TEE_EXTENSION_REGISTRY.sendInstructions{value: msg.value}(teeIds, params);
    }

    function _getExtensionId() internal view returns (uint256) {
        require(_extensionId != 0, "Extension ID is not set.");
        return _extensionId;
    }
}
