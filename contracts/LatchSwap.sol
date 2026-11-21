// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {UniMath} from "./UniMath.sol";

interface IProcessorS {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
}

interface IERC20S {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IUniswapV3PoolS {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

interface IUniswapV3FactoryS {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

/// @dev Uniswap SwapRouter02 (no deadline field in its exactInputSingle params).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function factory() external view returns (address);
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @title LatchSwap
/// @notice A dip-buying vault. It holds `tokenIn` (USDT0). A gas-only keeper may call
///         `tick(amount)`; the vault then swaps `amount` of tokenIn for tokenOut (WOKB) on
///         one pinned Uniswap V3 pool and sends the output straight to `savings`.
///
///         What a stolen keeper key can do: buy at most `perTxCap` per call and `dailyCap`
///         per UTC day, only on the pinned pool, only while the pool's TWAP price of
///         tokenOut is at or below the owner's `maxPrice`, only with output >= TWAP quote
///         minus `maxSlippageBps`, and only into `savings`. Nothing else.
///
///         Two locks, both required, in the same transaction:
///           1. Solidity enforces every rule above.
///           2. The TapeOut circuit must allow the policy byte (STATICCALL; it can only deny).
///
///         Policy byte (same layout as LatchRelay, so circuit #1 = allow only 0x7e is reused):
///         bit 0 paused, 1 keeper, 2 recipient is savings (structural), 3 price ok (TWAP at or
///         below maxPrice AND spot within MAX_TICK_DEVIATION of the TWAP), 4 per-tx cap,
///         5 daily cap AND minInterval since the last buy, 6 vault covers amount + fee.
///
///         Price protection (see audit/swap/INDEPENDENT_REVIEW.md): TWAP over >= 30 min, spot
///         within ~1% of it, worst accepted fill price <= maxPrice, and minOut = TWAP quote net of
///         the pool fee, minus maxSlippageBps. The daily cap is per UTC calendar day, so up to
///         2x dailyCap can pass within seconds around midnight (accepted, documented).
///
///         Units: caps, fee, maxPrice are in tokenIn base units. maxPrice is tokenIn units
///         per one whole tokenOut (10 ** tokenOut.decimals()).
contract LatchSwap {
    uint256 public constant FEE_BPS = 100;
    uint256 public constant MAX_SLIPPAGE_BPS = 500; // hard ceiling on what the owner may allow
    /// @notice Spot may differ from the TWAP by at most this many ticks (~1%) for a buy.
    ///         Stops "inflate the TWAP, then pump spot" manipulation (review M-1).
    int24 public constant MAX_TICK_DEVIATION = 100;
    uint256 private constant DAY = 1 days;

    address public owner;
    address public pendingOwner;
    IProcessorS public immutable processor;
    uint256 public immutable circuitId;
    IERC20S public immutable tokenIn;
    IERC20S public immutable tokenOut;
    ISwapRouter02 public immutable router;
    address public immutable pool;
    uint24 public immutable poolFee;
    uint32 public immutable twapWindow;
    uint256 public immutable unit; // 10 ** tokenIn.decimals()
    uint128 public immutable outUnit; // 10 ** tokenOut.decimals()
    address public immutable savings;
    address public immutable treasury;
    uint256 public immutable activationFee;

    address public keeper;
    bool public paused;
    bool public armed;
    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public spentToday;
    uint256 public dayStart;
    uint256 public volumeSwept;
    /// @notice Total tokenOut delivered to savings by this vault (for the dashboard's average price).
    uint256 public totalBought;
    uint256 public buys;
    uint256 public maxPrice;
    uint256 public maxSlippageBps;
    /// @notice Minimum seconds between two buys. 0 = no spacing ("buy the dip"); 1 day or
    ///         1 week = "auto-DCA". Also limits how fast a stolen keeper key can spend.
    uint256 public minInterval;
    uint256 public lastBuyAt;
    uint256 public constant MAX_INTERVAL = 30 days;
    uint256 private locked;

    event Armed(address indexed payer, uint256 fee);
    event Bought(address indexed keeper, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 twapPrice, uint8 bits);
    event TierChanged(uint256 volumeSwept, uint256 feeBps);
    event CapsTightened(uint256 perTxCap, uint256 dailyCap);
    event KeeperSet(address indexed keeper);
    event PausedSet(bool paused);
    event MaxPriceSet(uint256 maxPrice);
    event SlippageSet(uint256 bps);
    event MinIntervalSet(uint256 secs);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
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
    error BadRecipient();
    error BadPool();
    error BadParam();
    error PriceTooHigh(uint256 twapPrice, uint256 maxPrice);
    error SwapShort(uint256 got, uint256 minOut);
    error SwapAccounting();
    error PriceUnstable();
    error TooSoon(uint256 nextBuyAt);

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

    struct Config {
        address owner; // address(0) = deployer
        address processor;
        uint256 circuitId;
        address tokenIn;
        address tokenOut;
        address router;
        address pool;
        address savings;
        address treasury;
        address keeper;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 activationFee;
        uint256 maxPrice;
        uint256 maxSlippageBps;
        uint32 twapWindow;
        uint256 minInterval;
    }

    // slither-disable-next-line cyclomatic-complexity (flat list of input checks)
    constructor(Config memory c) {
        if (
            c.processor == address(0) || c.tokenIn == address(0) || c.tokenOut == address(0)
                || c.router == address(0) || c.pool == address(0) || c.savings == address(0)
                || c.treasury == address(0) || c.keeper == address(0)
        ) revert ZeroAddress();
        if (c.perTxCap == 0 || c.dailyCap == 0 || c.perTxCap > c.dailyCap || c.dailyCap > type(uint128).max) revert OverCap();
        if (c.maxPrice == 0 || c.maxPrice > type(uint128).max || c.maxSlippageBps == 0 || c.maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadParam();
        if (c.twapWindow < 1800 || c.twapWindow > 7200) revert BadParam();
        if (c.minInterval > MAX_INTERVAL) revert BadParam();
        if (c.tokenIn == c.tokenOut) revert BadToken();
        // Output and fees must land somewhere they can come back from.
        if (
            _isSystem(c.savings, c) || _isSystem(c.treasury, c) || c.savings == address(this)
                || c.treasury == address(this) || uint160(c.savings) <= 0xff || uint160(c.treasury) <= 0xff
        ) revert BadRecipient();
        if (
            c.processor.code.length == 0 || c.tokenIn.code.length == 0 || c.tokenOut.code.length == 0
                || c.router.code.length == 0 || c.pool.code.length == 0
        ) revert BadPool();

        // The pinned pool must be the canonical pool the router itself would use.
        IUniswapV3PoolS p = IUniswapV3PoolS(c.pool);
        address t0 = p.token0();
        address t1 = p.token1();
        if (!((t0 == c.tokenIn && t1 == c.tokenOut) || (t0 == c.tokenOut && t1 == c.tokenIn))) revert BadPool();
        uint24 fee_ = p.fee();
        address factory = ISwapRouter02(c.router).factory();
        if (IUniswapV3FactoryS(factory).getPool(c.tokenIn, c.tokenOut, fee_) != c.pool) revert BadPool();

        uint8 decIn = IERC20S(c.tokenIn).decimals();
        uint8 decOut = IERC20S(c.tokenOut).decimals();
        if (decIn > 30 || decOut > 30) revert BadToken();

        // slither-disable-next-line missing-zero-check (zero falls back to the deployer)
        address owner_ = c.owner == address(0) ? msg.sender : c.owner;
        owner = owner_;
        processor = IProcessorS(c.processor);
        circuitId = c.circuitId;
        tokenIn = IERC20S(c.tokenIn);
        tokenOut = IERC20S(c.tokenOut);
        router = ISwapRouter02(c.router);
        pool = c.pool;
        poolFee = fee_;
        twapWindow = c.twapWindow;
        unit = 10 ** uint256(decIn);
        outUnit = uint128(10 ** uint256(decOut));
        savings = c.savings;
        treasury = c.treasury;
        keeper = c.keeper;
        perTxCap = c.perTxCap;
        dailyCap = c.dailyCap;
        activationFee = c.activationFee;
        maxPrice = c.maxPrice;
        maxSlippageBps = c.maxSlippageBps;
        minInterval = c.minInterval;
        // With no switch-on fee there is nothing to pay, so the vault starts switched on.
        if (c.activationFee == 0) {
            armed = true;
            emit Armed(owner_, 0);
        }
        emit OwnershipTransferred(address(0), owner_);
    }

    function _isSystem(address a, Config memory c) private pure returns (bool) {
        return a == c.tokenIn || a == c.tokenOut || a == c.processor || a == c.router || a == c.pool;
    }

    // ---------------------------------------------------------------- admin

    function transferOwnership(address next) external onlyOwner {
        if (next == address(0)) revert ZeroAddress();
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
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

    /// @notice Caps can only move down, so a stolen keeper key's ceiling never rises.
    function setCaps(uint256 perTxCap_, uint256 dailyCap_) external onlyOwner {
        if (perTxCap_ == 0 || dailyCap_ == 0 || perTxCap_ > dailyCap_) revert OverCap();
        if (perTxCap_ > perTxCap || dailyCap_ > dailyCap) revert CapRaised();
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        emit CapsTightened(perTxCap_, dailyCap_);
    }

    /// @notice The highest TWAP price at which the vault will buy. Owner-only; the keeper
    ///         can never change it.
    function setMaxPrice(uint256 next) external onlyOwner {
        if (next == 0 || next > type(uint128).max) revert BadParam();
        maxPrice = next;
        emit MaxPriceSet(next);
    }

    function setMaxSlippage(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > MAX_SLIPPAGE_BPS) revert BadParam();
        maxSlippageBps = bps;
        emit SlippageSet(bps);
    }

    function setMinInterval(uint256 secs) external onlyOwner {
        if (secs > MAX_INTERVAL) revert BadParam();
        minInterval = secs;
        emit MinIntervalSet(secs);
    }

    function arm() external onlyOwner nonReentrant {
        if (armed) revert AlreadyArmed();
        uint256 fee = activationFee;
        armed = true;
        if (fee > 0) {
            if (tokenIn.balanceOf(address(this)) < fee) revert UnderfundedActivation();
            _call(address(tokenIn), abi.encodeWithSelector(IERC20S.transfer.selector, treasury, fee));
        }
        emit Armed(msg.sender, fee);
    }

    /// @notice Owner rescue for ANY token held here (tokenIn, or anything sent by mistake).
    ///         Works paused, unarmed, with a broken processor or pool.
    ///         `amount = type(uint256).max` withdraws the full balance.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        uint256 bal = IERC20S(token).balanceOf(address(this));
        if (amount == type(uint256).max) amount = bal;
        // slither-disable-next-line incorrect-equality
        if (amount == 0 || amount > bal) revert Underfunded();
        _call(token, abi.encodeWithSelector(IERC20S.transfer.selector, to, amount));
        emit Withdrawn(token, to, amount);
    }

    // --------------------------------------------------------------- keeper

    /// @dev Balances are read before and compared after the external calls on purpose: the
    ///      vault trusts measured deltas, not return values. nonReentrant guards the whole call,
    ///      and every external target (tokenIn, tokenOut, router) is immutable and pinned.
    // slither-disable-next-line reentrancy-balance,cyclomatic-complexity
    function tick(uint256 amount) external nonReentrant {
        if (msg.sender != keeper) revert NotKeeper();
        if (!armed) revert NotArmed();
        if (paused) revert Paused();
        if (amount == 0 || amount > perTxCap) revert OverCap();
        if (_spentToday() + amount > dailyCap) revert OverCap();
        if (!_spacedOk()) revert TooSoon(lastBuyAt + minInterval);
        uint256 bps = feeBpsFor(volumeSwept);
        uint256 fee = (amount * bps) / 10_000;
        uint256 balBefore = tokenIn.balanceOf(address(this));
        if (balBefore < amount + fee) revert Underfunded();

        int24 twapTick = _twapTick();
        uint256 price = _priceAt(twapTick);
        if (price > maxPrice) revert PriceTooHigh(price, maxPrice);
        if (!_stable(twapTick)) revert PriceUnstable();

        uint8 bits = _bits(amount, true, _priceOk(twapTick, price));
        if (!_policy(bits)) revert CircuitDenied(bits);

        uint256 minOut = _minOut(twapTick, amount);
        if (minOut == 0) revert SwapShort(0, 0);
        // Worst accepted fill price must also respect maxPrice (review L-1).
        if (amount * outUnit > maxPrice * minOut) revert PriceTooHigh(amount * outUnit / minOut, maxPrice);

        _rollDay();
        spentToday += amount;
        volumeSwept += amount;
        lastBuyAt = block.timestamp;

        if (fee > 0) _call(address(tokenIn), abi.encodeWithSelector(IERC20S.transfer.selector, treasury, fee));

        uint256 outBefore = tokenOut.balanceOf(savings);
        _call(address(tokenIn), abi.encodeWithSelector(IERC20S.approve.selector, address(router), amount));
        // slither-disable-next-line unused-return (checked below against real balances)
        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: address(tokenIn),
                tokenOut: address(tokenOut),
                fee: poolFee,
                recipient: savings,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        _call(address(tokenIn), abi.encodeWithSelector(IERC20S.approve.selector, address(router), 0));

        // Trust balances, not return values.
        if (tokenIn.balanceOf(address(this)) != balBefore - fee - amount) revert SwapAccounting();
        uint256 got = tokenOut.balanceOf(savings) - outBefore;
        if (got < minOut) revert SwapShort(got, minOut);
        totalBought += got;
        buys += 1;

        emit Bought(msg.sender, amount, got, fee, price, bits);
        uint256 nextBps = feeBpsFor(volumeSwept);
        if (nextBps != bps) emit TierChanged(volumeSwept, nextBps);
    }

    // ----------------------------------------------------------------- views

    /// @notice The byte `tick` would build for this caller, and the verdict.
    function preview(uint256 amount) external view returns (uint8 bits, bool allow) {
        int24 t = _twapTick();
        bits = _bits(amount, msg.sender == keeper, _priceOk(t, _priceAt(t)));
        if (!armed || paused || msg.sender != keeper) return (bits, false);
        if ((bits & 0x78) != 0x78) return (bits, false);
        allow = _policy(bits);
    }

    /// @notice TWAP price (tokenIn units per whole tokenOut), expected output and the minimum
    ///         the vault would accept for `amount`.
    function quote(uint256 amount) external view returns (uint256 twapPrice, uint256 expectedOut, uint256 minOut) {
        int24 t = _twapTick();
        twapPrice = _priceAt(t);
        if (amount > type(uint128).max) revert BadParam();
        expectedOut = UniMath.getQuoteAtTick(t, uint128(amount), address(tokenIn), address(tokenOut));
        minOut = _minOut(t, amount);
    }

    /// @notice Current pool tick and TWAP tick, so consoles can show the stability check.
    // slither-disable-next-line unused-return (only the current tick is needed)
    function ticks() external view returns (int24 spotTick, int24 twapTick_) {
        (, spotTick,,,,,) = IUniswapV3PoolS(pool).slot0();
        twapTick_ = _twapTick();
    }

    function circuitAllows(uint8 bits) external view returns (bool) {
        return _policy(bits);
    }

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
        token_ = address(tokenIn);
        armed_ = armed;
        paused_ = paused;
        balance_ = tokenIn.balanceOf(address(this));
        perTxCap_ = perTxCap;
        dailyCap_ = dailyCap;
        spentToday_ = _spentToday();
        keeper_ = keeper;
        savings_ = savings;
        treasury_ = treasury;
    }

