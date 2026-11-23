# Independent review: LatchVault (v2) + LatchFactory2, Nov 2026

Scope: `contracts/LatchVault.sol`, `contracts/LatchFactory2.sol`, with `UniMath.sol` treated as trusted and `circuits/circuit2.py` used as the chip spec. I read the code by hand and ran the existing suite (`audit/v2/vault.test.mjs`: 45/45 pass). I also wrote scratch proof-of-concept tests (only under `/tmp/poc`) against the same official Uniswap V3 factory, pool and SwapRouter02 bytecode and the same TAP-02 processor stand-in. No files in the repo were changed apart from this report.

## Summary

I found no way for the keeper, the factory admin, an outside attacker or another vault owner to move a vault's funds anywhere except the owner's `savings` and the pinned `treasury`. I also found no way for any of them to raise a cap or trade outside the TWAP limit. Clone initialisation is atomic and the implementation is locked. The BUY/SELL price and limit logic is correct in both units (USDT0 has 6 decimals, WOKB has 18). The daily-cap rollover, fee maths, reentrancy guard and balance-delta checks are also correct.

There is one Medium finding: `preview()` and `tick()` disagree in a normal market situation. When spot moves against the trade by more than the slippage budget but less than the 200-tick stability bound, `preview()` says "trade" but `tick()` always reverts inside the router, after the full swap has run. The other findings are Low: bounded value leaks and gas economics. None blocks deployment with small balances, but M-1 and L-1 have one-line fixes and are worth making first.

| ID | Sev | Title |
|---|---|---|
| M-1 | Medium | `preview()` says trade but `tick()` always reverts when spot is 100–200 ticks against the trade |
| L-1 | Low | The worst-fill rule is enforced only through the chip, not "regardless of the circuit" |
| L-2 | Low | MEV or a stolen keeper can extract about 3% per trade relative to the true spot price |
| L-3 | Low | The hosted bot's gas: two identical `eval`s per tick, and cheap checks run after the expensive ones (owner race costs about 490k gas) |
| L-4 | Low | At the 0.25% fee tier, a minimum-size trade may not pay for its own gas |
| I-1…I-9 | Info | Fake clones, hosted-key rotation, UTC-midnight doubling, fee not inside the limit, oracle cardinality, blocklists, savings sinks, dead code, deploy-time checks |

---

## M-1: `preview()` and `tick()` disagree when spot moves against the trade by more than the slippage budget

**Location:** `LatchVault._plan` (the `priceOk` term, L473-474), `_minOut` (L528-532), `tick` (L379-389).

**What happens:** `minOut` is the TWAP quote less the pool fee less `maxSlippageBps` (pinned at 100 bps, about 100 ticks). `priceOk` only requires `|spot - twap| <= 200` ticks. If the spot price is worse than the TWAP for this vault's direction by more than about 100 ticks, the swap returns less than `minOut` and SwapRouter02 reverts with "Too little received". The cases are spot above the TWAP for a BUY, or spot below it for a SELL. `preview()` never looks at spot except through the volatility bucket, so in that band it still reports `amount > 0` and an allowed input word.

Plain and dip-only modes do not pause in volatility bucket 3, so they sit in this state for the whole 100–200 tick band. Smart and ladder modes in bucket 2 (60–120 ticks) hit it from about 100 ticks. In a trending market this band is the normal state: the 30-minute TWAP lags, so spot runs ahead of it by 1–2% for many minutes.

**PoC (`/tmp/poc/poc.test.mjs`), plain BUY vault, 2 USDT0 per trade:**
- Spot at TWAP +95 ticks: `preview` gives an amount of 2 USDT0, and `tick` succeeds.
- Spot at TWAP +110 ticks or +149 ticks: `preview` still gives 2 USDT0, but `tick` reverts in the router.
- Sending the reverting tick anyway cost **761,679 gas** (the whole swap ran, then rolled back).
- A plain SELL vault at TWAP −149 ticks behaves the same way.

**Impact:** The "preview == tick" property that v2 is supposed to keep is broken. The UI shows "will buy" while nothing can trade. A bot that sends when `preview` allows burns about 760k gas per attempt, every loop, for as long as the market stays in the band. `estimateGas` catches this, but only if the bot never skips it, for example when retrying or under a fixed gas limit. An attacker can also push spot into the band on purpose to stall a vault, at their own swap cost.

