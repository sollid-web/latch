# LatchSwap v3 + LatchFactory: independent security review

Scope: `contracts/LatchSwap.sol` (v3: `minInterval`/`lastBuyAt`, `owner` in Config, auto-arm when
`activationFee == 0`, `setMinInterval`, `nextBuyAt`) and `contracts/LatchFactory.sol` (new).
UniMath was not re-reviewed (already checked byte-for-byte). `keeper-worker/src/keeper.js` was
read because the threat model is about griefing the hosted keeper. Contracts were **not** modified.

Evidence: `audit/swap/factory.review.test.mjs` (new). It reuses the `swap.test.mjs` harness
(real UniswapV3Factory/Pool/SwapRouter02 bytecode on anvil), on a mainnet-like **0.05 % pool,
~20k USDT0 deep, factory slippage 100 bps, TWAP 1800 s**.

```
cd audit/swap && ANVIL=/tmp/fdry/anvil node factory.review.test.mjs     # ALL PASS (lines marked FINDING = measurements)
cd audit/swap && ANVIL=/tmp/fdry/anvil node swap.test.mjs               # still ALL PASS
```

**Verdict.** I found no way for anyone except a vault's owner to move its USDT0 or redirect its
output. That includes the factory admin, the hosted keeper (honest or stolen), other users and pool
manipulators. During `tick` no user-controlled code runs: tokens, router, pool and processor are
pinned, and WOKB transfers don't call the recipient. So a malicious vault cannot run code against
the keeper. The serious problems are **economic and availability** problems for the shared hosted
keeper (H-1), and incident response when the hosted key is stolen (M-1).

---

## H-1: Anyone can take over the hosted keeper and drain its gas for almost nothing (dust vaults + list order)

* **Contract side:**
  * Nothing sets a minimum buy size. A `perTxCap` of **100 base units (0.0001 USDT0)** buys fine. 1 and 10 units revert in the router.
  * `minInterval = 0` is allowed.
  * Vault creation is free and unlimited.
  * The 1 % fee on a dust buy is 1 base unit and goes to the treasury, not to the keeper.
* **Keeper side:**
  * `vaultsPage(0, MAX_VAULTS=200)` only ever looks at the **first 200 vaults ever created**.
  * Vaults are handled in creation order, with `MAX_SENDS_PER_RUN = 5`.
* **Scenario (test C1):** right after the factory goes live, an attacker creates 5 vaults with `perTxCap = 100`, a huge `dailyCap` and `maxPrice`, and `minInterval = 0`. Each vault is funded with 1 USDT0.
  * Every minute, all 5 pass `preview` and `estimateGas` and are actually sent.
  * Measured: **5 one-per-minute buys all succeed, average 257k gas per tick, total fee 5 base units**.
  * That is about 7,200 successful txs/day paid from the keeper's OKB. Every real vault gets `later` ("per-run send limit") forever.
  * The attacker's real cost is about the pool fee + 1 % on 0.0001 USDT0 per tick. They also get the WOKB back.
* **Related:**
  * Organically, vault #201 onward is **never served** (no pagination).
  * 200 vaults × 3–5 RPC reads each is close to Cloudflare's per-invocation subrequest limit.
  * The public `GET /` dry-run repeats the whole scan, plus 5 exchange APIs, for any visitor. That is an amplification lever against the shared RPC and exchange rate limits.
  * Cron runs can overlap because each send waits up to 90 s for a receipt. Two runs can then tick the same vault: one reverts and costs gas.
* **Fix:**
  * **(contract)** Add an immutable `minAmount`, set by the factory (e.g. 1 USDT0), enforced in `tick` (`amount >= minAmount`) and in `setCaps` (`perTxCap_ >= minAmount`). A factory-only check is not enough: test C2 shows an owner can later `setCaps(1, …)` and `setMinInterval(0)`.
  * Optionally make the fee floor cover gas: `fee >= minFee`.
  * **(keeper)**
    * Page through all vaults.
    * Rotate the starting offset each run, or order by "oldest last bought".
    * Allow at most one hosted send per vault per N minutes, or per owner.
    * Skip amounts below a USD threshold.
    * Rate-limit or cache `GET /`.
    * Add a run lock (KV / Durable Object) so runs don't overlap.

## M-1: A stolen hosted key exposes every vault, and nobody can revoke it centrally

