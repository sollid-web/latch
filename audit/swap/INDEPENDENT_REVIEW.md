# LatchSwap: independent security review

Scope: `contracts/LatchSwap.sol` and `contracts/UniMath.sol`, as they are in the working tree today.
The reviewer did not see the contracts being written. Contracts were **not** modified.

Evidence: `audit/swap/extra.test.mjs` (new). It uses `RefMath076.sol`, which holds the original Uniswap libraries compiled with solc **0.7.6**, and `ExtraHelpers.sol`. It runs on anvil with the real UniswapV3Factory, UniswapV3Pool and SwapRouter02 bytecode.

```
cd audit/swap && ANVIL=/tmp/fdry/anvil SOLC076=/tmp/solc076/node_modules/solc node extra.test.mjs
```
(solc 0.7.6 came from `npm i solc@0.7.6` in /tmp/solc076.) Result: ALL PASS. Lines marked `FINDING` print the measured behaviour behind the issues below. The existing `swap.test.mjs` also still passes.

Threat-model goal under review: *a stolen keeper key can only buy within caps, at TWAP price <= maxPrice, with output >= TWAP quote minus slippage, only into savings.*

**Verdict:** that goal, as written, is enforced. No Critical or High issue was found. Funds cannot be sent anywhere except `savings`, and the caps hold. However, the goal itself is weaker than "the vault never overpays the market". M-1 and L-1 describe how far the real price paid can drift.

---

## Findings

### M-1: The only price protection is the pool's own TWAP and `maxPrice`. The pool's TWAP can be manipulated, so the vault can be made to pay up to ~maxPrice x (1 + slippage), whatever the real market price is.

* **Where:** `tick()`. `price = _priceAt(_twapTick())`, the check `price <= maxPrice`, and `minOut` from the TWAP quote.
* **Scenario (test B3):** the real market is 40 USDT0/OKB and `maxPrice` is 48. An attacker moves the pinned pool to 47.3 and keeps it there for one `twapWindow` (600 s). The vault, called by a stolen keeper (or by the honest keeper, see below), buys at **47.45 USDT0/OKB, +18.6 % over market**. The attacker gets most of that overpayment back on the reverse swap.
* **Cheaper variant, pools with liquidity gaps (test B5):** on a concentrated pool with no liquidity outside about 35-46, a dust swap jumps the price to the extreme tick. About 4 s there, then a swap back, moved the 600 s TWAP from **40.0 to 70-149** (it varies with block timing), at a round-trip cost of about $9. Moving the arithmetic-mean tick costs time multiplied by tick distance, and out-of-range ticks are free. So on thin X Layer pools "TWAP" alone is weak protection. The attacker can tune the excursion so the TWAP lands just under `maxPrice`.
* **Honest keeper also exposed:** `keeper-worker` triggers on CEX prices being ≤ threshold, then asks `preview`. It never compares the pool's TWAP or spot with the CEX price. A third party who sees the CEX dip can inflate the pool TWAP to about `maxPrice` and pump spot just before the cron runs (once a minute, so the timing is predictable). The vault then buys at the inflated price.
* **Bound:** the most lost per day is about `dailyCap x (maxPrice x (1+maxSlippageBps)/market − 1)`. With today's caps (preflight 1/3 USDT0, live relay 2/6) this is cents. It grows linearly with the caps and with the gap between `maxPrice` and market.
* **Fix (combine):**
  1. Add a spot-vs-TWAP check: read `slot0().tick` and require `|spotTick − twapTick| <= maxDeviationTicks` (for example 50-100). This stops the "TWAP inflated, spot pumped" pattern.
  2. Use a longer window, at least 1800 s. Raise the constructor minimum from 60 s, which is too short for a thin L2 pool.
  3. Optionally set a floor on the harmonic-mean liquidity from `observe`'s `secondsPerLiquidity`. This refuses pools that are too thin to give a reliable TWAP.
  4. Off-chain: the keeper should refuse to act when the pool TWAP or spot differs from the CEX median by more than x %.
  5. Keep `maxPrice` close to the intended dip level, not a loose ceiling.

