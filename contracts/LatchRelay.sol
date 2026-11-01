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
    function transfer(address to, uint256 amount) external returns (bool);
}

/// @title LatchRelay
/// @notice Gas-only keepers call `tick`. Funds stay in the TapeOut container until the
///         bound policy circuit returns allow. The seven input bits are derived here.
///         They are never taken from the caller.
///
///         Bit 0 paused, 1 keeper, 2 whitelisted, 3 action is sweep,
///         4 per-tx cap, 5 daily cap, 6 container covers amount + fee.
///         Packed little-endian into one byte, matching `bitsToByte` in circuit.ts.
///
///         Own the circuit NFT with this contract before going live, or `container.execute`
///         will reject the relay.
contract LatchRelay {
    uint256 public constant FEE_BPS = 100;
    uint8 public constant OP_CALL = 0;

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

    event Armed(address payer);
    event Ticked(uint256 amount, bool allow, uint8 bits);
    event Sweep(address indexed to, uint256 amount, uint256 fee);

    error NotOwner();
    error NotKeeper();
    error AlreadyArmed();
    error UnderfundedActivation();
    error CircuitDenied(uint8 bits);
    error NotArmed();
    error BadEval();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
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
    }

    function setKeeper(address next) external onlyOwner {
        keeper = next;
    }

    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
    }

    /// @dev Call from the container, or have the owner transfer `activationFee` of `token`
    ///      to `treasury` out of band and then call this. The preview charges 5 USDT.
    function arm() external onlyOwner {
        if (armed) revert AlreadyArmed();
        armed = true;
        emit Armed(msg.sender);
    }

    function preview(uint256 amount) external view returns (uint8 bits, bool allow) {
        bits = _bits(amount, true);
        allow = _allow(bits);
    }

    /// @notice Keeper pays gas. This cannot move funds the circuit rejects.
    function tick(uint256 amount) external {
        if (msg.sender != keeper) revert NotKeeper();
        _rollDay();
        uint8 bits = _bits(amount, true);
        if (!_allow(bits)) {
            emit Ticked(amount, false, bits);
            revert CircuitDenied(bits);
        }
        if (!armed) revert NotArmed();
        uint256 fee = (amount * FEE_BPS) / 10_000;
        spentToday += amount;
        _pull(savings, amount);
        if (fee > 0) _pull(treasury, fee);
        emit Ticked(amount, true, bits);
        emit Sweep(savings, amount, fee);
    }

    function _bits(uint256 amount, bool fromKeeper) internal view returns (uint8 bits) {
        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 need = amount + fee;
        bool whitelist = true;
        bool actionOk = true;
        bool txOk = amount > 0 && amount <= perTxCap;
        bool dayOk = spentToday + amount <= dailyCap;
        bool funded = token.balanceOf(address(container)) >= need;
        if (paused) bits |= 1;
        if (fromKeeper) bits |= 2;
        if (whitelist) bits |= 4;
        if (actionOk) bits |= 8;
        if (txOk) bits |= 16;
        if (dayOk) bits |= 32;
        if (funded) bits |= 64;
    }

    function _allow(uint8 bits) internal view returns (bool) {
        bytes memory inputs = abi.encodePacked(bits);
        bytes memory out = processor.eval(circuitId, inputs);
        if (out.length == 0) revert BadEval();
        return (uint8(out[0]) & 1) == 1;
    }

    function _pull(address recipient, uint256 amount) internal {
        bytes memory data = abi.encodeWithSelector(IERC20.transfer.selector, recipient, amount);
        container.execute(address(token), 0, data, OP_CALL);
    }

    function _rollDay() internal {
        if (block.timestamp >= dayStart + 1 days) {
            dayStart = block.timestamp;
            spentToday = 0;
        }
    }
}