**Fix:** Add a spot-side check to `priceOk` in `_plan`, so `preview` and `tick` stay in agreement:
```solidity
uint256 atSpot = UniMath.getQuoteAtTick(spot, uint128(want), tokenIn, tokenOut) * (1_000_000 - poolFee) / 1_000_000;
priceOk = priceOk && atSpot >= mo;
```
An equivalent fix is to make the stability bound direction-aware: adverse deviation must stay below the slippage in ticks minus the fee, while favourable deviation can stay at 200 or less (but see L-2). Price impact on large trades can still cause a revert, so the bot must keep using `estimateGas`, and it should back off on a vault after a revert.

---

## L-1: The worst-fill rule (and the strategy mode) depends on the processor

**Location:** `tick` (L355-364) compared with `_plan` (L473-474) and the contract header (L68-71).

The header says "worst accepted fill inside `limitPrice`" is a hard rule "enforced in Solidity regardless of the circuit". `tick` re-checks the TWAP limit, the stability bound, spacing, caps and balance on its own. It does **not** re-check `_fillOk(amount, minOut)` or `minOut > 0`. Those two facts only reach the decision through input bit 3, which the chip is trusted to veto. The `kk != kGuess` comparison does not help: a processor that answers "allow" to every input returns the same `k` to both calls.

**PoC:** I used a processor that always returns `0x07` (allow, k = 3), simulating an upgraded or broken TapeOut processor or a re-taped circuit #2. The test processor's `tape()` has no access control. The vault was dip-only, with OKB above `refPrice` and `limitPrice` at 80.2:
- `preview` showed bit 3 = 0, yet `tick` traded at **3x**.
- The worst accepted price was **80.85 per OKB, against a limit of 80.2**.
- Dip-only was ignored as well.

**Impact:** Losses are bounded, because the caps, the TWAP limit and the 2% stability rule still hold. Beyond those bounds, everything the user chose (mode, depth multiplier, the worst-fill rule) relies on the processor's integrity and on its upgrade admin.

**Fix:** In `tick`, after `_plan`, add:
```solidity
if (minOut == 0 || !_fillOk(amount, minOut)) revert PriceOutside(price, limitPrice);
```
Also add the M-1 spot check here if you adopt it. Separately, before launch, confirm on chain that circuit #2 cannot be re-taped, and find out who can upgrade the processor. Document that the mode semantics rest on that trust.

---

## L-2: Bounded sandwich extraction relative to the true spot price, about 3% per trade

**Location:** `MAX_TICK_DEVIATION = 200`, `_minOut` (TWAP-based).

`minOut` protects against losses measured against the TWAP, not against the current price. Suppose the market really is about 190 ticks better than the lagging TWAP for this vault. An attacker can then push spot against the vault up to about TWAP + 80 ticks, which still passes the stability rule and `minOut`. The vault buys, and the attacker swaps back. Two parties can do this:
- Any searcher who can order transactions around the bot's tx.
- A stolen keeper key, which needs no ordering luck: it sends front-run, `tick`, back-run as three transactions in sequence.

**PoC, 200 USDT0 plain BUY:**
- The honest spot price was 78.51.
- The vault paid **80.85 per OKB, 2.98% worse**.
- The attacker netted about **+4.4 USDT0** on the 200 USDT0 trade.

**Bound:** about (200 ticks + slippage + pool fee) ≈ 3% of each trade's size. That adds up to at most about 3% of `dailyCap` per day. This is within the owner's rules (keeper "timing only"), but users should be told about it.

**Fix (choose one or more):**
- Lower `MAX_TICK_DEVIATION`, for example to 100 or to the slippage expressed in ticks. This also shrinks the M-1 band.
- Pin a smaller slippage, for example 50 bps.
- Have the hosted bot submit through a private or sequencer-direct endpoint.

---

## L-3: The hosted bot's gas: two `eval`s per tick, and cheap checks run late

**Location:** `_plan` (L462, L486), `tick` (L361-367).

Each `tick` runs `processor.eval` twice. On the TAP-02 stand-in I measured:

| Call | Gas |
|---|---|
| `chip()` | 242k |
| `preview()` | 478k |
| successful `tick` | 750k |

The second `eval` is either identical to the first (all safety bits pass, so `inputs == base | 0x7e`, and `eval` is a view, so the result is the same) or a guaranteed denial. Reusing the first result whenever `inputs == base | 0x7e` saves about 240k gas, roughly 32% of a tick. Gate the second `eval` behind `inputs != base | 0x7e` (where amount is 0 anyway), or call it only in `preview`, for display.

The balance, daily-cap and minimum-size checks are also only reached after both `eval`s. An owner who races a `withdraw` (or a `setStrategy` lowering caps) between the bot's simulation and inclusion makes the bot pay **490,539 gas** for a `ChipSaysNo` revert (measured). This is a griefing ratio of about 10:1 for the owner's tx cost. Pause is checked early and is cheap.