* `factory.setHostedKeeper` only changes the default for **new** vaults (test A5). If the key in the Worker leaks, every hosted vault stays exposed until each owner calls `setKeeper` or `setPaused` themselves. Many owners won't notice.
* **What the thief can do, per vault, until owners react:**
  * **(a)** Buy at the worst allowed moment. Spot can be up to 100 ticks off the TWAP, and the fill up to fee + slippage worse. The loss is bounded, about 1 % per buy.
  * **(b)** Run the v1 M-1 residual **across all vaults at once**: hold the pool at an inflated, steady price for 30 min (spot = TWAP, so `_stable` passes). Then fill every vault's `dailyCap` (2× around UTC midnight for `minInterval = 0` vaults) up to each owner's `maxPrice`.
    * DCA users are likely to set a loose `maxPrice` (the tests use 1000).
    * The thief's profit grows with the sum of all daily caps, while the cost of the manipulation is fixed. So once the factory is popular, a 30-min manipulation of a ~20k pool pays.
  * **(c)** Tick 100 units on every DCA vault to use up its spacing slot. With `minInterval` up to 30 days, real buys are blocked for up to a month. The thief does this with the stolen key's own OKB.
* The admin is semi-trusted, and the design deliberately avoids giving the admin keeper powers. That is good, but it leaves no incident switch.
* **Fix (any one):**
  * **(1)** A deny-only `hostedPaused` flag on the factory, read by vaults whose keeper is the hosted sentinel. The admin could then only *stop* buys.
  * **(2)** Store `keeper = HOSTED` (a sentinel) and resolve it via `factory.hostedKeeper()` in `tick`. This lets the admin rotate a leaked key. It gives the admin exactly the hosted key's (bounded) power, which the users already trust.
* **Also:**
  * Keep the keeper's OKB float small.
  * Have the UI warn when `maxPrice` is far above the market.
  * Consider a factory-level upper bound on `perTxCap` and `dailyCap` for hosted vaults.

## M-2: `preview` says allow but `tick` reverts (keeper or agent gas, misleading UI)

`preview` leaves out three things `tick` does, so it can return `(0x7e, true)` while `tick` reverts.

| Case | Test | Revert | Gas burnt if sent |
|---|---|---|---|
| `maxPrice` between TWAP and about TWAP/((1−poolFee)(1−slippage)), i.e. within ~1.05 % above the TWAP. The worst-fill check `amount*outUnit > maxPrice*minOut` is not in `preview` | B1, fuzz F: **26 of 72 random cases** | `PriceTooHigh` | 137,692 |
| `amount` too large for the pool's depth (3,000 USDT0 on ~20k) | B2 | router "Too little received" (late) | 366,177 |
| Owner sets slippage to 1 bp: any spot drift fails | B3b | router (late) | 357,043 |

* The first case is not only a griefing tool. **Every honest dip-buyer** whose ceiling is just above the current TWAP hits it: the dashboard shows "ready" and the bot "would buy", but it never buys. The real ceiling is about `maxPrice / 1.0105`.
* The hosted keeper's `estimateGas` currently stops these from costing gas. But they cost RPC calls every minute and are mislabeled ("swap would fail"). Users' own bots and AI agents that trust `preview` (the documented API) burn 140k–370k gas per try.
* A malicious user can park capital in a B2-type vault at no cost, since they can always withdraw it.
* **Remaining gas risk for the hosted keeper:** a state change between `estimateGas` and inclusion. An owner can front-run with `setPaused` / `withdraw` / `setMaxPrice` at about 1:1 gas cost. A pool move hits all vaults at once (B3b at low slippage).
* With the factory's 100 bps slippage, the 100-tick band and `minOut` happen to line up (B3a: spot 0.98 % off still fills). Lower slippage breaks that.
* **Fix:**
  * Put the worst-fill check (and `minOut != 0`) into `preview`, clearing bit 3. This is one line, reusing `_minOut`.
  * Have the UI and docs present `maxPrice` as a fill price.
  * Set a floor on `setMaxSlippage` of about `MAX_TICK_DEVIATION` (~100 bps) for factory vaults, or document the interaction.
  * Keeper: after a failed simulation, back off per vault with growing intervals.
  * Keeper: size `amount` with a quoter (or binary-search with `eth_call`).

