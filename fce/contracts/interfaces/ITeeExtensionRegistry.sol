// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ITeeExtensionRegistry {
    struct TeeInstructionParams {
        bytes32 opType;
        bytes32 opCommand;
        bytes message;
        address[] cosigners;
        uint64 cosignersThreshold;
        address claimBackAddress;
    }

    function nextPublicExtensionId() external view returns (uint256);
    function getTeeExtensionInstructionsSender(uint256 extensionId) external view returns (address);
    function sendInstructions(address[] memory teeIds, TeeInstructionParams memory params) external payable;
}
