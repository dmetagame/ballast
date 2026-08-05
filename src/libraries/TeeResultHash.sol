// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title TeeResultHash
/// @notice Reproduces on-chain the digest a Flare TEE machine signs over an action result.
///
/// @dev There are **three** keccak rounds here and it is easy to stop after one. Derived from
///      tee-node and go-flare-common rather than from prose, and pinned by a fixture generated
///      by running Flare's own Go code (see `test/TeeResultHash.t.sol`).
///
///      1. `tee-node/pkg/types.ActionResult.Hash()`
///             dataHash = keccak256( keccak256(data) ‖ id ‖ keccak256(submissionTag) ‖ status )
///      2. `go-flare-common/pkg/signing.Payload.Hash()`, which domain-separates by prefix and
///         chain so a signature for one purpose or one chain cannot be replayed into another
///             signHash = keccak256( abi.encode(prefix, chainId, dataHash) )
///      3. `tee-node/pkg/wallets.signKeccak256Secp256k1ECDSA`, which hashes *again* before
///         signing, because `Wallet.Sign(msg)` takes a message rather than a digest
///             digest   = keccak256( signHash )
///
///      The signature itself comes from geth's `crypto.Sign`, whose recovery id is 0 or 1
///      rather than 27 or 28, so callers must normalise before `ecrecover`.
library TeeResultHash {
    /// @dev `signing.TEEActionResult`, an ASCII string right-padded into a bytes32, which is
    ///      exactly what a Solidity bytes32 string literal produces.
    bytes32 internal constant PREFIX_ACTION_RESULT = bytes32("TEE_ACTION_RESULT");

    /// @notice Step 1: the ActionResult envelope hash.
    /// @param data The extension's own result payload, byte-exact.
    /// @param actionId The instruction ID the result answers.
    /// @param submissionTag One of "threshold", "end", "submit".
    /// @param status Handler status; nonzero means the handler succeeded.
    function actionResultHash(bytes memory data, bytes32 actionId, string memory submissionTag, uint8 status)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(keccak256(data), actionId, keccak256(bytes(submissionTag)), status));
    }

    /// @notice Steps 2 and 3: domain-separate, then hash again to get the signed digest.
    function signedDigest(bytes32 dataHash, uint256 chainId) internal pure returns (bytes32) {
        bytes32 signHash = keccak256(abi.encode(PREFIX_ACTION_RESULT, chainId, dataHash));
        return keccak256(abi.encodePacked(signHash));
    }

    /// @notice The full chain, from result payload to the digest `ecrecover` needs.
    function digest(bytes memory data, bytes32 actionId, string memory submissionTag, uint8 status, uint256 chainId)
        internal
        pure
        returns (bytes32)
    {
        return signedDigest(actionResultHash(data, actionId, submissionTag, status), chainId);
    }
}
