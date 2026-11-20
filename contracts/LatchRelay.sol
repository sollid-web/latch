// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TapeOut processor. `eval` is a pure bit function. `netlist` is the taped-out bytes.
interface IProcessor {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

/// @title LatchRelay
/// @notice A savings vault whose every sweep must be allowed by a taped-out
///         TapeOut circuit. Gas-only keepers call `tick`. Funds sit in this
///         contract; fund it with a plain token transfer.
///
///         Two locks, both required, in the same transaction:
///           1. Solidity enforces keeper, arm flag, pause, both caps, and that
///              the vault can pay the sweep plus the fee.
///           2. The TapeOut circuit: `tick` reverts unless `processor.eval`
///              returns allow for the policy byte this contract builds.
///         The circuit is not trusted as the only check, and it is called with
///         STATICCALL, so it can deny but never move funds.
///
///         `tick` has no target and no calldata argument. The sweep always
///         pays `savings`, and the fee always pays `treasury`. Bits 2 and 3 of
///         the policy byte are therefore structurally 1, not caller input.
///
///         Bit 0 paused, 1 keeper, 2 savings recipient, 3 sweep action,
///         4 per-tx cap, 5 daily cap, 6 vault covers amount + fee.
///         Packed little-endian into one byte, matching `bitsToByte` in circuit.ts.
///         The circuit taped out on X Layer (processor 0x3728…6813, circuit #1)
///         allows exactly 0x7e.
///
///         Units: caps, fee and tier thresholds are in the token's own base
///         units. Tiers scale with `decimals()`.
///
///         Custody: the circuit NFT is not needed. The circuit's `eval` is a
///         public view; this contract only reads it. Funds never leave except
///         to `savings`/`treasury` via `tick`/`arm`, or to the owner's choice
///         via `withdraw`, all plain token transfers from this contract.
contract LatchRelay {
    /// @notice Starting sweep fee. Falls with cumulative volume (see feeBpsFor).
    uint256 public constant FEE_BPS = 100;
    uint256 private constant DAY = 1 days;

    address public owner;
    IProcessor public immutable processor;
    uint256 public immutable circuitId;
    IERC20 public immutable token;
    /// @notice 10 ** token.decimals(), read once at deploy.
    uint256 public immutable unit;
    address public immutable savings;
    address public immutable treasury;
    address public keeper;
    bool public paused;
    bool public armed;
    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public spentToday;
    uint256 public dayStart;
    uint256 public volumeSwept;
    uint256 public immutable activationFee;
    uint256 private locked;

    event Armed(address indexed payer, uint256 fee);
    event Ticked(address indexed keeper, uint256 amount, uint8 bits);
    event Sweep(address indexed to, uint256 amount, uint256 fee);
    event TierChanged(uint256 volumeSwept, uint256 feeBps);
    event CapsTightened(uint256 perTxCap, uint256 dailyCap);
    event KeeperSet(address indexed keeper);
    event PausedSet(bool paused);
    event Withdrawn(address indexed to, uint256 amount);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotKeeper();
    error AlreadyArmed();
    error UnderfundedActivation();
    error CircuitDenied(uint8 bits);
    error NotArmed();
    error BadEval();
    error Paused();
    error OverCap();
    error Underfunded();
    error TransferFailed();
    error ZeroAddress();
    error CapRaised();
    error Reentered();
    error BadToken();

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

    constructor(
        address processor_,
        uint256 circuitId_,
        address token_,
        address savings_,
        address treasury_,
        address keeper_,
        uint256 perTxCap_,
        uint256 dailyCap_,
        uint256 activationFee_
    ) {
        if (
            processor_ == address(0) || token_ == address(0) || savings_ == address(0)
                || treasury_ == address(0) || keeper_ == address(0)
        ) revert ZeroAddress();
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > dailyCap_) revert OverCap();
        if (processor_.code.length == 0) revert BadEval();
        if (token_.code.length == 0) revert BadToken();
        uint8 dec = IERC20(token_).decimals();
        if (dec > 36) revert BadToken();

        owner = msg.sender;
        processor = IProcessor(processor_);
        circuitId = circuitId_;
        token = IERC20(token_);
        unit = 10 ** uint256(dec);
        savings = savings_;
        treasury = treasury_;
        keeper = keeper_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        activationFee = activationFee_;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    // ---------------------------------------------------------------- admin

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, next);
        owner = next;
    }

    function setPaused(bool next) external onlyOwner {
        paused = next;
        emit PausedSet(next);
    }

    function setKeeper(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        keeper = next;
        emit KeeperSet(next);
    }

    /// @notice Caps can only move down. Raising them would let a stolen owner key
    ///         set a higher ceiling for the keeper.
    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > dailyCap_) revert OverCap();
        if (perTxCap_ > perTxCap || dailyCap_ > dailyCap) revert CapRaised();
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit CapsTightened(perTxCap_, dailyCap_);
    }

    /// @notice Pays `activationFee` of `token` from the vault to `treasury`.
    ///         A zero fee still arms.
    function arm() external onlyOwner nonReentrant {
        if (armed) revert AlreadyArmed();
        uint256 fee = activationFee;
        armed = true;
        if (fee > 0) {
            if (token.balanceOf(address(this)) < fee) revert UnderfundedActivation();
            _send(treasury, fee);
        }
        emit Armed(msg.sender, fee);
    }

    /// @notice Owner rescue: the only path that can send funds anywhere except
    ///         savings and treasury. Works paused or unarmed.
    function withdraw(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0 || amount > token.balanceOf(address(this))) revert Underfunded();
        _send(to, amount);
        emit Withdrawn(to, amount);
    }

    // --------------------------------------------------------------- keeper

    /// @notice Keeper pays gas. Destination, pause, caps, and funding are enforced
    ///         here. The circuit must also allow, or the call reverts.
    function tick(uint256 amount) external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (!armed) revert NotArmed();
        if (paused) revert Paused();
        if (amount == 0 || amount > perTxCap) revert OverCap();
        if (_spentToday() + amount > dailyCap) revert OverCap();
        uint256 bps = feeBpsFor(volumeSwept);
        uint256 fee = (amount * bps) / 10_000;
        if (token.balanceOf(address(this)) < amount + fee) revert Underfunded();

        uint8 bits = _bits(amount, true);
        if (!_policy(bits)) revert CircuitDenied(bits);

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

    /// @notice The byte `tick` would build for this caller, and the verdict.
    ///         Bit 1 reflects the real caller, so an eth_call without `from`
    ///         set to the keeper reports denied, exactly as `tick` would.
    function preview(uint256 amount) external view returns (uint8 bits, bool allow) {
        bits = _bits(amount, msg.sender == keeper);
        if (!armed || paused || msg.sender != keeper) return (bits, false);
        if ((bits & 0x70) != 0x70) return (bits, false);
        allow = _policy(bits);
    }

    /// @notice What the circuit alone says about a policy byte.
    function circuitAllows(uint8 bits) external view returns (bool) {
        return _policy(bits);
    }

    /// @notice The vault itself holds the funds. Kept so consoles that read
    ///         `container()` keep working.
    function container() external view returns (address) {
        return address(this);
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
        balance_ = token.balanceOf(address(this));
        perTxCap_ = perTxCap;
        dailyCap_ = dailyCap;
        spentToday_ = _spentToday();
        keeper_ = keeper;
        savings_ = savings;
        treasury_ = treasury;
    }

    function feeOn(uint256 amount) external view returns (uint256) {
        return (amount * feeBpsFor(volumeSwept)) / 10_000;
    }

    function feeBpsNow() external view returns (uint256) {
        return feeBpsFor(volumeSwept);
    }

    /// @notice The loyalty ladder: the fee only ever falls as a vault sweeps.
    ///         1% to start, 75 bps past 1 000 tokens, 50 past 5 000, 25 past 20 000.
    function feeBpsFor(uint256 swept) public view returns (uint256) {
        if (swept >= 20_000 * unit) return 25;
        if (swept >= 5_000 * unit) return 50;
        if (swept >= 1_000 * unit) return 75;
        return FEE_BPS;
    }

    // -------------------------------------------------------------- internal

    function _bits(uint256 amount, bool keeperOk) internal view returns (uint8 bits) {
        uint256 fee = (amount * feeBpsFor(volumeSwept)) / 10_000;
        bool txOk = amount > 0 && amount <= perTxCap;
        bool dayOk = _spentToday() + amount <= dailyCap;
        bool funded = token.balanceOf(address(this)) >= amount + fee;
        if (paused) bits |= 1;
        if (keeperOk) bits |= 2;
        bits |= 4;
        bits |= 8;
        if (txOk) bits |= 16;
        if (dayOk) bits |= 32;
        if (funded) bits |= 64;
    }

    /// @dev View calls compile to STATICCALL. A state-changing `eval` reverts.
    function _policy(uint8 bits) internal view returns (bool) {
        bytes memory out = processor.eval(circuitId, abi.encodePacked(bits));
        if (out.length == 0) revert BadEval();
        return (uint8(out[0]) & 1) == 1;
    }

    /// @dev Token transfer from the vault. Accepts an empty return (non-standard
    ///      tokens) or a single `true`; anything else reverts.
    function _send(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) =
            address(token).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok) {
            // Bubble the token's own revert reason; it is the useful diagnostic.
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert TransferFailed();
        }
        if (ret.length == 0) {
            if (address(token).code.length == 0) revert TransferFailed();
            return;
        }
        if (ret.length < 32 || !abi.decode(ret, (bool))) revert TransferFailed();
    }

    // slither-disable-next-line divide-before-multiply,timestamp
    function _spentToday() internal view returns (uint256) {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) return 0;
        return spentToday;
    }

    /// @dev UTC day, matching the console's calendar date. Not a rolling 24h window.
    ///      Flooring to midnight is intentional (Slither divide-before-multiply).
    // slither-disable-next-line divide-before-multiply,timestamp
    function _rollDay() internal {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) {
            dayStart = start;
            spentToday = 0;
        }
    }
}
