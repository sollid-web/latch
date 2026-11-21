# Latch — stack OKB on autopilot, without trusting a bot

**Live app:** https://latch.tapeguard.workers.dev · **Chain:** X Layer mainnet (196) · **Built for:** X Layer TapeOut Accelerate

Latch lets anyone put USDT0 into a vault that only they control and have OKB bought automatically:
**buy the dip** (only when OKB falls to your price) or **auto-DCA** (a fixed amount every day or week,
never above your ceiling). A hosted helper bot sends the buys, but it **cannot misbehave**: every buy must
pass seven rules enforced by the vault contract *and* a TapeOut circuit on chain. The bought OKB goes
straight to the user's own wallet.

---

## 1. The problem

Automation in crypto today means handing a program power over your money:

- **Trading bots and bot services** hold your keys or exchange API keys. When they are hacked or leak keys,
  accounts get emptied (Telegram trading bots such as Unibot in 2023 and Banana Gun in 2024; leaked API
  keys at 3Commas in 2022).
- **AI agents with wallets** are arriving fast. An agent that is tricked (prompt injection) or simply wrong
  can send everything to the wrong place.
- **Ordinary users** who want to build an OKB position either watch charts all day, or keep coins on an
  exchange to use its recurring-buy feature (custody risk).

## 2. Who it is for (target users)

| User | Need | What Latch gives them |
|---|---|---|
| OKX Wallet users on X Layer who want to accumulate OKB | Recurring or dip buying without watching charts, without leaving coins on an exchange | A self-custody vault + hosted bot; set up in ~2 minutes from the browser or the OKX Wallet app |
| People who would use a trading bot but fear giving it keys | Automation with a hard, provable limit on what can go wrong | The bot's worst case is "buy your chosen amount, at your price or better, into your own wallet" |
| Builders of bots and AI agents on X Layer | Spending limits an agent cannot talk its way around | Plug your own bot/agent in as the vault's keeper; it gets exactly the same on-chain limits |

## 3. The product (complete user journey)

1. **Connect** OKX Wallet (extension on desktop; on a phone the page opens itself in the OKX Wallet app).
2. **Choose a strategy:** *Buy the dip* or *Auto-DCA*.
3. **Set it in plain words:** amount per buy, your price (dip) or ceiling (DCA), how often, where the OKB goes.
4. **Review** a one-sentence summary ("Latch buys 5 USDT0 of OKB every week, never above 120…") and create
   the vault — **one transaction**, no terminal, no keys to manage.
5. **Add USDT0.**
6. **Dashboard:** USDT0 left, OKB bought, average price paid, number of buys, when the next buy happens,
   the 7 safety checks for the next buy (✓/✗ in plain words), **"TapeOut rule chip #1 says YES (0x7e)"**
   with a link to the circuit, recent buys with transaction links, and one-click **Pause**, **Change price**,
   **Change spacing**, **Withdraw all**.

The hosted bot checks every vault every minute and buys when that vault's own rules say yes.

## 4. Why you don't have to trust the bot (security design)

Before **every** buy the vault computes seven facts and packs them into one byte:

| Bit | Rule (plain words) |
|---|---|
| 0 | Not paused by you |
| 1 | Request comes from your helper bot (and that bot has not been revoked) |
| 2 | OKB goes only to your wallet (structural: the destination is fixed at creation) |
| 3 | OKB's 30-minute average price is at or below your limit, the current price is within ~1% of that average (anti-manipulation), and the worst accepted fill price is also within your limit |
| 4 | Amount is within your per-buy limit (and at least the 1 USDT0 minimum) |
| 5 | Within today's limit and the minimum time between buys |
| 6 | Enough USDT0 in the vault for the buy plus the fee |

Two locks must both agree, in the same transaction:

