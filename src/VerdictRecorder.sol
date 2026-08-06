// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IGatedProtect} from "./ConfidentialTrigger.sol";
import {Id} from "./interfaces/IMorpho.sol";

/// @title VerdictRecorder
/// @notice Records verdicts that `ConfidentialTrigger` has accepted. **It does not deleverage.**
///
/// @dev This exists because Flare split its own stack. Morpho Blue, FXRP and the SparkDEX
///      pools are on Flare mainnet; Flare Confidential Compute exists only on Coston2, and
///      the `FlareTeeManager` address holds no code on mainnet. A contract that verifies TEE
///      signatures therefore has to live on Coston2, where there is no lending market for it
///      to act on.
///
///      So the two halves are demonstrated where each is real:
///
///      - **Coston2** proves the confidential path. A verdict signed by an attested machine is
///        verified against Flare's live registry, and lands here.
///      - **Flare mainnet** proves the protection itself. `BallastManager` is deployed and
///        verified, and the flash-loan deleverage is exercised against genuine borrower
///        positions and real SparkDEX liquidity in the fork tests.
///
///      This contract is deliberately not a mock Morpho. It does not simulate a deleverage or
///      return plausible-looking numbers, because a demonstration that invents outcomes is
///      worse than one that stops at the boundary of what it can honestly show. It records
///      what it was told and says so.
contract VerdictRecorder is IGatedProtect {
    struct Record {
        address borrower;
        Id id;
        uint128 targetHealth;
        uint32 maxSlippageBps;
        uint64 timestamp;
        address caller;
    }

    Record[] public records;

    /// @notice Only this address may record, so a stranger cannot pad the log with noise.
    /// @dev Set once after deployment rather than in the constructor, because the trigger and
    ///      the recorder each need the other's address. Settable exactly once, so it cannot be
    ///      repointed later at a contract that skips verification.
    address public trigger;

    event VerdictRecorded(
        address indexed borrower, Id indexed id, uint128 targetHealth, uint32 maxSlippageBps, uint256 index
    );

    error OnlyTrigger(address caller);
    error TriggerAlreadySet();

    function setTrigger(address trigger_) external {
        if (trigger != address(0)) revert TriggerAlreadySet();
        trigger = trigger_;
    }

    /// @inheritdoc IGatedProtect
    /// @dev Returns zeros for `repaid` and `collateralSold`. Nothing was repaid and nothing was
    ///      sold: there is no market on this chain. Reporting anything else would be fiction.
    function protectFor(address borrower, Id id, uint128 targetHealth, uint32 maxSlippageBps, address)
        external
        returns (uint256 repaid, uint256 collateralSold)
    {
        if (msg.sender != trigger) revert OnlyTrigger(msg.sender);

        records.push(
            Record({
                borrower: borrower,
                id: id,
                targetHealth: targetHealth,
                maxSlippageBps: maxSlippageBps,
                timestamp: uint64(block.timestamp),
                caller: msg.sender
            })
        );

        emit VerdictRecorded(borrower, id, targetHealth, maxSlippageBps, records.length - 1);
        return (0, 0);
    }

    function recordCount() external view returns (uint256) {
        return records.length;
    }
}
