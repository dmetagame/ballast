// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice The subset of Flare's `MachineManagerFacet` that Ballast needs.
///
/// @dev `FlareTeeManager` is an EIP-2535 diamond, so these selectors are served by a facet
///      rather than by code at the diamond address. Do not try to detect support by grepping
///      the diamond's bytecode: it holds only a 184-byte fallback. Enumerate with
///      `facets()` instead.
///
///      Live on Coston2 at `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`. Note the
///      scaffold's checked-in `config/coston2/deployed-addresses.json` lists stale facet
///      addresses; the diamond is the authority.
interface ITeeMachineRegistry {
    /// @notice Which extension a TEE machine is registered to run.
    /// @dev This is the load-bearing check. A signature is only meaningful if the signer is a
    ///      machine running *our* attested extension code, not merely some machine Flare knows.
    function getExtensionId(address teeId) external view returns (uint256);

    /// @notice Lifecycle status of a machine. 1 = INITIALIZED, 2 = PRODUCTION.
    function getTeeMachineStatus(address teeId) external view returns (uint8);

    /// @notice Machines currently able to serve an extension, with their proxy URLs.
    function getActiveTeeMachines(uint256 extensionId)
        external
        view
        returns (address[] memory teeIds, string[] memory urls);

    /// @notice The machine's EC public key, as an uncompressed point.
    /// @dev Borrowers encrypt their secret trigger to this key so the plaintext never appears
    ///      in the public `TeeInstructionsSent` event that carries it to the enclave.
    function getPublicKey(address teeId) external view returns (PublicKey memory);

    struct PublicKey {
        bytes32 x;
        bytes32 y;
    }
}