## L-1: Unsafe `savings` destinations are accepted

* These destinations are accepted:
  * `savings = factory` (D1/D7: the buy succeeds and the WOKB is **stuck forever**, because the factory has no rescue function)
  * `savings = UniswapV3Factory` (stuck)
  * `savings = hostedKeeper` (the operator's hot wallet now holds user value, which makes theft more attractive)
  * `savings = treasury`
  * `savings = another vault` (D8: recoverable only by *that* vault's owner)
* None of this harms anyone except the creator, and none of it can make `tick` revert: WOKB has no hooks, and measuring the balance delta is correct for any recipient (D9).
* A contract recipient that can't move ERC-20s would also strand funds.
* **Fix:** in `createVault`, reject `savings ∈ {address(this), hostedKeeper, keeper, treasury}` and `isVault[savings]`. In the UI, default to `msg.sender` and warn when the address has code.

## L-2: Factory "pinned" settings are only initial values

* Owners can change slippage afterwards (`setMaxSlippage` up to 5 %, test C3), lower caps, and set spacing to 0.
* This is fine for the owner's own funds. But any minimums the factory enforces for the hosted keeper's sake (H-1) must live in the vault.
* The doc comment "Everything that could hurt a user … is pinned" should say slippage is only a default.

## L-3: Views and policy bits that mislead the dashboard

* `nextBuyAt()` returns `lastBuyAt + minInterval` even when that time has passed. With `minInterval = 0` it returns the last buy time (E2), but the doc says "0 = now". Return 0 when the time is `<= block.timestamp`.
* Bit 5 combines "daily cap reached" and "too soon" (E4). The keeper always reports "waiting for the next buy time". Expose `spentToday`/`nextBuyAt` separately in the UI (both exist), or split the reason off-chain.
* `nextBuyAt` ignores the day cap, pause and price.

## Informational

* **I-1 Events:**
  * `VaultCreated` carries no `savings`, slippage or TWAP window.
  * No `KeeperSet` / `MaxPriceSet` / `MinIntervalSet` / `SlippageSet` events are emitted at construction (A7). A dashboard rebuilding state from logs must read storage or `VaultCreated`.
  * `Armed(owner,0)` is emitted before `OwnershipTransferred(0,owner)`.
  * `Bought.twapPrice` is the TWAP, not the fill price (fill = `amountIn*1e18/amountOut`).
  * Apart from that, `Bought` / `TierChanged` are correct: `amountOut` is measured at `savings`.
* **I-2 Non-factory vaults:** anyone can deploy LatchSwap directly, naming any `owner` (a victim, without consent), the hosted keeper as `keeper`, and their own pool/processor/treasury (G1). The keeper is safe because it only scans `factory.vaultsPage`. The dashboard must check `factory.isVault(v)` before showing anything.
* **I-3 CREATE addresses** depend on the factory's nonce. A front-run `createVault` shifts the address. The UI must take the address from the receipt's `VaultCreated` event and never predict it before the user deposits.
* **I-4** `vaultsPage(start, type(uint256).max)` panics on `start+count` overflow (view only; G3).
* **I-5** The factory constructor doesn't validate `twapWindow` / `slippageBps` / circuit. A bad value makes every `createVault` revert, which is easy to fix by redeploying.
* **I-6 (v1 I-6, still open)** `pendingOwner` cannot be cancelled.
* **I-7** `arm()` is dead code for factory vaults (fee is always 0). `activationFee` revenue is gone, so fee income is only 1 % of volume. See H-1 on whether that covers keeper gas: at 1 USDT0 per buy, 0.01 USDT0 per tick.

---

## Verified correct

* **Who can move funds:**
  * `withdraw`, `setKeeper`, `setPaused`, `transferOwnership` and all setters are `onlyOwner`. The owner is `msg.sender` of `createVault`; the factory is never owner (A1–A4, A6).
  * The factory keeps no reference to its vaults that grants any power. The admin can only change `hostedKeeper` for future vaults, and `admin` itself.
  * The keeper can only call `tick`. Output goes only to the immutable `savings`.
* **Auto-arm:**
  * With `activationFee == 0` the vault starts armed and unpaused. No one but the keeper can call `tick`, and with nothing in the vault there is nothing to buy.
  * `arm()` correctly reverts `AlreadyArmed`.
  * There is no fee-bypass path, because fee 0 is the factory's own choice. I found no issue.
* **Spacing:**
  * `lastBuyAt == 0` lets the first buy through.
  * `_spacedOk` is the same in `tick` and `_bits`. `TooSoon` carries the right time.
  * `lastBuyAt` is written before the external calls and rolled back on revert.
  * A raised interval applies relative to the last buy (E3). `MAX_INTERVAL` is enforced in the constructor and the setter. The keeper cannot change spacing.
  * `minInterval > 0` also closes the 2× UTC-midnight burst (E5).
  * There is no overflow (`lastBuyAt + minInterval`, ≤ 30 days).
* **Day cap:** the check → roll → add order is unchanged. `_bits` and `tick` use the same `_spentToday() + amount <= dailyCap`.
* **Preview vs tick, the other direction:** in 72 fuzzed states I found no case where `preview` denies and `tick` succeeds (F1). Bits 0–6 are built from the same state `tick` checks. Bit 6 (balance) is inside the `0x78` mask.
* **No user code runs during `tick`:**
  * `savings` is only read via `WOKB.balanceOf`. Measuring the delta is correct even when `savings` is another vault, the treasury or the keeper (D8, D9).
  * Reentrancy is not possible: everything is pinned, and the call is `nonReentrant`.
* **Factory pinning:**
  * The pool, router, processor, circuit, tokens, treasury and TWAP window come from immutables.
  * The vault constructor re-verifies the pool through `router.factory().getPool`. It rejects system addresses and addresses ≤ 0xff as `savings` (D5), and a user keeper of `address(0)` falls back to the hosted keeper.
  * Every factory vault runs identical bytecode, so the keeper can trust `status()` / `quote()` / `preview()` from vaults on the factory list.
* **Fee and amount arithmetic:** the keeper's `affordable = bal*1e4/(1e4+bps)` always satisfies `amount + floor(amount*bps/1e4) <= bal`. `amount*outUnit` and `maxPrice*minOut` cannot overflow for any amount a vault could hold.
* **v2 fixes still hold:** `swap.test.mjs` passes (spot-deviation check, worst-fill check, fee-netted `minOut`, savings ≤ 0xff, TWAP ≥ 1800 s).

---

## Resolution (v4, applied after this review)

| Finding | Status | Change | Covered by |
|---|---|---|---|
| H-1 dust vaults hog / drain the hosted bot | **Fixed** | Immutable `minAmount` in every vault (factory pins **1 USDT0**), enforced in `tick`, the constructor and `setCaps`; preview bit 4 reflects it. Bot pages through **all** vaults, checks a **rotating window** each minute, batches reads, sends at most 3 buys per run with explicit nonces, and skips a run while its previous tx is pending. Every buy is still simulated (`estimateGas`) before sending. | swap.test.mjs "dust buy…", "caps cannot go below…", "per-buy below the 1 USDT0 minimum…"; keeper-worker test "rotation…" |
| M-1 no central revoke of a stolen hosted key | **Fixed** | Factory is a **deny-only guardian**: `setRevoked(keeper, true)` blocks that keeper in every vault (`tick` → `NotKeeper`, preview bit 1 off). It cannot move funds or loosen rules; owners then `setKeeper` to the new bot. | "after revoke: …", "owner can move to a new bot…", "revoke cannot touch funds…" |
| M-2 preview allow, tick reverts | **Fixed (main cause)** | Preview now applies the same worst-fill check as `tick` (bit 3). Residual: pure price-impact on very low slippage can only be found by simulation; the hosted bot simulates every buy, and the README tells own-bot users to do the same. | "preview agrees with tick on worst fill" |
| L-1 unsafe savings | **Fixed** | `createVault` rejects savings = factory, hosted bot, chosen bot, treasury, or another vault. | "factory: savings = … refused" ×4 |
| L-2 slippage only initial | **Accepted, documented** | Owners may widen their own slippage up to the 5% hard cap; it only affects their own fills. |  |
| L-3 `nextBuyAt` in the past | **Fixed** | Returns 0 when the next buy is already allowed. The dashboard uses it to tell "daily limit" from "spacing". |  |
| Info: UI must take vault from event, check `isVault` | **Done in UI** | Dashboard lists only `factory.vaultsOf(owner)` filtered by current `owner()`. |  |