    function feeBpsNow() external view returns (uint256) {
        return feeBpsFor(volumeSwept);
    }

    function feeBpsFor(uint256 swept) public view returns (uint256) {
        if (swept >= 20_000 * unit) return 25;
        if (swept >= 5_000 * unit) return 50;
        if (swept >= 1_000 * unit) return 75;
        return FEE_BPS;
    }

    // -------------------------------------------------------------- internal

    /// @dev Arithmetic-mean tick over `twapWindow`, rounded to negative infinity
    ///      (OracleLibrary.consult). Reverts if the pool lacks that much history.
    function _twapTick() internal view returns (int24 t) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;
        // slither-disable-next-line unused-return (only tick cumulatives are needed)
        (int56[] memory cum,) = IUniswapV3PoolS(pool).observe(ago);
        int56 delta = cum[1] - cum[0];
        int56 w = int56(uint56(twapWindow));
        t = int24(delta / w);
        if (delta < 0 && (delta % w != 0)) t--;
    }

    /// @dev tokenIn units for one whole tokenOut at `t`.
    function _priceAt(int24 t) internal view returns (uint256) {
        return UniMath.getQuoteAtTick(t, outUnit, address(tokenOut), address(tokenIn));
    }

    /// @dev TWAP quote net of the pool's LP fee, minus the owner's slippage budget (review L-2).
    function _minOut(int24 t, uint256 amount) internal view returns (uint256) {
        uint256 q = UniMath.getQuoteAtTick(t, uint128(amount), address(tokenIn), address(tokenOut));
        return (q * (1_000_000 - uint256(poolFee)) * (10_000 - maxSlippageBps)) / 10_000_000_000;
    }

