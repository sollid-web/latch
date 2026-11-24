// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity ^0.8.24;

import {UniMath} from "./UniMath.sol";

interface IProc {
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
}

interface IERC20V {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

interface IPoolV {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function fee() external view returns (uint24);
    function slot0() external view returns (uint160, int24 tick, uint16, uint16, uint16, uint8, bool);
    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory, uint160[] memory);
}

interface IFactoryV3 {
    function getPool(address a, address b, uint24 fee) external view returns (address);
}

interface IRouterV {
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
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256);
}

interface IGuardianV {
    function revoked(address keeper) external view returns (bool);
}

/// @title LatchVault (v2)
/// @notice One vault per user, created as a minimal-proxy clone by LatchFactory2. Two directions:
///         BUY  — holds USDT0, buys WOKB (OKB) on dips or on a schedule;
///         SELL — holds WOKB, takes profit into USDT0 as the price rises.
///         The output always goes straight to the owner's chosen `savings` wallet.
///
///         Strategy chip (TapeOut circuit #2): the vault computes 16 input bits and the circuit
///         returns allow + a size multiplier k (0..3). The trade size is `baseAmount * k`, capped
///         by the per-trade and daily limits. Inputs (LSB first):
///           0-6   safety facts, must be 0x7e: bit0 paused, 1 keeper, 2 savings (structural),
///                 3 price ok (limit, stability, worst fill), 4 per-trade cap, 5 daily cap + spacing,
///                 6 vault covers amount + fee
///           7-9   depth: how far the 30-min average has moved in the owner's favour vs `refPrice`
///                 (BUY: below it, SELL: above it): 0 none, 1 <5%, 2 5-10%, 3 10-15%, 4 15-20%,
///                 5 20-30%, 6 30-40%, 7 >=40%
///           10-11 volatility: |spot - TWAP| 0 <15 ticks, 1 <35, 2 <60, 3 >=60 (hard stop at 100)
///           12-13 mode: 0 plain (every time), 1 dip/rise-only, 2 smart, 3 ladder
///           14-15 reserved, 0
///         Output byte: bit0 allow, bit1 k0, bit2 k1.
///
///         Hard rules enforced in Solidity regardless of the circuit: only the keeper (not revoked by
///         the guardian), never above per-trade/daily caps, never more often than `minInterval`,
///         only on the pinned pool, TWAP at/inside `limitPrice`, spot within MAX_TICK_DEVIATION of
///         the TWAP, worst accepted fill inside `limitPrice` (re-checked in tick), the current pool price
///         good enough for the worst accepted fill (so a 'yes' from preview is a trade that can succeed),
///         output only to `savings`.
///         Prices are always USDT0 base units per 1 whole OKB.
contract LatchVault {
    uint8 public constant BUY = 0;
    uint8 public constant SELL = 1;
    uint256 public constant MAX_SLIPPAGE_BPS = 500;
    int24 public constant MAX_TICK_DEVIATION = 100; // ~1%: beyond this nobody trades
    uint256 public constant MAX_INTERVAL = 30 days;
    uint256 private constant DAY = 1 days;

    // ---- set once by initialize (clone pattern: no immutables) ----
    bool public initialized;
    address public factory;
    IProc public processor;
    uint256 public circuitId;
    IRouterV public router;
    address public pool;
    uint24 public poolFee;
    uint32 public twapWindow;
    address public quoteToken; // USDT0
    address public baseToken; // WOKB
    uint8 public direction;
    address public tokenIn;
    address public tokenOut;
    uint256 public baseUnit; // 10 ** baseToken.decimals()
    uint256 public inUnit; // 10 ** tokenIn.decimals()
    uint256 public quoteUnit; // 10 ** quoteToken.decimals()
    address public savings;
    address public treasury;
    uint256 public minAmount;
    IGuardianV public guardian;
    uint8 public mode;

    // ---- owner-controlled ----
    address public owner;
    address public pendingOwner;
    address public keeper;
    bool public paused;
    uint256 public baseAmount;
    uint256 public perTxCap;
    uint256 public dailyCap;
    uint256 public refPrice;
    uint256 public limitPrice;
    uint256 public minInterval;
    uint256 public maxSlippageBps;

    // ---- accounting ----
    uint256 public spentToday;
    uint256 public dayStart;
    uint256 public lastTradeAt;
    uint256 public volumeIn; // in tokenIn units
    uint256 public volumeQuote; // in USDT0, valued at the average price of each trade (drives fee tiers)
    uint256 public totalOut;
    uint256 public trades;
    uint256 private locked;

    struct Init {
        address owner;
        address processor;
        uint256 circuitId;
        address router;
        address pool;
        uint32 twapWindow;
        address quoteToken;
        address baseToken;
        uint8 direction;
        uint8 mode;
        address savings;
        address treasury;
        address keeper;
        address guardian;
        uint256 minAmount;
        uint256 baseAmount;
        uint256 perTxCap;
        uint256 dailyCap;
        uint256 refPrice;
        uint256 limitPrice;
        uint256 minInterval;
        uint256 maxSlippageBps;
    }

    event Traded(
        address indexed keeper,
        uint8 direction,
        uint256 amountIn,
        uint256 amountOut,
        uint256 fee,
        uint256 twapPrice,
        uint16 inputs,
        uint8 multiplier
    );
    event Settings(uint256 baseAmount, uint256 perTxCap, uint256 dailyCap, uint256 refPrice, uint256 limitPrice, uint256 minInterval, uint8 mode);
    event KeeperSet(address indexed keeper);
    event PausedSet(bool paused);
    event SlippageSet(uint256 bps);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed from, address indexed to);
    event OwnershipTransferred(address indexed from, address indexed to);

    error NotOwner();
    error NotKeeper();
    error Paused();
    error OverCap();
    error Underfunded();
    error TransferFailed();
    error ZeroAddress();
    error CapRaised();
    error Reentered();
    error BadRecipient();
    error BadPool();
    error BadParam();
    error AlreadyInitialized();
    error PriceOutside(uint256 twapPrice, uint256 limitPrice);
    error PriceUnstable();
    error TooSoon(uint256 nextAt);
    error ChipSaysNo(uint16 inputs);
    error BadEval();
    error SwapShort(uint256 got, uint256 minOut);
    error SwapAccounting();

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

    /// @dev The implementation contract itself can never be initialised or used.
    constructor() {
        initialized = true;
    }

    // slither-disable-next-line cyclomatic-complexity (flat list of input checks)
    function initialize(Init calldata c) external {
        if (initialized) revert AlreadyInitialized();
        initialized = true;
        if (
            c.owner == address(0) || c.processor == address(0) || c.router == address(0) || c.pool == address(0)
                || c.quoteToken == address(0) || c.baseToken == address(0) || c.savings == address(0)
                || c.treasury == address(0) || c.keeper == address(0)
        ) revert ZeroAddress();
        if (c.direction > SELL || c.mode > 3) revert BadParam();
        if (c.twapWindow < 1800 || c.twapWindow > 7200) revert BadParam();
        if (c.maxSlippageBps == 0 || c.maxSlippageBps > MAX_SLIPPAGE_BPS) revert BadParam();
        if (c.minInterval > MAX_INTERVAL) revert BadParam();
        if (c.refPrice == 0 || c.limitPrice == 0 || c.refPrice > type(uint128).max || c.limitPrice > type(uint128).max) {
            revert BadParam();
        }
        if (
            c.minAmount == 0 || c.baseAmount < c.minAmount || c.perTxCap < c.baseAmount || c.dailyCap < c.perTxCap
                || c.dailyCap > type(uint128).max
        ) revert OverCap();
        if (
            c.savings == c.quoteToken || c.savings == c.baseToken || c.savings == c.pool || c.savings == c.router
                || c.savings == c.processor || c.savings == address(this) || uint160(c.savings) <= 0xff
        ) revert BadRecipient();

        IPoolV p = IPoolV(c.pool);
        address t0 = p.token0();
        address t1 = p.token1();
        if (!((t0 == c.quoteToken && t1 == c.baseToken) || (t0 == c.baseToken && t1 == c.quoteToken))) revert BadPool();
        uint24 fee_ = p.fee();
        if (IFactoryV3(IRouterV(c.router).factory()).getPool(c.quoteToken, c.baseToken, fee_) != c.pool) revert BadPool();

        factory = msg.sender;
        owner = c.owner;
        processor = IProc(c.processor);
        circuitId = c.circuitId;
        router = IRouterV(c.router);
        pool = c.pool;
        poolFee = fee_;
        twapWindow = c.twapWindow;
        quoteToken = c.quoteToken;
        baseToken = c.baseToken;
        direction = c.direction;
        (tokenIn, tokenOut) = c.direction == BUY ? (c.quoteToken, c.baseToken) : (c.baseToken, c.quoteToken);
        baseUnit = 10 ** uint256(IERC20V(c.baseToken).decimals());
        inUnit = 10 ** uint256(IERC20V(tokenIn).decimals());
        quoteUnit = 10 ** uint256(IERC20V(c.quoteToken).decimals());
        savings = c.savings;
        treasury = c.treasury;
        keeper = c.keeper;
        guardian = IGuardianV(c.guardian);
        minAmount = c.minAmount;
        mode = c.mode;
        baseAmount = c.baseAmount;
        perTxCap = c.perTxCap;
        dailyCap = c.dailyCap;
        refPrice = c.refPrice;
        limitPrice = c.limitPrice;
        minInterval = c.minInterval;
        maxSlippageBps = c.maxSlippageBps;
        emit OwnershipTransferred(address(0), c.owner);
        emit KeeperSet(c.keeper);
        emit Settings(c.baseAmount, c.perTxCap, c.dailyCap, c.refPrice, c.limitPrice, c.minInterval, c.mode);
    }

    // ------------------------------------------------------------------ owner

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

    /// @notice Strategy settings. Limits (per-trade, daily) can only go DOWN, so a stolen keeper's
    ///         ceiling never rises; base amount, prices, spacing and mode are the owner's to change.
    function setStrategy(
        uint256 baseAmount_,
        uint256 perTxCap_,
        uint256 dailyCap_,
        uint256 refPrice_,
        uint256 limitPrice_,
        uint256 minInterval_,
        uint8 mode_
    ) external onlyOwner {
        if (perTxCap_ > perTxCap || dailyCap_ > dailyCap) revert CapRaised();
        if (baseAmount_ < minAmount || perTxCap_ < baseAmount_ || dailyCap_ < perTxCap_) revert OverCap();
        if (refPrice_ == 0 || limitPrice_ == 0 || refPrice_ > type(uint128).max || limitPrice_ > type(uint128).max) {
            revert BadParam();
        }
        if (minInterval_ > MAX_INTERVAL || mode_ > 3) revert BadParam();
        baseAmount = baseAmount_;
        perTxCap = perTxCap_;
        dailyCap = dailyCap_;
        refPrice = refPrice_;
        limitPrice = limitPrice_;
        minInterval = minInterval_;
        mode = mode_;
        emit Settings(baseAmount_, perTxCap_, dailyCap_, refPrice_, limitPrice_, minInterval_, mode_);
    }

    function setMaxSlippage(uint256 bps) external onlyOwner {
        if (bps == 0 || bps > MAX_SLIPPAGE_BPS) revert BadParam();
        maxSlippageBps = bps;
        emit SlippageSet(bps);
    }

    /// @notice Owner rescue for ANY token here. Works paused, with a broken pool or processor.
    ///         `amount = type(uint256).max` withdraws the full balance.
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || token == address(0)) revert ZeroAddress();
        uint256 bal = IERC20V(token).balanceOf(address(this));
        if (amount == type(uint256).max) amount = bal;
        // slither-disable-next-line incorrect-equality
        if (amount == 0 || amount > bal) revert Underfunded();
        _call(token, abi.encodeWithSelector(IERC20V.transfer.selector, to, amount));
        emit Withdrawn(token, to, amount);
    }

    // ----------------------------------------------------------------- keeper

    /// @notice Trade now if the chip allows. The size is decided on chain: baseAmount x k, capped.
    /// @dev Balances are read before and compared after the external calls on purpose (measured
    ///      deltas, not return values). nonReentrant guards everything; all targets are pinned.
    // slither-disable-next-line reentrancy-balance,reentrancy-benign,reentrancy-events,cyclomatic-complexity
    function tick() external nonReentrant {
        if (msg.sender != keeper || _revoked(msg.sender)) revert NotKeeper();
        if (paused) revert Paused();
        if (!_spacedOk()) revert TooSoon(lastTradeAt + minInterval);
        // cheap checks first, so an emptied or maxed-out vault costs the bot as little as possible
        if (IERC20V(tokenIn).balanceOf(address(this)) < minAmount) revert Underfunded();
        if (_spentToday() + minAmount > dailyCap) revert OverCap();

        int24 t = _twapTick();
        uint256 price = _priceAt(t);
        if (direction == BUY ? price > limitPrice : price < limitPrice) revert PriceOutside(price, limitPrice);
        int24 spot = _spotTick();
        if (_absDiff(spot, t) > uint256(int256(MAX_TICK_DEVIATION))) revert PriceUnstable();

        (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut) = _plan(msg.sender, t, spot);
        // slither-disable-next-line incorrect-equality (0 = the chip said no)
        if (amount == 0) revert ChipSaysNo(inputs);
        if (amount < minAmount || amount > perTxCap || _spentToday() + amount > dailyCap) revert OverCap();
        // hard rule, independent of the circuit: the worst accepted fill respects the owner's limit
        // slither-disable-next-line incorrect-equality (0 = no quote)
        if (minOut == 0 || !_fillOk(amount, minOut)) revert PriceOutside(price, limitPrice);

        uint256 balBefore = IERC20V(tokenIn).balanceOf(address(this));
        if (balBefore < amount + fee) revert Underfunded();

        _rollDay();
        spentToday += amount;
        volumeIn += amount;
        volumeQuote += direction == BUY ? amount : (amount * price) / baseUnit;
        lastTradeAt = block.timestamp;

        if (fee > 0) _call(tokenIn, abi.encodeWithSelector(IERC20V.transfer.selector, treasury, fee));
        uint256 outBefore = IERC20V(tokenOut).balanceOf(savings);
        _call(tokenIn, abi.encodeWithSelector(IERC20V.approve.selector, address(router), amount));
        // slither-disable-next-line unused-return (checked below against real balances)
        router.exactInputSingle(
            IRouterV.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: poolFee,
                recipient: savings,
                amountIn: amount,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        _call(tokenIn, abi.encodeWithSelector(IERC20V.approve.selector, address(router), 0));

        if (IERC20V(tokenIn).balanceOf(address(this)) != balBefore - fee - amount) revert SwapAccounting();
        uint256 got = IERC20V(tokenOut).balanceOf(savings) - outBefore;
        if (got < minOut) revert SwapShort(got, minOut);
        totalOut += got;
        trades += 1;
        emit Traded(msg.sender, direction, amount, got, fee, price, inputs, k);
    }

    // ------------------------------------------------------------------ views

    /// @notice Exactly what tick() would do for `caller` right now (no state change):
    ///         the 16 chip inputs, the multiplier, the amount (0 = no trade) and the worst output accepted.
    function preview(address caller)
        external
        view
        returns (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut, uint256 avgPrice)
    {
        int24 t = _twapTick();
        avgPrice = _priceAt(t);
        (inputs, k, amount, fee, minOut) = _plan(caller, t, _spotTick());
        if (paused || caller != keeper || _revoked(caller)) amount = 0;
    }

    /// @notice Ask the chip directly about any 16-bit input (for the website's explorer).
    function chip(uint16 inputs) external view returns (bool allow, uint8 k) {
        return _chip(inputs);
    }

    function twapPrice() external view returns (uint256) {
        return _priceAt(_twapTick());
    }

    // slither-disable-next-line incorrect-equality,timestamp (0 = never traded)
    function nextTradeAt() external view returns (uint256) {
        if (lastTradeAt == 0) return 0;
        uint256 n = lastTradeAt + minInterval;
        return n <= block.timestamp ? 0 : n;
    }

    function spentTodayNow() external view returns (uint256) {
        return _spentToday();
    }

    /// @notice 1% until 1,000 USDT0 traded, then 0.75%, 0.5% from 5,000, 0.25% from 20,000.
    function feeBpsNow() public view returns (uint256) {
        uint256 v = volumeQuote;
        uint256 u = quoteUnit;
        if (v >= 20_000 * u) return 25;
        if (v >= 5_000 * u) return 50;
        if (v >= 1_000 * u) return 75;
        return 100;
    }

    // --------------------------------------------------------------- internal

    /// @dev Builds the chip inputs for a would-be trade, asks the chip, sizes the trade.
    ///      Split into small steps (market → size → safety facts → chip) so it compiles without via-IR,
    ///      which lets every explorer verify the source. Same logic, same order as before.
    function _plan(address caller, int24 t, int24 spot)
        internal
        view
        returns (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut)
    {
        uint16 base = _market(t, spot);
        // Candidate size: k from the chip assuming the size-dependent facts pass, then verify them.
        (bool allowGuess, uint8 kGuess) = _chip(base | 0x7e);
        (amount, fee) = _size(kGuess);
        uint16 s;
        (s, minOut) = _safety(caller, t, spot, amount, fee);
        inputs = base | s;

        // One chip call per trade: if every safety fact holds, the inputs are exactly the ones already asked
        // about. If any fact fails, the circuit's answer is "no" for every such input (verified exhaustively),
        // so there is nothing to ask.
        if (inputs != (base | 0x7e)) return (inputs, 0, 0, 0, 0);
        // slither-disable-next-line incorrect-equality (k = 0 means "no trade")
        if (!allowGuess || kGuess == 0) return (inputs, kGuess, 0, 0, 0);
        k = kGuess;
    }

    /// @dev The facts that do not depend on the size: move vs reference, volatility, strategy.
    function _market(int24 t, int24 spot) internal view returns (uint16 base) {
        uint256 vol = _absDiff(spot, t);
        uint16 volBucket = vol < 15 ? 0 : vol < 35 ? 1 : vol < 60 ? 2 : 3;
        base = (_depth(_priceAt(t)) << 7) | (volBucket << 10) | (uint16(mode) << 12);
    }

    /// @dev baseAmount x k, capped by the per-trade limit, what is left today and what the vault can pay (with fee).
    // slither-disable-next-line timestamp (daily window)
    function _size(uint8 k) internal view returns (uint256 want, uint256 f) {
        want = baseAmount * k;
        if (want > perTxCap) want = perTxCap;
        uint256 spent = _spentToday();
        uint256 left = dailyCap > spent ? dailyCap - spent : 0;
        if (want > left) want = left;
        uint256 bps = feeBpsNow();
        uint256 afford = (IERC20V(tokenIn).balanceOf(address(this)) * 10_000) / (10_000 + bps);
        if (want > afford) want = afford;
        f = (want * bps) / 10_000;
    }

    /// @dev The 7 safety facts (bits 0-6) for a trade of `want` (+ fee `f`), and the worst output accepted.
    // slither-disable-next-line timestamp,incorrect-equality (daily window + spacing; 0 = no trade)
    function _safety(address caller, int24 t, int24 spot, uint256 want, uint256 f)
        internal
        view
        returns (uint16 s, uint256 mo)
    {
        mo = want == 0 ? 0 : _minOut(t, want);
        if (paused) s |= 1;
        if (caller == keeper && !_revoked(caller)) s |= 2;
        s |= 4;
        if (_priceOk(t, spot, want, mo)) s |= 8;
        if (want >= minAmount && want <= perTxCap) s |= 16;
        if (_spentToday() + want <= dailyCap && _spacedOk() && want > 0) s |= 32;
        if (IERC20V(tokenIn).balanceOf(address(this)) >= want + f && want > 0) s |= 64;
    }

    /// @dev Average inside the owner's limit, market stable, worst fill inside the limit, live price good enough.
    function _priceOk(int24 t, int24 spot, uint256 want, uint256 mo) internal view returns (bool) {
        uint256 price = _priceAt(t);
        return (direction == BUY ? price <= limitPrice : price >= limitPrice)
            && _absDiff(spot, t) <= uint256(int256(MAX_TICK_DEVIATION)) && mo > 0 && _fillOk(want, mo) && _spotOk(spot, want, mo);
    }

    function _chip(uint16 inputs) internal view returns (bool allow, uint8 k) {
        bytes memory out = processor.eval(circuitId, abi.encodePacked(uint8(inputs & 0xff), uint8(inputs >> 8)));
        if (out.length == 0) revert BadEval();
        uint8 o = uint8(out[0]);
        allow = (o & 1) == 1;
        k = allow ? (o >> 1) & 3 : 0;
    }

    /// @dev How far the TWAP has moved in the owner's favour vs refPrice, as a 3-bit bucket.
    function _depth(uint256 price) internal view returns (uint16) {
        uint256 ref = refPrice;
        uint256 moveBps;
        if (direction == BUY) {
            if (price >= ref) return 0;
            moveBps = ((ref - price) * 10_000) / ref;
        } else {
            if (price <= ref) return 0;
            moveBps = ((price - ref) * 10_000) / ref;
        }
        if (moveBps < 500) return 1;
        if (moveBps < 1000) return 2;
        if (moveBps < 1500) return 3;
        if (moveBps < 2000) return 4;
        if (moveBps < 3000) return 5;
        if (moveBps < 4000) return 6;
        return 7;
    }

    /// @dev Worst accepted fill must respect limitPrice (USDT0 per 1 OKB).
    function _fillOk(uint256 amountIn, uint256 minOut) internal view returns (bool) {
        if (direction == BUY) return amountIn * baseUnit <= limitPrice * minOut; // paid per OKB <= limit
        return minOut * baseUnit >= limitPrice * amountIn; // received per OKB >= limit
    }

    /// @dev The pool's current price must already give at least the worst accepted output (before price
    ///      impact), otherwise the swap would certainly fail. Keeps preview() honest in trending markets.
    function _spotOk(int24 spot, uint256 amount, uint256 minOut) internal view returns (bool) {
        if (amount > type(uint128).max) return false;
        uint256 q = UniMath.getQuoteAtTick(spot, uint128(amount), tokenIn, tokenOut);
        return (q * (1_000_000 - uint256(poolFee))) / 1_000_000 >= minOut;
    }

    /// @dev TWAP quote, net of the pool's LP fee, minus the owner's slippage budget.
    function _minOut(int24 t, uint256 amount) internal view returns (uint256) {
        if (amount > type(uint128).max) return 0;
        uint256 q = UniMath.getQuoteAtTick(t, uint128(amount), tokenIn, tokenOut);
        return (q * (1_000_000 - uint256(poolFee)) * (10_000 - maxSlippageBps)) / 10_000_000_000;
    }

    /// @dev USDT0 base units per one whole OKB at tick `t`.
    function _priceAt(int24 t) internal view returns (uint256) {
        return UniMath.getQuoteAtTick(t, uint128(baseUnit), baseToken, quoteToken);
    }

    function _twapTick() internal view returns (int24 t) {
        uint32[] memory ago = new uint32[](2);
        ago[0] = twapWindow;
        ago[1] = 0;
        // slither-disable-next-line unused-return (only tick cumulatives are needed)
        (int56[] memory cum,) = IPoolV(pool).observe(ago);
        int56 delta = cum[1] - cum[0];
        int56 w = int56(uint56(twapWindow));
        t = int24(delta / w);
        if (delta < 0 && (delta % w != 0)) t--;
    }

    // slither-disable-next-line unused-return (only the current tick is needed)
    function _spotTick() internal view returns (int24 spot) {
        (, spot,,,,,) = IPoolV(pool).slot0();
    }

    function _absDiff(int24 a, int24 b) internal pure returns (uint256) {
        int256 d = int256(a) - int256(b);
        return uint256(d < 0 ? -d : d);
    }

    function _revoked(address k) internal view returns (bool) {
        return address(guardian) != address(0) && guardian.revoked(k);
    }

    // slither-disable-next-line timestamp,incorrect-equality (0 = never traded; spacing is minutes-to-days)
    function _spacedOk() internal view returns (bool) {
        return lastTradeAt == 0 || block.timestamp >= lastTradeAt + minInterval;
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
}