1. **Solidity** enforces every rule above.
2. **The TapeOut circuit** (processor `0x3728…6813`, circuit **#1**, 13 NAND gates, 7 inputs) is called with
   `eval(circuitId, byte)` via STATICCALL. It allows exactly `0x7e` (all rules pass, not paused) and denies
   everything else. It can only deny, never move funds.

On top of that:

- Swaps go through the **official Uniswap V3 SwapRouter02** on X Layer, only on the **deepest USDT0/WOKB pool
  (0.05%, `0xe3BE…5082`)**, verified against the Uniswap factory at deploy.
- `minOut` = 30-minute TWAP quote, minus the pool fee, minus 1% slippage. A swap worse than that reverts.
- The **hosted bot** refuses to buy if the Uniswap price differs from the median of OKX/Binance/CoinGecko/
  Gate/KuCoin by more than 2%, and simulates every swap before sending it.
- **Owner-only:** withdraw (any time, even paused or with a broken pool), pause, change price/spacing,
  lower limits. **Limits can only go down.** The bot can never withdraw, raise limits or change where OKB goes.
- **Stolen-bot drill:** the factory is a *deny-only guardian*. Its admin can revoke a bot address for every
  vault at once; it cannot move funds or loosen any rule. Owners then point their vault at a new bot.
- **Worst case if the hosted bot key were stolen:** it could buy each vault's chosen amount, within its
  limits and price ceiling, into the owner's own wallet — until revoked.

## 5. Revenue model

- **Fee per buy:** 1% of the USDT0 spent, paid to the Latch treasury. It falls to 0.75% after 1,000 USDT0 of
  volume per vault, 0.5% after 5,000 and 0.25% after 20,000 (a loyalty ladder, enforced on chain).
- **No sign-up fee, no withdrawal fee.** The hosted bot pays gas; on X Layer a buy costs well under a cent
  of gas (~430k gas), so the fee covers it even for small buys.
- **Why users pay and stay:** recurring and dip buying without custody risk and without trusting a bot;
  the fee is comparable to or below exchange recurring-buy spreads, and falls with use.

## 6. TapeOut and ecosystem integration

| Piece | Address / detail |
|---|---|
| TapeOut processor | `0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813` |
| Circuit | **#1** — 13 NAND gates, 7 inputs, 1 output; `eval(0x7e)=allow`, `eval(0x7f)=deny` (checked at every deploy) |
| How it is used | Called on **every buy** (`tick`) and in `preview` (shown in the dashboard) |
| Uniswap V3 (X Layer) | SwapRouter02 `0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca`, factory `0x4B2ab38DBF28D31D467aA8993f6c2585981D6804` |
| Pool | USDT0/WOKB 0.05% `0xe3BE6A0137f1b0602Fc1a4841686f43B340a5082` (deepest; 2,048 price observations) |
| Tokens | USDT0 `0x779Ded0c9e1022225f8E0630b35a9b54bE713736`, WOKB `0xe538905cf8410324e03A5A23C1c177a474D59b2b` |
| LatchFactory | see `deployments/xlayer-latch.json` |

**New use case for TapeOut:** circuits as *programmable spending policies* for bots and AI agents. The same
pattern (vault computes facts → circuit decides) works for payroll, allowances, treasury top-ups and agent
budgets; only the circuit and the action change.

## 7. Audit and testing

| What | Result |
|---|---|
| Slither (102 detectors) on LatchSwap, LatchFactory, UniMath | **0 findings** (remaining annotations are justified inline) |
| Contract test suite (`audit/swap/swap.test.mjs`) against the **real Uniswap V3 factory, pool and SwapRouter02 bytecode** | **76 tests pass** — price guard, sandwich, dip buy, DCA spacing, caps, pause, withdraw, factory, revoke, dust, unsafe savings |
| Uniswap math port (`UniMath.sol`) | Byte-identical constants; matches the original 0.7.6 libraries on 1,200 ticks, 2,400 quotes, 157 mulDiv cases (`audit/swap/extra.v1.test.mjs`) |
| Independent review #1 (LatchSwap v1) | 0 Critical/High; 1 Medium + 4 Low — all fixed or documented: `audit/swap/INDEPENDENT_REVIEW.md` |
| Independent review #2 (factory + DCA) | 0 Critical; 1 High, 2 Medium, Lows — all fixed: `audit/swap/INDEPENDENT_REVIEW_V3.md` |
| Hosted bot (`keeper-worker/test/local.mjs`) | 16 end-to-end tests on real contracts: DCA, dip, divergence guard, pause, rotation, stolen key |
| Website (`web/e2e.mjs`) | Browser test with a wallet: connect → create → fund → bot buys → dashboard → pause → withdraw |
| Mainnet-fork rehearsal (`scripts/preflight-factory.sh`) | Full lifecycle against the real pool, tokens and circuit before any mainnet deploy |

**Known limits (honest):** the pool is the price source; a pool held at a manipulated but steady price for
30+ minutes is not detectable on chain (bounded by each user's ceiling and limits, and by the bot's
exchange cross-check). The daily limit is per UTC day. USDT0 is issuer-freezable. Contracts are reviewed
but not professionally audited — start small.

## 8. Architecture

```
Browser (web/app.js, viem, OKX Wallet)
   │ createVault / transfer USDT0 / pause / withdraw
   ▼
LatchFactory ──creates──► LatchSwap vault (one per user)
                              │ tick(amount)  ◄── hosted bot (Cloudflare cron, keeper-worker/)
                              ├─ 7 rule checks (Solidity)
                              ├─ TapeOut processor.eval(#1, byte) must allow
                              └─ Uniswap V3 SwapRouter02 → OKB to the user's wallet
```

| Folder | What |
|---|---|
| `contracts/` | `LatchSwap.sol` (vault), `LatchFactory.sol`, `UniMath.sol`; earlier `LatchRelay.sol` (v2 savings relay) |
| `keeper-worker/` | Hosted helper bot (Cloudflare Worker, cron every minute) |
| `web/` | Website source; built into `public/` by `scripts/build-web.mjs` |
| `audit/` | Test suites and independent reviews |
| `scripts/` | Fork rehearsals and mainnet deploy scripts with built-in checks |

## 9. Run it yourself

```bash
# tests (need Foundry's anvil on PATH)
cd audit/swap && npm install && npm test
cd keeper-worker && npm install && npm test
# free mainnet-fork rehearsal, then deploy (reads keeper/.env)
./scripts/preflight-factory.sh
./scripts/golive-factory.sh
# website + bot
npm install && npm run deploy
cd keeper-worker && npx wrangler secret put KEEPER_PRIVATE_KEY && npx wrangler deploy
```

## 10. Roadmap

- More actions with the same safety pattern: recurring payouts (payroll/allowances), treasury top-ups, agent budgets.
- More pairs (WETH, WBTC on X Layer) and user-chosen circuits from a vetted list.
- Agent SDK: let AI agents propose buys that the vault and circuit approve or deny.
- Professional audit before raising the per-vault limits.

## 11. History (what changed during the event)

- **Oct–Nov:** TapeOut circuit #1 taped out on mainnet; LatchRelay (savings sweep) v1 lost 15 USDT0 to a
  container fee we had not tested against (lesson: rehearse on a mainnet fork — every deploy now does).
- **Relay v2** (self-custody, audited) live; then the product was rebuilt into **LatchSwap + LatchFactory**:
  real OKB buying on Uniswap, dip + DCA strategies, hosted bot, self-serve website, two independent reviews.