### L-1: The execution price can be above `maxPrice`.
* **Scenario (test B4):** the TWAP is 47.9 (≤ max 48) and spot is pumped to 49.9. `tick` succeeds with an effective price of **50.06 USDT0/OKB**. The `maxPrice` check uses the TWAP, while the fill may be up to `maxSlippageBps` (≤ 5 %) worse.
* **Fix:** also require that the worst accepted price is within the cap, i.e. `amount * outUnit <= maxPrice * minOut`. Alternatively, raise `minOut` to `max(minOut, amount*outUnit/maxPrice)`. If neither is done, document that maxPrice is a TWAP bound, not a fill bound.

### L-2: `maxSlippageBps` is measured against a quote that does not include the pool fee. If slippage ≤ fee tier, every buy reverts while `preview` reports `allow=true`.
* `expectedOut` is the fee-free TWAP quote, but the swap pays the pool fee (0.3 % on the default 3000 tier, 1 % on 10000). **Test B7:** with slippage 25 bps on a 0.3 % pool, `preview → (0x7e, true)` but `tick → "Too little received"` every time. The keeper burns gas each minute.
* Even when the setting works, the effective tolerance is only `slippage − fee`. The default of 150 bps on a 0.3 % pool gives 1.2 %.
* **Fix:** in the constructor and in `setMaxSlippage`, require `maxSlippageBps > poolFee/100 + margin`. Alternatively, compute `minOut` from `expectedOut * (1e6 − poolFee) / 1e6` and apply slippage on top of that. Document that `preview` does not simulate the swap.

### L-3: Short observation history lets anyone block buys (fails closed).
* With observation cardinality 1 (the default for a new pool), any swap that moves the tick makes `observe([twapWindow,0])` revert `OLD` for the next `twapWindow` seconds. **Test B8:** `tick` is OK before; after one dust swap that moves the tick, it reverts `OLD` and `preview` reverts too. A griefer repeating this every window blocks buys indefinitely. Funds are not at risk, and `withdraw` still works.
* **Fix (operational):** before arming, call `pool.increaseObservationCardinalityNext(n)` (permissionless) with `n ≥ twapWindow / avg seconds between tick-moving swaps`. For a busy pool with 1 s blocks, n ≈ twapWindow. Then wait until the ring buffer has filled. Make `preflight-swap.sh` check `slot0().observationCardinality` and fail if it is too low. I could not check the live pool's cardinality: X Layer RPC was not reachable from the audit sandbox.

### L-4: The fixed UTC-day window allows 2x `dailyCap` within seconds.
* **Test B6:** a buy of 100 at 23:59:58 plus a buy of 100 at 00:00:01, with `dailyCap = 100`. This is expected with calendar windows, but the "daily cap" a stolen key can spend in a burst is really 2x.
* **Fix (if it matters):** use a rolling 24 h window or a token bucket. At minimum, document it.

### I-1: The constructor's "canonical pool" check trusts `router.factory()`.
* **Test B10:** a fake router whose `factory()` points to a fake factory that vouches for a fake pool is accepted. The check proves only that the pool is consistent with the router that was supplied, not that the router is the real SwapRouter02. The owner is trusted, so this is a deploy-time typo or phishing risk only.
* **Fix:** in the deploy script, assert `router == 0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca`, `router.factory() == 0x4B2ab38DBF28D31D467aA8993f6c2585981D6804`, and that the bytecode hashes match the known ones. Or hard-code both as constants for chain 196.

### I-2: `savings` may be set to `address(1)` / `address(2)`.
SwapRouter02 maps these to `MSG_SENDER` / `ADDRESS_THIS`. The constructor accepts them, but every `tick` reverts `SwapShort` because the savings balance does not change. No funds are lost (test B11). Consider rejecting addresses below 0x10.

### I-3: `preview` is not a full simulation.
It ignores the slippage feasibility (L-2), the `minOut == 0` dust case, and router or pool reverts. It also reverts outright (it does not return `false`) when the pool lacks history. The keeper treats `allow=true` as a green light, so these show up as reverted txs (gas only). `quote` uses exactly the same `_twapTick`, `_priceAt` and `getQuoteAtTick` path as `tick`, so the two are consistent.

