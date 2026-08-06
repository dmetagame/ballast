// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

interface ITeeMachineRegistry {
    function getExtensionId(address teeId) external view returns (uint256);
    function getTeeMachineStatus(address teeId) external view returns (uint8);

    function getPublicKey(address teeId) external view returns (PublicKey memory);

    struct PublicKey {
        bytes32 x;
        bytes32 y;
    }
}
