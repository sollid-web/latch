// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

/// @title LatchDeposit: put your own tokens into your Latch vault in one contract call.
/// @notice Some wallets (OKX Wallet on X Layer) refuse a plain token transfer when a website asks for it,
///         but accept ordinary contract calls. This helper turns "Add funds" into one: after a one-time
///         approval, deposit() moves the caller's own tokens into a Latch vault.
///
/// What it can and cannot do:
///   - It only ever moves tokens FROM msg.sender. Nobody can use someone else's approval: there is no
///     `from` argument.
///   - It only sends TO a vault created by one of Latch's two factories, and only the token that vault
///     takes in (USDT0 for classic vaults; the vault's own tokenIn for v2 vaults).
///   - It holds nothing, has no owner, no admin, no upgrade and no other functions.
interface ILatchFactory {
    function isVault(address vault) external view returns (bool);
}

interface ILatchVault2 {
    function tokenIn() external view returns (address);
}

contract LatchDeposit {
    ILatchFactory public immutable classicFactory;
    ILatchFactory public immutable factory2;
    address public immutable classicToken; // USDT0, the token classic vaults buy with

    event Deposited(address indexed from, address indexed vault, address indexed token, uint256 amount);

    error NotALatchVault();
    error WrongToken();
    error ZeroAmount();
    error TransferFailed();

    constructor(ILatchFactory classicFactory_, ILatchFactory factory2_, address classicToken_) {
        classicFactory = classicFactory_;
        factory2 = factory2_;
        classicToken = classicToken_;
    }

    /// @notice Move `amount` of `token` from you into Latch vault `vault`.
    function deposit(address token, address vault, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (address(factory2) != address(0) && factory2.isVault(vault)) {
            if (token != ILatchVault2(vault).tokenIn()) revert WrongToken();
        } else if (address(classicFactory) != address(0) && classicFactory.isVault(vault)) {
            if (token != classicToken) revert WrongToken();
        } else {
            revert NotALatchVault();
        }
        // transferFrom(msg.sender → vault); tolerate tokens that return nothing
        (bool ok, bytes memory ret) = token.call(abi.encodeWithSelector(0x23b872dd, msg.sender, vault, amount));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
        emit Deposited(msg.sender, vault, token, amount);
    }
}
