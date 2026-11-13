// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface. `decimals` is read once when the token is
///         set, so the caps below can never be unit-mismatched: this vault only
///         accepts an 18-decimal token.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// @title LatchRelay
/// @notice Keeper-triggered savings sweep, with the Latch policy on chain.
///
///         Seven bits, bit 0 least significant, packed into one byte: exactly
///         the byte the console prints on its Circuit tab.
///         bit 0 paused, 1 keeper, 2 target is the savings whitelist,
///         3 action is the sweep, 4 per-tx cap, 5 daily cap, 6 funded.
///
///         Bits 2 and 3 are structural here. `tick` takes no target and no
///         calldata, so the only action that exists is the sweep to `savings`,
///         and it is always the whitelisted one. `preview` reports bit 1 from
///         the real caller, so the keeper row can never lie.
///
///         The keeper pays gas and can only call `tick`. It cannot pick a
///         destination, raise a cap, unpause, or take anything back. The owner
///         is the circuit container: every admin call below is onlyOwner.
///
///         Caps are 50 and 150 tokens per tx and per UTC day. The sweep fee
///         starts at 1% and falls with cumulative swept volume — 75 bps past
///         1 000, 50 past 5 000, 25 past 20 000 — so a vault that keeps saving
///         pays less, and a rejected call costs nothing. Arming costs 5 tokens.
contract LatchRelay {
    uint256 public constant FEE_BPS = 100;
    uint256 public constant PER_TX_CAP = 50 ether;
    uint256 public constant DAILY_CAP = 150 ether;
    uint256 public constant ACTIVATION_FEE = 5 ether;

    /// @notice Cumulative swept volume at which the fee steps down.
    uint256 public constant TIER_ONE = 1_000 ether;
    uint256 public constant TIER_TWO = 5_000 ether;
    uint256 public constant TIER_THREE = 20_000 ether;

    uint256 private constant DAY = 1 days;

    address public owner;
    IERC20 public token;
    address public keeper;
    address public savings;
    address public treasury;
    bool public armed;
    bool public paused;
    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public spentToday;
    uint256 public dayStart;
    uint256 public volumeSwept;

    uint256 private locked;

    event Armed(address indexed payer, uint256 fee);
    event Ticked(address indexed keeper, uint256 amount, uint8 bits);
    event Sweep(address indexed to, uint256 amount, uint256 fee);
    event TierChanged(uint256 volumeSwept, uint256 feeBps);
    event CapsTightened(uint256 perTxCap, uint256 dailyCap);
    event KeeperSet(address indexed keeper);
    event SavingsSet(address indexed savings);
    event TreasurySet(address indexed treasury);
    event PausedSet(bool paused);
    event TokenSet(address indexed token);
    event Withdrawn(address indexed to, uint256 amount);

    error NotOwner();
    error NotKeeper();
    error NotArmed();
    error AlreadyArmed();
    error Paused();
    error OverCap();
    error Underfunded();
    error TransferFailed();
    error ZeroAddress();
    error CapRaised();
    error Reentered();
    error BadToken();
    error TokenLocked();
    error TokenNotSet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (locked == 1) revert Reentered();
        locked = 1;
        _;
        locked = 0;
    }

    /// @param owner_ the circuit container that owns this relay.
    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        keeper = owner_;
        savings = owner_;
        treasury = owner_;
        perTxCap = PER_TX_CAP;
        dailyCap = DAILY_CAP;
    }

    // ---------------------------------------------------------------- admin

    /// @notice The vault is token-agnostic but decimal-strict: 18 only, so the
    ///         literal caps mean what the console says they mean. The token is
    ///         fixed once arming happens, or once the vault holds a balance.
    function setToken(address next) external onlyOwner {
        if (armed) revert TokenLocked();
        if (next == address(0)) revert ZeroAddress();
        if (address(token) != address(0) && token.balanceOf(address(this)) != 0) revert TokenLocked();
        if (next.code.length == 0) revert BadToken();
        try IERC20(next).decimals() returns (uint8 places) {
            if (places != 18) revert BadToken();
        } catch {
            revert BadToken();
        }
        token = IERC20(next);
        emit TokenSet(next);
    }

    function setKeeper(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        keeper = next;
        emit KeeperSet(next);
    }

    function setSavings(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        savings = next;
        emit SavingsSet(next);
    }

    function setTreasury(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        treasury = next;
        emit TreasurySet(next);
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PausedSet(next);
    }

    /// @notice Caps only ever move down. Raising them would let a stolen owner
    ///         key drain the vault up to the new ceiling.
    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > dailyCap_) revert OverCap();
        if (perTxCap_ > perTxCap || dailyCap_ > dailyCap) revert CapRaised();
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit CapsTightened(perTxCap_, dailyCap_);
    }

    /// @notice Charges the one-time activation fee from the vault to treasury.
    ///         The vault must already hold it, so arm after funding.
    function arm() external onlyOwner nonReentrant {
        if (armed) revert AlreadyArmed();
        if (address(token) == address(0)) revert TokenNotSet();
        uint256 fee = ACTIVATION_FEE;
        if (token.balanceOf(address(this)) < fee) revert Underfunded();
        armed = true;
        _send(treasury, fee);
        emit Armed(msg.sender, fee);
    }

    /// @notice Owner rescue. The funds are the owner's, so this exists, but it
    ///         is the only path that can move them anywhere except savings and
    ///         treasury, and it needs a container transaction to happen.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (address(token) == address(0)) revert TokenNotSet();
        if (amount == 0 || amount > token.balanceOf(address(this))) revert Underfunded();
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    // --------------------------------------------------------------- keeper

    /// @notice Keeper pays gas, the vault pays savings and the fee.
    function tick(uint256 amount) external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (!armed) revert NotArmed();
        if (paused) revert Paused();
        if (address(token) == address(0)) revert TokenNotSet();
        if (amount == 0 || amount > perTxCap) revert OverCap();
        if (_spentToday() + amount > dailyCap) revert OverCap();
        uint256 bps = feeBpsFor(volumeSwept);
        uint256 fee = (amount * bps) / 10_000;
        if (token.balanceOf(address(this)) < amount + fee) revert Underfunded();

        uint8 bits = _bits(amount, true);
        _rollDay();
        spentToday += amount;
        volumeSwept += amount;
        _send(savings, amount);
        if (fee > 0) _send(treasury, fee);
        emit Ticked(msg.sender, amount, bits);
        emit Sweep(savings, amount, fee);
        uint256 nextBps = feeBpsFor(volumeSwept);
        if (nextBps != bps) emit TierChanged(volumeSwept, nextBps);
    }

    // ----------------------------------------------------------------- views

    /// @notice The same byte and the same verdict `tick` would use right now.
    function preview(uint256 amount) external view returns (uint8 bits, bool allow) {
        bits = _bits(amount, msg.sender == keeper);
        // `armed` is not a bit: it only matters before the first tick, so it is
        // folded into the verdict instead of spending one of the seven bits.
        allow = armed && (bits & 1) == 0 && (bits & 2) != 0 && (bits & 16) != 0
            && (bits & 32) != 0 && (bits & 64) != 0;
    }

    /// @notice Everything the console needs in one call.
    function status()
        external
        view
        returns (
            address token_,
            bool armed_,
            bool paused_,
            uint256 balance_,
            uint256 perTxCap_,
            uint256 dailyCap_,
            uint256 spentToday_,
            address keeper_,
            address savings_,
            address treasury_
        )
    {
        token_ = address(token);
        armed_ = armed;
        paused_ = paused;
        balance_ = address(token) == address(0) ? 0 : token.balanceOf(address(this));
        perTxCap_ = perTxCap;
        dailyCap_ = dailyCap;
        spentToday_ = _spentToday();
        keeper_ = keeper;
        savings_ = savings;
        treasury_ = treasury;
    }

    /// @notice The fee the current tier would charge on this amount.
    function feeOn(uint256 amount) external view returns (uint256) {
        return (amount * feeBpsFor(volumeSwept)) / 10_000;
    }

    /// @notice The rate that applies to the next sweep.
    function feeBpsNow() external view returns (uint256) {
        return feeBpsFor(volumeSwept);
    }

    /// @notice The loyalty ladder: the fee only ever falls as a vault sweeps.
    function feeBpsFor(uint256 swept) public pure returns (uint256) {
        if (swept >= TIER_THREE) return 25;
        if (swept >= TIER_TWO) return 50;
        if (swept >= TIER_ONE) return 75;
        return FEE_BPS;
    }

    function _bits(uint256 amount, bool keeperOk) internal view returns (uint8 bits) {
        uint256 fee = (amount * feeBpsFor(volumeSwept)) / 10_000;
        bool txOk = amount != 0 && amount <= perTxCap;
        bool dayOk = _spentToday() + amount <= dailyCap;
        bool funded = address(token) != address(0) && token.balanceOf(address(this)) >= amount + fee;

        if (paused) bits |= 1;
        if (keeperOk) bits |= 2;
        bits |= 4;
        bits |= 8;
        if (txOk) bits |= 16;
        if (dayOk) bits |= 32;
        if (funded) bits |= 64;
    }

    function _send(address to, uint256 amount) internal {
        if (!token.transfer(to, amount)) revert TransferFailed();
    }

    /// @dev UTC calendar day, the same boundary the console rolls its counter on.
    function _spentToday() internal view returns (uint256) {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) return 0;
        return spentToday;
    }

    function _rollDay() internal {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) {
            dayStart = start;
            spentToday = 0;
        }
    }
}