**Fix:** Add cheap early exits in `tick` before `_plan`:
- tokenIn balance ≥ `minAmount` plus its fee
- `_spentToday() + minAmount <= dailyCap`

On the bot side, back off on a vault after any reverted tick.

---

## L-4: Fee versus gas economics at the low end

**Location:** `feeBpsNow`, `minBuy` / `minSell`.

A minimum trade (1 USDT0) pays 0.01 USDT0 at 1% and 0.0025 USDT0 at the 0.25% tier. At about 750k gas per tick, the break-even gas price is roughly `fee_usd / 750_000 / okb_usd`:
- At 1%: about 0.13 gwei, with OKB at $100.
- At 0.25%: about 0.03 gwei, with OKB at $100.

An owner who has reached the 0.25% tier can set `baseAmount = minAmount` and `minInterval = 0`, so the bot ticks often for fees below its gas cost. This is the dust-drain class again, now driven by the fee tier. I could not query X Layer's live gas price from the sandbox.

**Fix:** In the bot, skip any tick where the fee's value is below its gas cost times a margin. Alternatively, add a per-trade minimum fee, or require `baseAmount * bps` to stay above a floor.

---

## Informational

- **I-1: Fake vaults.** Anyone can make an EIP-1167 clone of `implementation` outside the factory and call `initialize` with their own processor, router or factory, `guardian = 0` and `keeper = hostedKeeper`. The runtime code is identical to a real vault. The hosted bot must only service addresses where `factory.isVault(v)` is true, taken from `VaultCreated` or `vaultsPage`, and must cap the gas limit. Separately, mass-created empty factory vaults slow the bot's polling. Filter on the tokenIn balance (with a cheap multicall) before calling `preview`.
- **I-2: Hosted-key rotation strands existing vaults.** `keeper` is stored per vault, and `setHostedKeeper` only affects new vaults. If the hosted key is stolen and revoked, every existing hosted vault stops until its owner calls `setKeeper`. Funds stay safe. Plan the UI flow and the notifications for this.
- **I-3: UTC-day window.** With a small `minInterval`, a keeper can spend `dailyCap` at 23:59 and again at 00:00. That is 2× `dailyCap` within minutes, which is expected for a calendar-day cap.
- **I-4: The limit excludes the Latch fee.** `_fillOk` measures the price per OKB without the fee, so a BUY's all-in cost can be up to `limitPrice × (1 + bps)`. State this in the UI.
- **I-5: Oracle cardinality.** `observe([1800, 0])` reverts with `OLD` if the pool (`0xe3BE…5082`) keeps fewer observations than the number of swap-blocks in 30 minutes. Every `preview` and `tick` would then revert (liveness only; withdraw is unaffected). Check `slot0().observationCardinality` and, if needed, call `increaseObservationCardinalityNext` before launch. I could not reach the RPC from the sandbox.
- **I-6: USDT0 blocklist.** `treasury` cannot be changed per vault: if it is blocklisted, every BUY tick fails. If a SELL vault's `savings` is blocklisted, its ticks fail. `withdraw` still works in both cases.
- **I-7: Savings sinks that are not rejected.** The implementation address, the Uniswap factory, and any contract with no way to move tokens out are accepted as `savings`, and `savings` cannot be changed later. The front end should require an EOA, or warn loudly. The magic router recipients 1 and 2, the tokens, the pool, the router, the processor, the vault itself, the factory, the hosted bot, the keeper, the treasury and other vaults are all correctly rejected.
- **I-8: Dead or no-op code.**
  - `kk != kGuess` can never be true with a deterministic processor.
  - Input bit 2 is always 1.
  - `inUnit` and `factory` are written but never read.
  - `SwapShort` and `Underfunded` in `tick` cannot be reached (the router and bit 6 enforce them first). They are fine as defence in depth.
  - `_vaultsOf` is not updated when a vault's ownership is transferred.
  - The `circuit2.py` docstring says depth bucket 1 is "~2.5%", but the contract uses (0, 5%).
- **I-9: Deploy-time checks.** The `LatchFactory2` constructor does not validate `minBuy` / `minSell` > 0, `twapWindow`, or `slippageBps`. Bad values make every `createVault` revert, so funds are not at risk, but assert them in the deploy script.

## Checked and found correct

- **Clone initialisation.** The implementation's constructor sets `initialized = true`. `createVault` clones and initialises in the same transaction. A second `initialize` reverts. `guardian` and the pins come from the factory.
- **Units.** `_priceAt` gives USDT0 base units per 1e18 wei of WOKB. `_fillOk` is correct in both directions:
  - BUY: `amountIn * 1e18 <= limit * minOut`
  - SELL: `minOut * 1e18 >= limit * amountIn`

  `_minOut` returns tokenOut units, with the pool fee and slippage applied over a 1e10 denominator. TWAP rounding matches `OracleLibrary.consult`. Same-block manipulation cannot move `observe(0)` (the first swap in a block writes the observation using the pre-swap tick).
