// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice TapeOut processor. `eval` is a pure bit function. `netlist` is the taped-out bytes.
interface IProcessor {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
    function netlist(uint256 id) external view returns (bytes memory);
}

/// @notice ERC-6551 circuit container. Only the circuit NFT owner can execute.
interface IContainer {
    function execute(
        address to,
        uint256 value,
        bytes calldata data,
        uint8 operation
    ) external payable returns (bytes memory);
}

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title LatchRelay
/// @notice Gas-only keepers call `tick`. Funds stay in the TapeOut container.
///
///         Solidity enforces the keeper, the arm flag, pause, both caps, and
///         that the container can pay the sweep plus the 1% fee. The TapeOut
///         circuit is a second lock: `tick` still reverts unless `eval` returns
///         allow. The circuit is not trusted as the only check. Processor
///         proxies can change, and `eval` only sees bits this contract builds.
///
///         `tick` has no target and no calldata argument. The sweep always
///         pays `savings`, and the fee always pays `treasury`. Those two bits
///         in the policy byte are therefore 1. They are not caller input.
///
///         Bit 0 paused, 1 keeper, 2 savings recipient, 3 sweep action,
///         4 per-tx cap, 5 daily cap, 6 container covers amount + fee.
///         Packed little-endian into one byte, matching `bitsToByte` in circuit.ts.
///
///         Own the circuit NFT with this contract before going live, or
///         `container.execute` will reject the relay. This contract cannot
///         forward the NFT, so once it holds the token the token stays here.
contract LatchRelay {
    uint256 public constant FEE_BPS = 100;
    uint8 public constant OP_CALL = 0;
    uint256 private constant DAY = 1 days;

    address public owner;
    IProcessor public processor;
    uint256 public circuitId;
    IContainer public container;
    IERC20 public token;
    address public savings;
    address public treasury;
    address public keeper;
    bool public paused;
    bool public armed;
    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public spentToday;
    uint256 public dayStart;
    uint256 public activationFee;
    uint256 private locked;

    event Armed(address payer, uint256 fee);
    event Ticked(uint256 amount, uint8 bits);
    event Sweep(address indexed to, uint256 amount, uint256 fee);
    event CapsTightened(uint256 perTxCap, uint256 dailyCap);
    event KeeperSet(address keeper);
    event PausedSet(bool paused);

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
        address container_,
        address token_,
        address savings_,
        address treasury_,
        address keeper_,
        uint256 perTxCap_,
        uint256 dailyCap_,
        uint256 activationFee_
    ) {
        if (
            processor_ == address(0) || container_ == address(0) || token_ == address(0)
                || savings_ == address(0) || treasury_ == address(0) || keeper_ == address(0)
        ) revert ZeroAddress();
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > dailyCap_) revert OverCap();
        owner = msg.sender;
        processor = IProcessor(processor_);
        circuitId = circuitId_;
        container = IContainer(container_);
        token = IERC20(token_);
        savings = savings_;
        treasury = treasury_;
        keeper = keeper_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        activationFee = activationFee_;
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
    ///         empty the container up to the new ceiling.
    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > dailyCap_) revert OverCap();
        if (perTxCap_ > perTxCap || dailyCap_ > dailyCap) revert CapRaised();
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit CapsTightened(perTxCap_, dailyCap_);
    }

    /// @notice Pulls `activationFee` of `token` from the container to `treasury`.
    ///         A zero fee still arms. The relay must already own the circuit NFT.
    function arm() external onlyOwner nonReentrant {
        if (armed) revert AlreadyArmed();
        uint256 fee = activationFee;
        if (fee > 0) {
            if (token.balanceOf(address(container)) < fee) revert UnderfundedActivation();
            _pull(treasury, fee);
        }
        armed = true;
        emit Armed(msg.sender, fee);
    }

    function preview(uint256 amount) external view returns (uint8 bits, bool allow) {
        bits = _bits(amount, true);
        if (paused || !armed || amount == 0 || amount > perTxCap) return (bits, false);
        if (_spentToday() + amount > dailyCap) return (bits, false);
        uint256 fee = (amount * FEE_BPS) / 10_000;
        if (token.balanceOf(address(container)) < amount + fee) return (bits, false);
        allow = _policy(bits);
    }

    /// @notice Keeper pays gas. Destination, pause, caps, and funding are enforced
    ///         here. The circuit must also allow, or the call reverts.
    function tick(uint256 amount) external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (!armed) revert NotArmed();
        if (paused) revert Paused();
        if (amount == 0 || amount > perTxCap) revert OverCap();
        if (_spentToday() + amount > dailyCap) revert OverCap();
        uint256 fee = (amount * FEE_BPS) / 10_000;
        if (token.balanceOf(address(container)) < amount + fee) revert Underfunded();

        uint8 bits = _bits(amount, true);
        if (!_policy(bits)) revert CircuitDenied(bits);

        _rollDay();
        spentToday += amount;
        _pull(savings, amount);
        if (fee > 0) _pull(treasury, fee);
        emit Ticked(amount, bits);
        emit Sweep(savings, amount, fee);
    }

    function _bits(uint256 amount, bool fromKeeper) internal view returns (uint8 bits) {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 spent = _spentToday();
        bool txOk = amount > 0 && amount <= perTxCap;
        bool dayOk = spent + amount <= dailyCap;
        bool funded = token.balanceOf(address(container)) >= amount + fee;
        if (paused) bits |= 1;
        if (fromKeeper) bits |= 2;
        bits |= 4;
        bits |= 8;
        if (txOk) bits |= 16;
        if (dayOk) bits |= 32;
        if (funded) bits |= 64;
    }

    /// @dev View calls compile to STATICCALL. A state-changing `eval` reverts.
    function _policy(uint8 bits) internal view returns (bool) {
        bytes memory inputs = abi.encodePacked(bits);
        bytes memory out = processor.eval(circuitId, inputs);
        if (out.length == 0) revert BadEval();
        return (uint8(out[0]) & 1) == 1;
    }

    /// @dev Accepts an empty return (non-standard tokens) or a single `true`.
    ///      Any other return, including `false`, reverts the whole tick.
    function _pull(address recipient, uint256 amount) internal {
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount);
        bytes memory result = container.execute(address(token), 0, data, OP_CALL);
        if (result.length == 0) return;
        if (result.length < 32 || !abi.decode(result, (bool))) revert TransferFailed();
    }

    function _spentToday() internal view returns (uint256) {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) return 0;
        return spentToday;
    }

    /// @dev UTC day, matching the preview's calendar date. Not a rolling 24h window.
    function _rollDay() internal {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) {
            dayStart = start;
            spentToday = 0;
        }
    }
}
