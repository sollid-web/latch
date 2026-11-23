// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {LatchVault} from "./LatchVault.sol";

/// @title LatchFactory2
/// @notice Anyone creates a Latch vault in one transaction: BUY (auto-buy OKB) or SELL (take profit),
///         with a strategy mode the TapeOut strategy chip (circuit #2) turns into trade sizes.
///         Vaults are EIP-1167 minimal-proxy clones of one LatchVault implementation, initialised in
///         the same transaction (so nobody can front-run the initialisation).
///
///         Pinned here for every vault: processor + circuit, Uniswap router + pool, tokens, TWAP
///         window, slippage, treasury, minimum trade sizes. The user chooses only: direction, mode,
///         where the output goes, base amount and limits, prices, spacing, and optionally their own bot.
///
///         The factory holds no funds and has no power over vaults. Its admin can only (a) change
///         the default hosted bot for NEW vaults and (b) revoke a bot address for every vault
///         (deny-only guardian: it can stop trades, never move funds or loosen rules).
contract LatchFactory2 {
    address public immutable implementation;
    address public immutable processor;
    uint256 public immutable circuitId;
    address public immutable router;
    address public immutable pool;
    address public immutable quoteToken;
    address public immutable baseToken;
    address public immutable treasury;
    uint32 public immutable twapWindow;
    uint256 public immutable slippageBps;
    uint256 public immutable minBuy; // in quoteToken units (USDT0)
    uint256 public immutable minSell; // in baseToken units (WOKB)

    address public admin;
    address public hostedKeeper;
    mapping(address => bool) public revoked;
    address[] public vaults;
    mapping(address => address[]) private _vaultsOf;
    mapping(address => bool) public isVault;

    event VaultCreated(address indexed owner, address indexed vault, uint8 direction, uint8 mode, address keeper);
    event HostedKeeperSet(address indexed keeper);
    event KeeperRevoked(address indexed keeper, bool revoked);
    event AdminSet(address indexed admin);

    error NotAdmin();
    error ZeroAddress();
    error BadSavings();
    error CloneFailed();

    struct Pins {
        address processor;
        uint256 circuitId;
        address router;
        address pool;
        address quoteToken;
        address baseToken;
        address treasury;
        address hostedKeeper;
        uint32 twapWindow;
        uint256 slippageBps;
        uint256 minBuy;
        uint256 minSell;
    }

    constructor(Pins memory p) {
        if (
            p.processor == address(0) || p.router == address(0) || p.pool == address(0) || p.quoteToken == address(0)
                || p.baseToken == address(0) || p.treasury == address(0) || p.hostedKeeper == address(0)
        ) revert ZeroAddress();
        implementation = address(new LatchVault());
        processor = p.processor;
        circuitId = p.circuitId;
        router = p.router;
        pool = p.pool;
        quoteToken = p.quoteToken;
        baseToken = p.baseToken;
        treasury = p.treasury;
        twapWindow = p.twapWindow;
        slippageBps = p.slippageBps;
        minBuy = p.minBuy;
        minSell = p.minSell;
        admin = msg.sender;
        hostedKeeper = p.hostedKeeper;
        emit AdminSet(msg.sender);
        emit HostedKeeperSet(p.hostedKeeper);
    }

    /// @param direction  0 = BUY (holds USDT0, buys OKB), 1 = SELL (holds WOKB, takes profit in USDT0)
    /// @param mode       0 plain (every time allowed), 1 dip/rise-only, 2 smart (bigger on bigger moves), 3 ladder
    /// @param savings    where the output goes (usually the caller's own wallet)
    /// @param baseAmount size of a 1x trade, in the token the vault holds
    /// @param perTxCap   most per trade (>= baseAmount; the chip can ask for up to 3x)
    /// @param dailyCap   most per UTC day
    /// @param refPrice   reference price (USDT0 per OKB) the chip measures moves against
    /// @param limitPrice BUY: never pay more than this; SELL: never sell below this
    /// @param minInterval seconds between trades (0, 1 day, 1 week, ...)
    /// @param keeper     address(0) = Latch's hosted bot, or your own bot / AI agent
    // slither-disable-next-line reentrancy-events (the only external call is initialize() on our own fresh clone)
    function createVault(
        uint8 direction,
        uint8 mode,
        address savings,
        uint256 baseAmount,
        uint256 perTxCap,
        uint256 dailyCap,
        uint256 refPrice,
        uint256 limitPrice,
        uint256 minInterval,
        address keeper
    ) external returns (address vault) {
        address k = keeper == address(0) ? hostedKeeper : keeper;
        if (savings == address(this) || savings == hostedKeeper || savings == k || savings == treasury || isVault[savings]) {
            revert BadSavings();
        }
        vault = _clone(implementation);
        vaults.push(vault);
        _vaultsOf[msg.sender].push(vault);
        isVault[vault] = true;
        LatchVault(vault).initialize(
            LatchVault.Init({
                owner: msg.sender,
                processor: processor,
                circuitId: circuitId,
                router: router,
                pool: pool,
                twapWindow: twapWindow,
                quoteToken: quoteToken,
                baseToken: baseToken,
                direction: direction,
                mode: mode,
                savings: savings,
                treasury: treasury,
                keeper: k,
                guardian: address(this),
                minAmount: direction == 0 ? minBuy : minSell,
                baseAmount: baseAmount,
                perTxCap: perTxCap,
                dailyCap: dailyCap,
                refPrice: refPrice,
                limitPrice: limitPrice,
                minInterval: minInterval,
                maxSlippageBps: slippageBps
            })
        );
        emit VaultCreated(msg.sender, vault, direction, mode, k);
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    function vaultsPage(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = vaults.length;
        if (start >= n) return out;
        uint256 end = start + count > n ? n : start + count;
        out = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = vaults[i];
        }
    }

    /// @notice Deny-only: block (or unblock) a bot address in every vault from this factory.
    function setRevoked(address keeper, bool on) external {
        if (msg.sender != admin) revert NotAdmin();
        revoked[keeper] = on;
        emit KeeperRevoked(keeper, on);
    }

    function setHostedKeeper(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        if (next == address(0)) revert ZeroAddress();
        hostedKeeper = next;
        emit HostedKeeperSet(next);
    }

    function setAdmin(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        if (next == address(0)) revert ZeroAddress();
        admin = next;
        emit AdminSet(next);
    }

    /// @dev EIP-1167 minimal proxy.
    // slither-disable-next-line assembly
    function _clone(address impl) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, impl))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert CloneFailed();
    }
}