- **Depth and volatility buckets.** These match the spec and `circuit2.py`: depth thresholds of 5/10/15/20/30/40% in the owner's favour, volatility at <25/<60/<120 ticks, and a hard limit of 200. Manipulating spot can only lower `k` (through the volatility bucket), never raise it.
- **kGuess logic.** When `allow` is true the final input word equals `base | 0x7e`, so `k` always matches the size used. `want` is capped by `perTxCap`, the rest of the daily cap, and the balance (with fee) through `afford`. `want + floor(want*bps/1e4) <= balance` always holds.
- **Daily cap.** `_spentToday` is checked before `_rollDay` and stays consistent with it.
- **Fees.** The fee is charged on top of the amount, in tokenIn, to the pinned treasury, before the swap, all in one atomic transaction. Fee tiers come from `volumeQuote`, which only real trades increase. SELL trades are valued at the TWAP, so `refPrice` cannot game the tier.
- **Overflow.** Prices and caps are bounded at `uint128`, so every product (amount × 1e18, limit × minOut, q × 1e10, amount × price) fits in `uint256` for any reachable pool tick.
- **Reentrancy and accounting.** `nonReentrant` covers `tick` and `withdraw`. `eval` is a staticcall. The tokens and router are pinned and have no hooks. The exact tokenIn delta and the measured `savings` delta are both checked. The approval is reset to 0.
- **Powers.**
  - The keeper can only call `tick()`, which takes no arguments.
  - The factory admin can only revoke or un-revoke keepers and choose the bot for new vaults (DoS at most). A malicious admin could point new vaults at their own bot, which gets L-2-level power only.
  - Caps can only go down. `withdraw` works when paused and with a broken processor or pool.

## PoC runs (`/tmp/poc/poc.test.mjs`)

```
A  plain BUY, spot TWAP+149t: preview 2 USDT0, tick reverts (router min-out); sent anyway: 761,679 gas, reverted
A  TWAP+110t: preview 2 USDT0, tick reverts      TWAP+95t: preview 2 USDT0, tick OK
B  plain SELL, spot TWAP-149t: preview >0, tick reverts
D  chip() 242,261 · preview() 477,935 · tick 749,658 · tick after owner withdraw race: 490,539 (reverted)
C  always-allow processor: inputs 0x1076 (bit3=0), k=3, dip-only above ref -> traded; worst accepted 80.85 vs limit 80.2
G  honest spot 78.51, attacker front-run to TWAP+79t: vault paid 80.85 (+2.98%), attacker +4.4 USDT0 on 200
```

---

## Fixes applied after this review (builder's response)

| Finding | Fix | Proof |
|---|---|---|
| M-1 preview/tick disagree in trending markets | `_plan` now also requires the pool's *current* price (net of the LP fee) to give at least `minOut` (`_spotOk`); hard deviation bound cut from 200 to 100 ticks, which is inside the 1% slippage budget | new test "trending ~0.9% against a buy: preview and tick agree / the trade goes through" |
| L-1 worst-fill rule only enforced via the chip | `tick` re-checks `minOut > 0 && _fillOk(amount, minOut)` in Solidity, whatever the circuit says | code path in `tick` |
| L-2 sandwich bound ≈3% | `MAX_TICK_DEVIATION` 200 → 100 ticks (≈1%); volatility buckets rescaled to <15 / <35 / <60 / ≥60 ticks | tests "jumpy ~0.45%", "very jumpy ~0.8%", "beyond 1%" |
| L-3 hosted bot gas | one chip call per trade instead of two (a failed safety fact is a "no" for every input, verified exhaustively); cheap balance and daily-limit checks before any chip call | rehearsal trade gas 874k → 697k; "3rd buy same day refused early (OverCap)" |
| L-4 tiny trades vs gas | X Layer base fee ≈0.02 gwei: a 700k-gas trade costs ≈0.000014 OKB, below the 0.01 USDT0 fee of a 1 USDT0 trade at the 1% tier. The bot will skip vaults whose fee would not cover gas | bot update |
| Info: bot must only serve factory vaults, cap gas, back off after a revert | bot update (v2 vaults are listed from `LatchFactory2.vaultsPage`, so only `isVault` vaults are ever served) | bot tests |

Suite: 47/47 on official Uniswap V3 + SwapRouter02 bytecode. Slither: only intentional `== 0` checks remain, annotated.
