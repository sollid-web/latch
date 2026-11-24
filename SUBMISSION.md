# Latch: submission kit (X Layer TapeOut Accelerate)

Draft, 2026-11-23. Text in `[brackets]` gets filled in after the DeWEB publish and the video upload.
Every address below is live on X Layer mainnet (chain 196).

## One line

Buy OKB on dips and take profit on rises from a vault only you control. A 101-gate TapeOut circuit on chain decides the size of every trade, so the bot that runs it can never trade more, pay more, or send your money anywhere else.

## Form fields

- **Project name:** Latch
- **Processor contract address:** `0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813` (Latch's own TapeOut processor, X Layer)
- **Circuit IDs:**
  - **#2:** strategy chip, 101 NAND, 16 inputs and 3 outputs. It sizes every v2 trade.
  - **#1:** safety chip, 13 NAND. It approves every classic-vault buy.
- **Other contracts:**
  - LatchFactory2 `0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8` (v2 vaults: Buy and Take Profit)
  - LatchFactory `0xc700C9865f237612b0bA86408BB4C182D41ABD11` (classic vaults)
  - Uniswap V3 USDT0/WOKB 0.05% pool `0xe3BE6A0137f1b0602Fc1a4841686f43B340a5082`
- **Access link:** https://latch.tapeguard.workers.dev. Also fully on chain at https://2-2-435.tapekit.org/ (`tape://2.2.435.tape`), served from circuit #2's own container.
- **Repo:** https://github.com/sollid-web/latch
- **Demo video:** `[YouTube link]`

### Product / service

Latch is automatic OKB trading that you don't have to trust. You create a vault in one transaction and choose its job:

- **Buy OKB:** the vault holds USDT0.
- **Take profit:** the vault holds OKB.

Then you pick a strategy:

- **Steady:** the same amount every time (DCA).
- **Dips only / Rises only:** trades only when OKB is past your reference price.
- **Smart:** 2× or 3× more on bigger moves. It drops to 1× when the market is jumpy and pauses when it is very jumpy.
- **Ladder:** starts at a 5% move, with 2× from 15% and 3× from 30%.

You also set:

- a ceiling (Buy) or a floor (Take Profit)
- a per-trade limit and a daily limit
- how often it may trade at most

Latch's hosted bot checks every vault each minute. On each check, the vault turns the market into 16 bits:

- how far OKB's 30-minute average has moved from your reference (8 steps)
- how jumpy the market is (4 steps)
- your strategy
- 7 safety facts

TapeOut circuit #2 answers with a decision: no trade, 1×, 2× or 3× your base amount. The vault then swaps on Uniswap and sends the output straight to your wallet. It never keeps the output, and never sends it anywhere else.

The bot can only trigger trades. It cannot withdraw, raise a limit, change the strategy or redirect funds. A stolen bot key can do no more than what your own rules already allow. Latch can also switch a bot key off for every vault at once, and that switch can only stop trades.

Only the owner can withdraw (any time, even while paused), pause, change the strategy and prices, and lower the limits. Limits can never be raised. You can plug in your own bot or AI agent as the vault's keeper, and it gets exactly the same limits.

### Target users

1. **OKX Wallet users on X Layer who want to build an OKB position or lock in gains** without watching charts or leaving coins on an exchange for its recurring-buy feature. Setup takes about two minutes, on a phone or a computer.
2. **People who would use a trading bot but won't give one their keys.** Trading bots and bot services get hacked, as with the Telegram bots Unibot (2023) and Banana Gun (2024), and with API keys leaked at 3Commas (2022). With Latch, the worst a compromised bot can do is a trade the owner already allowed, into the owner's wallet.
3. **Builders of bots and AI agents on X Layer** who need spending limits that an agent can't argue its way around. Their agent becomes a vault's keeper, and the chip and the vault hold the line.

### How we reach them

- **Inside OKX Wallet:** Latch connects to the OKX Wallet app from a phone browser and works in its Discover browser. Next steps: a Discover listing and an X Layer ecosystem listing.
- **Proof as marketing:** every trade links to its transaction and to the chip's decision. The Activity page and the on-chain explorer let anyone check a claim like "the chip said 3× and the swap obeyed" for themselves. We post those on X and in TapeOut and X Layer communities.
- **Communities that DCA:** savings groups and crypto communities on WhatsApp, Telegram and X in Lagos and beyond, where "buy a little every week" is already the habit. Latch adds "more on the dips, never above my price" without custody.
- **Bot and agent builders:** "use my own bot" is built into the create flow. A keeper SDK and a guide bring their users in as vault owners.

### Revenue model

- **Trading fee:** 1% of each trade. It falls to 0.75%, 0.5% and 0.25% as a vault's volume passes 1,000, 5,000 and 20,000 USDT0, so big users stay. The fee is enforced in the contract and paid to the treasury on every trade, and Latch's bot pays the gas.
- **Next:**
  - premium strategies (new circuits taped out as new strategy chips)
  - a paid keeper service for agent builders (their agent, our limits and monitoring)
  - white-label factories for wallets and exchanges, with a revenue share

### Why users pay and stay

- **It does a job they already want:** buying the dip or taking profit without watching charts. It also does it better than a fixed recurring buy, because it buys more on bigger dips and sells more on bigger rises.
- **Safety they can check:** the chip's answer for every possible input is published (the chip page shows all of them), it was checked on all 65,536 inputs, and every trade carries the chip's input on chain.
- **Self-custody:** funds sit in the user's own vault, and the output lands in their wallet. Nothing is locked, and leaving takes one transaction, so they stay because it works, not because they're stuck.
- **The fee falls as they use it more.**

### TapeOut ecosystem integration

- **Our own TapeOut processor and two taped-out circuits.**
  - Circuit #2 (101 NAND) is the product's brain. Every v2 trade calls `processor.eval(2, inputs)`, and the vault sizes the trade from the chip's answer.
  - Circuit #1 (13 NAND) approves every classic-vault buy.
  - Both netlists were checked against the written rules for every input before tape-out. Circuit #2 was checked again on the live processor (a mainnet copy) for all 65,536 inputs, and its stored netlist was confirmed byte-for-byte identical on mainnet.
- **TapeKit-style circuit explorer:** the website runs the same netlist in the browser (101 gates lighting up) and can ask the live processor for any input ("Ask the real chip").
- **ERC-6551 container + DeWEB + TapeKit:**
  - The whole app is one self-contained HTML file stored in circuit #2's own container through SiteRegistry, so the chip itself is the website's home.
  - It is bound as `2.2.435.tape` through DomainBinding and served by TapeKit gateways.
  - It passes TapeKit's "100% on-chain" static rule (`scripts/check-onchain.mjs`) and reads only TapeKit's default X Layer nodes.
- **On-chain data, no database:** the stats, activity and history pages read the factories, vaults and trade events straight from X Layer.
- **TapeSend:** `[not integrated yet / or: trade notices to the owner's TapeSend inbox, if shipped]`

### What was built during the event

All of it. The repository started on 2026-11-03 and has 78+ commits since:

- **Circuits:** circuit #1 (safety) and circuit #2 (strategy, 101 NAND, with a NAND builder and exhaustive checks), both taped out on our own processor.
- **v1 contracts:**
  - LatchSwap vaults + LatchFactory (live)
  - first real buy: 1 USDT0 into 0.012537 WOKB
- **v2 contracts:**
  - LatchVault (EIP-1167 clones) + LatchFactory2 (live), with Buy and Take Profit, chip-sized trades and every safety rule enforced in Solidity
  - Uniswap V3 TWAP pricing with a live-price check and worst-fill limits
- **Verification:**
  - 47 tests on Uniswap's real V3 + SwapRouter02 code
  - Slither
  - three independent reviews by separate AI agents, every finding fixed or answered in writing (`audit/`)
  - fork rehearsals on a copy of mainnet before every mainnet step
- **Hosted bot (Cloudflare cron, every minute):**
  - serves every vault fairly
  - refuses to trade when Uniswap disagrees with the exchanges
  - simulates before sending
  - 29 tests
- **Website:**
  - six pages: Home, Create, My vaults, The chip, Activity, Safety
  - phone connection through OKX's official connect library
  - 30 browser checks
  - an on-chain DeWEB copy

### Traction (honest)

- `[N]` vaults, `[N]` trades checked by a chip, `[X]` OKB bought, `[Y]` USDT0 of profit taken, from the Activity page on `[date]`.
- Vaults created by the builder for testing and the demo are labelled as such. `[Real users: names or count, if any]`

---

## Demo video script (≤ 3:00, screen capture + voice)

| Time | Screen | Voice |
|---|---|---|
| 0:00–0:15 | Home. The chip widget: drag the slider; the 101 gates switch; "Buy 1×" becomes "Buy 3×". | "Trading bots want your keys. Latch doesn't. You keep the money in your own vault, and a chip on X Layer decides how much every trade can be." |
| 0:15–0:35 | Phone: Connect wallet, then approve in the OKX Wallet app; the address appears. | "Connect with the OKX Wallet app." |
| 0:35–1:05 | Create, then Buy OKB, then Smart (the bar chart), then amounts, then the review sentence, then Create, then add USDT0. | "Pick a job and a strategy. Smart buys more on bigger dips and less when the market is jumpy. You set a ceiling, a daily limit and how often. One transaction, and it's live." |
| 1:05–1:35 | My vaults: "What the chip sees now: 20–30% below, calm, all 7 pass, buy 3×". Then the bot's trade appears, with Recent trades showing 3× and a link to the transaction. | "Every minute the bot asks. The vault turns the market into 16 bits, circuit #2 answers 3×, Uniswap swaps, and the OKB lands in my wallet. Not in the vault, not anywhere else." |
| 1:35–1:55 | Take profit vault, Ladder, the sentence; a trade showing "Sold 0.02 OKB, chip 1×". | "The same vault in reverse takes profit as OKB rises, more on bigger rises, never under my floor." |
| 1:55–2:20 | The chip page: flip "Paused", and the verdict becomes "Wait"; "Ask the real chip"; the full table of answers. | "This is the real netlist, running here and on chain. Every possible answer is public and was checked on all 65,536 inputs." |
| 2:20–2:40 | Safety page: what a stolen bot key could do. Pause, then Withdraw all. | "If the bot key is stolen, the worst case is a trade I already allowed. I can pause or withdraw any time." |
| 2:40–3:00 | The on-chain copy at `2-2-435.tapekit.org` with TapeKit's badge. Footer: "served from X Layer (DeWEB)". | "The app itself lives in the chip's container on X Layer. Latch: automation you don't have to trust." |

Recording notes: fund the demo vaults beforehand so the 3× buy and the take-profit sale happen on camera, or cut to the trade a minute later. Keep the phone and the desktop on the same wallet. Speak slowly. Captions help judges who watch muted.