### I-4: The processor is immutable.
If the TapeOut processor or circuit #1 is changed, paused or broken, `tick` reverts (`BadEval`/`CircuitDenied`/bubbled revert). Because the call is a STATICCALL and the result is only ANDed with the Solidity checks, the processor can only deny, never widen permissions. `withdraw` does not touch it, so funds are always recoverable.

### I-5: Fees.
The fee is charged on top of `amount` and is not counted against `dailyCap`. A stolen key can therefore send up to `dailyCap x 1 %` per day to `treasury`. On mainnet `treasury == owner`, so in practice this is harmless. Dust amounts (< 100 base units) pay a fee of 0 (test B12). Harmless.

### I-6: Ownership.
`pendingOwner` cannot be cleared, only overwritten. A pending transfer to a wrong address stays live until it is overwritten. Consider allowing `transferOwnership(address(0))` to cancel.

### I-7: TWAP rounding.
The mean tick is floored toward −∞ (matching OracleLibrary). In the mainnet ordering (USDT0 0x779D… is token0 < WOKB 0xe538…), the tick is token1/token0, so OKB price ∝ 1.0001^(−tick). Flooring rounds the OKB price *up*, which is conservative for `maxPrice`. It also makes `expectedOut` and `minOut` ≤ 1 bp lower, which is negligible. In the reverse ordering the error is at most 1 tick in the other direction.

---

## Verified correct

* **UniMath port, line by line:**
  * All 20 `getSqrtRatioAtTick` constants are byte-identical to v3-core 1.0.1 (checked mechanically).
  * MAX_TICK is 887272. The `absTick` computation and the `uint256(int256(...))` casts are equivalent.
  * `unchecked` covers every statement that relies on 0.7 wrap-around: the FullMath `-denominator` → `0 - denominator`, the Newton iterations, and `prod1 * twos`. The ratio products cannot overflow anyway, since ratio ≤ 2^128 and the constants are < 2^128.
  * The round-up on `>>32` is unchanged.
  * `getQuoteAtTick` branches and argument order are identical.
* **Differential fuzz against the 0.7.6 originals:**
  * 1,200 ticks (all bit patterns, ±MAX, ±1, random) are identical. MIN and MAX give MIN_SQRT_RATIO and MAX_SQRT_RATIO. ±887273 reverts in both.
  * 2,400 `getQuoteAtTick` cases (bases 0, 1, 2^128−1 and random, both token orders, including revert-equivalence at overflow) are identical.
  * 157 `mulDiv` cases are identical to FullMath and to exact `floor(a*b/d)`, including the same reverts (d=0, overflow).