    // slither-disable-next-line timestamp,incorrect-equality (0 = never bought; spacing is minutes-to-days)
    function _spacedOk() internal view returns (bool) {
        return lastBuyAt == 0 || block.timestamp >= lastBuyAt + minInterval;
    }

    /// @notice When the next buy is allowed by the spacing rule (0 = now).
    // slither-disable-next-line timestamp,incorrect-equality
    function nextBuyAt() external view returns (uint256) {
        if (lastBuyAt == 0) return 0;
        return lastBuyAt + minInterval;
    }

    // slither-disable-next-line unused-return (only the current tick is needed)
    function _stable(int24 twapTick) internal view returns (bool) {
        (, int24 spot,,,,,) = IUniswapV3PoolS(pool).slot0();
        int256 d = int256(spot) - int256(twapTick);
        if (d < 0) d = -d;
        return d <= int256(MAX_TICK_DEVIATION);
    }

    function _priceOk(int24 t, uint256 price) internal view returns (bool) {
        return price <= maxPrice && _stable(t);
    }

    // slither-disable-next-line timestamp (UTC-day and spacing rules, documented)
    function _bits(uint256 amount, bool keeperOk, bool priceOk) internal view returns (uint8 bits) {
        uint256 fee = (amount * feeBpsFor(volumeSwept)) / 10_000;
        if (paused) bits |= 1;
        if (keeperOk) bits |= 2;
        bits |= 4;
        if (priceOk) bits |= 8;
        if (amount > 0 && amount <= perTxCap) bits |= 16;
        if (_spentToday() + amount <= dailyCap && _spacedOk()) bits |= 32;
        if (tokenIn.balanceOf(address(this)) >= amount + fee) bits |= 64;
    }

    function _policy(uint8 bits) internal view returns (bool) {
        bytes memory out = processor.eval(circuitId, abi.encodePacked(bits));
        if (out.length == 0) revert BadEval();
        return (uint8(out[0]) & 1) == 1;
    }

    /// @dev Token call accepting empty return (non-standard) or a single `true`; bubbles reverts.
    // slither-disable-next-line low-level-calls,assembly
    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) {
            if (ret.length > 0) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            revert TransferFailed();
        }
        // slither-disable-next-line incorrect-equality
        if (ret.length == 0) {
            if (token.code.length == 0) revert TransferFailed();
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

    // slither-disable-next-line divide-before-multiply,timestamp
    function _rollDay() internal {
        uint256 start = (block.timestamp / DAY) * DAY;
        if (start != dayStart) {
            dayStart = start;
            spentToday = 0;
        }
    }
}
