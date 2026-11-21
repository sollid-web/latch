// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {LatchSwap} from "./LatchSwap.sol";

/// @title LatchFactory
/// @notice Anyone can create their own LatchSwap vault in one transaction. The caller becomes
///         the vault's owner. Everything that could hurt a user if chosen wrongly (token pair,
///         Uniswap pool and router, TapeOut circuit, TWAP window) is pinned here and identical
///         for every vault. The user chooses only: where the OKB goes, how much per buy, the daily
///         limit, the price ceiling, the spacing between buys, and (optionally) their own bot.
///
///         The factory holds no funds and has no power over vaults after creation. Its admin can
///         only change which hosted helper bot NEW vaults default to.
contract LatchFactory {
    address public immutable processor;
    uint256 public immutable circuitId;
    address public immutable tokenIn;
    address public immutable tokenOut;
    address public immutable router;
    address public immutable pool;
    address public immutable treasury;
    uint32 public immutable twapWindow;
    uint256 public immutable slippageBps;

    address public admin;
    address public hostedKeeper;

    address[] public vaults;
    mapping(address => address[]) private _vaultsOf;
    mapping(address => bool) public isVault;

    event VaultCreated(address indexed owner, address indexed vault, address keeper, uint256 perTxCap, uint256 dailyCap, uint256 maxPrice, uint256 minInterval);
    event HostedKeeperSet(address indexed keeper);
    event AdminSet(address indexed admin);

    error NotAdmin();
    error ZeroAddress();

    constructor(
        address processor_,
        uint256 circuitId_,
        address tokenIn_,
        address tokenOut_,
        address router_,
        address pool_,
        address treasury_,
        address hostedKeeper_,
        uint32 twapWindow_,
        uint256 slippageBps_
    ) {
        if (
            processor_ == address(0) || tokenIn_ == address(0) || tokenOut_ == address(0) || router_ == address(0)
                || pool_ == address(0) || treasury_ == address(0) || hostedKeeper_ == address(0)
        ) revert ZeroAddress();
        processor = processor_;
        circuitId = circuitId_;
        tokenIn = tokenIn_;
        tokenOut = tokenOut_;
        router = router_;
        pool = pool_;
        treasury = treasury_;
        twapWindow = twapWindow_;
        slippageBps = slippageBps_;
        admin = msg.sender;
        hostedKeeper = hostedKeeper_;
        emit AdminSet(msg.sender);
        emit HostedKeeperSet(hostedKeeper_);
    }

    /// @param savings      where bought OKB goes (usually the caller's own wallet)
    /// @param perTxCap     USDT0 per buy (base units)
    /// @param dailyCap     USDT0 per UTC day (base units)
    /// @param maxPrice     highest 30-min average price to buy at (USDT0 base units per 1 OKB)
    /// @param minInterval  seconds between buys (0 = buy the dip, 86400 = daily DCA, ...)
    /// @param keeper       address(0) = Latch's hosted helper bot; or your own bot / AI agent
    function createVault(
        address savings,
        uint256 perTxCap,
        uint256 dailyCap,
        uint256 maxPrice,
        uint256 minInterval,
        address keeper
    ) external returns (address vault) {
        address k = keeper == address(0) ? hostedKeeper : keeper;
        vault = address(
            new LatchSwap(
                LatchSwap.Config({
                    owner: msg.sender,
                    processor: processor,
                    circuitId: circuitId,
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    router: router,
                    pool: pool,
                    savings: savings,
                    treasury: treasury,
                    keeper: k,
                    perTxCap: perTxCap,
                    dailyCap: dailyCap,
                    activationFee: 0,
                    maxPrice: maxPrice,
                    maxSlippageBps: slippageBps,
                    twapWindow: twapWindow,
                    minInterval: minInterval
                })
            )
        );
        vaults.push(vault);
        _vaultsOf[msg.sender].push(vault);
        isVault[vault] = true;
        emit VaultCreated(msg.sender, vault, k, perTxCap, dailyCap, maxPrice, minInterval);
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice Vaults created by `owner` (ownership can later move; check vault.owner()).
    function vaultsOf(address owner) external view returns (address[] memory) {
        return _vaultsOf[owner];
    }

    /// @notice A page of all vaults, for the hosted bot.
    function vaultsPage(uint256 start, uint256 count) external view returns (address[] memory out) {
        uint256 n = vaults.length;
        if (start >= n) return out;
        uint256 end = start + count > n ? n : start + count;
        out = new address[](end - start);
        for (uint256 i = start; i < end; i++) {
            out[i - start] = vaults[i];
        }
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
}
