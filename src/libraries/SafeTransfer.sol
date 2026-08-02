// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title SafeTransfer
/// @notice ERC20 helpers that tolerate non-standard tokens.
/// @dev USD₮0 is a USDT-family token: its `transfer`/`approve` may return nothing rather than a
///      bool. A plain `IERC20(...).transfer(...)` reverts on decode for such tokens, so every
///      token movement in Ballast goes through here. We accept either empty returndata or a
///      returned `true`, and revert on anything else.
library SafeTransfer {
    error TransferFailed();
    error TransferFromFailed();
    error ApproveFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFromFailed();
    }

    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert ApproveFailed();
    }

    /// @dev Some tokens require the allowance to be zeroed before it can be raised again.
    function safeApproveReset(address token, address spender, uint256 amount) internal {
        safeApprove(token, spender, 0);
        safeApprove(token, spender, amount);
    }
}