* **TWAP:** the vault's `_twapTick` equals OracleLibrary.consult's tick in 12 samples. These covered both token orderings, negative ticks, and an odd 607 s window so that `delta % w != 0`, which exercises the round-down. The `int56(uint56(twapWindow))` cast and the `int24` narrowing are safe.
* **Price direction and decimals:** `_priceAt` (base = 10^decOut of tokenOut, quoted in tokenIn) and `expectedOut` (base = amount of tokenIn) are both correct for either ordering. 40 USDT0 → ~1 WOKB in both orderings (B2). `outUnit` ≤ 1e30 fits uint128, and `amount ≤ perTxCap ≤ dailyCap ≤ 2^128−1` makes the `uint128` cast safe.
* **Same-block manipulation:** a pump in the same block as `tick` does not move the TWAP (Uniswap writes observations with the pre-swap tick). The buy reverts on slippage (B9, and the existing sandwich test).
* **Recipient:** `recipient` is hard-wired to immutable `savings`. Output is measured as a `savings` balance delta ≥ `minOut`. The vault never holds tokenOut.
* **Approvals:** exact-amount approval, reset to 0 after the swap. The router uses `msg.sender` as payer, so no third party can use the allowance. USDT-style "approve from non-zero" is handled by the reset.
* **Accounting:** the strict equality `balAfter == balBefore − fee − amount` catches partial fills (the router does not check that all input was consumed when the price limit is 0 and liquidity runs out), fee-on-transfer upgrades of USDT0, and any unexpected pull. All of these fail closed.
* **Reentrancy:** `tick`, `arm` and `withdraw` are `nonReentrant`. All external targets are immutable and the tokens have no hooks. State (spent, volume) is updated before the external calls, and the whole call reverts atomically on failure.
* **Caps and day logic:** the order `_spentToday` check → `_rollDay` → add is consistent. Caps can only be lowered. `perTxCap ≤ dailyCap` is enforced in the constructor and in `setCaps`.
* **Permissions:** the keeper can call only `tick`. Everything else is `onlyOwner`. The keeper cannot change price, slippage, caps, keeper, pause or the recipient. Ownership transfer is two-step.
* **Policy gate:** `eval` is declared `view` (STATICCALL). Bits are built from the same state the Solidity checks use, the result is ANDed, and an empty return reverts. The processor can only deny.
* **Withdraw:** works paused, unarmed, and with a broken processor or pool. It handles `type(uint256).max`. Calls to non-standard tokens (empty return) are handled with a code-length check.
* **Constructor:** zero addresses and code presence are checked. The pool's tokens must match exactly. The pool must equal `factory.getPool(tokenIn, tokenOut, pool.fee())` (subject to I-1). Recipients cannot be system contracts or the vault. Slippage is limited to 5 %, the window to 60-3600 s, and decimals to ≤ 30.
* **Short history:** pools with too little history make `tick`, `quote` and `preview` revert. The vault fails closed (existing test plus B8).

---

## Resolution (LatchSwap v2, applied after this review)

| Finding | Status | Change | Covered by `swap.test.mjs` |
|---|---|---|---|
| M-1 TWAP-only price protection | **Fixed (on-chain part)** | Spot must be within `MAX_TICK_DEVIATION` = 100 ticks (~1%) of the TWAP, otherwise `PriceUnstable`; the check also feeds policy bit 3. TWAP window minimum raised from 60 s to **1800 s** (max 7200). Mainnet pool chosen: the **0.05% USDT0/WOKB pool** `0xe3BE…5082` (deepest: ~22.5k USDT0 + ~1,000 WOKB, observation cardinality 2048). | "spot 10% above TWAP: refused (PriceUnstable)", "preview agrees: bit 3 off while unstable" |
| M-1 off-chain part | **Fixed in keeper** | The helper bot refuses to buy when the pool's TWAP differs from the exchange median by more than 2%. | keeper-worker tests |
| M-1 residual | **Accepted** | A pool held at a manipulated-but-steady price for 30+ min (spot = TWAP) is not detectable on chain without an external oracle. Bounded by `maxPrice` and the caps (1 USDT0 per buy, 3 per day at launch). |  |
| L-1 fill above maxPrice | **Fixed** | `amount * outUnit <= maxPrice * minOut` required. | "TWAP under max but worst fill above max: refused" |
| L-2 slippage vs pool fee | **Fixed** | `minOut` = TWAP quote × (1 − poolFee) × (1 − slippage). | "slippage 0.25% on a 0.3% pool: buy works (fee netted)" |
| L-3 short observation history | **Fixed (operational)** | `preflight-swap.sh` and `golive-swap.sh` refuse a pool with observation cardinality < 100. The chosen pool has 2048. | script checks |
| L-4 UTC day 2× burst | **Accepted, documented** in the contract header. |  |  |
| I-1 router trust | **Fixed (deploy script)** | `golive-swap.sh` asserts router `0x4f0c…9bca`, `router.factory()` `0x4B2a…6804`, and `factory.getPool(...)` before deploying. |  |
| I-2 savings = address(1)/(2) | **Fixed** | Savings/treasury ≤ `0xff` rejected. | "savings = address(1) is refused" |
| I-3 preview not a simulation | **Accepted** | The keeper also runs `eth_estimateGas` before sending, which simulates the swap. |  |
