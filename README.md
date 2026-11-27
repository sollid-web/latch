# Latch

**Buy OKB on dips. Take profit on rises. A chip on X Layer decides how much.**

**English** · [中文简介](#中文简介)

Latch lets anyone put USDT0 or OKB in a vault only they control and have it traded automatically on Uniswap.
The size of every trade is decided on chain by a 101-gate TapeOut circuit: more when the move is bigger,
less when the market is jumpy, nothing when the owner's rules say no. The agent that runs it can never
withdraw, raise a limit, or send money anywhere but the owner's wallet.

## For judges (X Layer TapeOut Accelerate)

| | |
|---|---|
| **Live app** | https://okblatch.xyz · **no wallet needed:** [Demo mode](https://okblatch.xyz/#/demo) runs the whole journey (create, market moves, the agent trades, pause, withdraw) with play money, the live OKB price and the real circuit #2 netlist · [Try it](https://okblatch.xyz/#/try) previews one decision |
| **On DeWEB** | https://2-2-435.tapekit.org/ (`2.2.435.tape`, stored in circuit #2's own container, served by TapeKit) |
| **Demo video (≤ 3 min)** | `[YouTube link]` |
| **TapeOut processor** | `0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813` (Latch's own processor, X Layer mainnet, chain 196) |
| **Circuit IDs** | **#2**: strategy chip, 101 NAND, 16 inputs and 3 outputs, sizes every v2 trade · **#1**: safety chip, 13 NAND, approves every classic-vault buy |
| **Contracts** | LatchFactory2 [`0x9C64…6428`](https://www.oklink.com/xlayer/address/0x9C647a631fe59813c430D03330C3A4Da21df6428) (Buy and Take Profit vaults) · LatchFactory [`0xc700…BD11`](https://www.oklink.com/xlayer/address/0xc700C9865f237612b0bA86408BB4C182D41ABD11) (classic) · Uniswap V3 USDT0/WOKB 0.05% pool [`0xe3BE…5082`](https://www.oklink.com/xlayer/address/0xe3BE6A0137f1b0602Fc1a4841686f43B340a5082) |
| **TapeOut features used** | **Circuits:** every v2 trade calls `processor.eval(2, inputs)` in the same transaction and is sized by the answer. **DeWEB + TapeKit:** the full app is stored in circuit #2's ERC-6551 container and passes TapeKit's "100% on-chain" rule. **Circuit explorer:** the site runs the same netlist in the browser and can ask the live processor about any input. |
| **Business** | [Revenue and users](#revenue-model) below and in [SUBMISSION.md](SUBMISSION.md) |
| **Usage, live** | [Activity](https://okblatch.xyz/#/activity): vaults, trades checked by a chip, OKB bought and profit taken, all read from chain. Full trade list, each with its tx hash: [latch-keeper.tapeguard.workers.dev/trades](https://latch-keeper.tapeguard.workers.dev/trades) |
| **Deposit helper** | [`LatchDeposit` `0x948e…E3D4`](https://www.oklink.com/xlayer/address/0x948ea5060786167f1d9f7fdfbF3301c59893E3D4): behind the site's Add funds button (OKX Wallet refuses plain token transfers from websites on X Layer). Only moves the caller's own tokens, only into Latch vaults, only the vault's own token; holds nothing, no owner. Tests: `audit/deposit.test.mjs` (11 checks). |
| **Verified source** | All three live contracts verified on [Sourcify](https://repo.sourcify.dev/196/0x9C647a631fe59813c430D03330C3A4Da21df6428) with an **exact match** (byte-for-byte, including metadata): LatchFactory2, the LatchVault template every vault clones, and the classic LatchFactory. All three are also verified on OKLink, X Layer's explorer. (v2 was rebuilt without via-IR on 24 November so OKLink could verify it; the earlier via-IR factory `0x4Af2…81b8` is retired.) |
| **Assurance** | Circuit #2 checked on all 65,536 inputs, against the live processor too · 47 contract tests on Uniswap's real V3 code · Slither · three independent reviews with every finding answered ([audit/](audit/)) · mainnet-fork rehearsal before every mainnet step |
| **AI agents** | OKX Plugin Store skill [`latch-plugin`](plugin/latch-plugin) on OKX Agentic Wallet: an agent creates and manages vaults, or acts as a vault's own agent, signing with `onchainos wallet contract-call` |
| **Built during the event** | All of it. First commit 2026-11-03. |

## What it does

1. **Pick a job.**
   - **Buy OKB:** the vault holds USDT0.
   - **Take profit:** the vault holds OKB, as WOKB (wrapped OKB, always 1:1).
2. **Pick a strategy.**
   - **Steady:** the same amount every time (DCA).
   - **Dips only / Rises only:** trades only when OKB is past your reference price.
   - **Smart:** 2× or 3× more on bigger moves; 1× when the market is jumpy; pauses when it is very jumpy.
   - **Ladder:** 1× from a 5% move, 2× from 15%, 3× from 30%.
3. **Set your limits.**
   - a base amount per trade
   - a ceiling (Buy) or a floor (Take Profit)
   - the most per trade and per day; these can only ever be lowered
   - how often it may trade at most
   - the wallet that receives the output
4. **Fund it.** That's it. Latch's hosted agent checks every vault each minute. You can pause, change the strategy or withdraw everything at any time.

### How one trade is decided

```
agent calls vault.tick()
  └─ vault measures, from Uniswap's 30-minute average (TWAP) and the live price:
       how far OKB moved from your reference (8 steps) · how jumpy the market is (4 steps) · your strategy · 7 safety facts
  └─ 16 bits → TapeOut processor.eval(circuit #2) → allow + size k (0, 1, 2 or 3)
  └─ amount = base × k, capped by your per-trade limit, what is left today, and the vault's balance
  └─ Solidity re-checks every money rule (limits, spacing, price within ~1% of the average, worst fill inside your ceiling/floor)
  └─ Uniswap V3 swap → output straight to your wallet → event Traded(…, inputs, k)
```

## Why you don't have to trust the agent

- **The agent can only trigger trades.** Only the owner can withdraw (any time, even while paused), pause, change the strategy or prices, or lower the limits. Limits can never be raised.
- **A stolen agent key can only make trades your own rules already allow,** at your prices, into your own wallet. Latch can also switch an agent key off for every vault at once. That switch can stop trades but can never move funds.
- **Price safety.**
  - Every trade is priced from Uniswap's 30-minute average, not the price this second.
  - It is refused if the live price is more than about 1% away from that average.
  - It is refused if the worst accepted fill would break the owner's ceiling or floor.
  - The agent also refuses when Uniswap disagrees with the major exchanges (Gate, MEXC, LBank, XT and others).
- **Rules can't be changed by anyone.** Every vault is pinned at creation to the processor, the circuit, the router and the pool, and the factory has no power over funds.

## For AI agents: OKX Agentic Wallet + Plugin Store

Latch ships as a skill in the **OKX Plugin Store** format ([`plugin/latch-plugin`](plugin/latch-plugin)), built on **OKX Agentic Wallet** (Onchain OS).

The OKX Plugin Store currently adds plugins only by its own curation, not by outside submission, so the skill installs straight from this repo, next to OKX's own Onchain OS skills:

```
npx skills add sollid-web/latch
```

The skill then installs the `latch` tool once from npm ([`latch-xlayer`](https://www.npmjs.com/package/latch-xlayer): `npm install -g latch-xlayer`, or `npx latch-xlayer <command>`) and signs with the OKX Agentic Wallet (`onchainos`).

**How it works:**
- The [`latch`](agent/latch.mjs) command-line tool ([`latch-xlayer` on npm](https://www.npmjs.com/package/latch-xlayer)) reads Latch on X Layer and **prepares** transactions.
- The agent's Agentic Wallet signs each one with `onchainos wallet contract-call` inside OKX's TEE, after the user confirms it.
- The tool never sees a key.

**What it can do:**

| | Command |
|---|---|
| OKB price as vaults see it | `latch market` |
| What a vault would do right now (real chip) | `latch try --dir buy --mode smart --ref 95 --limit 100 --base 2` |
| Create, fund, pause, change strategy, withdraw | `latch create …`, `latch fund …`, `latch pause …`, `latch strategy …`, `latch withdraw …` |
| See a vault and why it waits | `latch status --vault 0x…` |
| Be the vault's own agent | `latch tick --vault 0x… --as <agent wallet>` |

**Two uses:**
1. **"Buy OKB on dips for me":** a user's assistant sets up and manages a vault from their Agentic Wallet.
2. **The Agentic Wallet as a vault's own agent:** gas-free on X Layer. Because the vault and the chip enforce every limit, a tricked or confused agent still can't trade more, more often or at a worse price than the owner allowed, and can't send funds anywhere else.

**Live on mainnet:** an OKX Agentic Wallet created a Latch vault this way: [`0x367F…10b7`](https://www.oklink.com/x-layer/address/0x367F3EB73E6C5e7883Aa7D1db76Cb29C11E710b7). Also tested end to end on a local chain with Uniswap's real contract code (`agent/test.mjs`, 22 checks). Any other agent or script can do the same with `vault.preview(agent)` and `vault.tick()`.

## Revenue model

- **Trading fee:** 1% of each trade, falling to 0.75%, 0.5% and 0.25% as a vault's volume passes 1,000, 5,000 and 20,000 USDT0. It is enforced in the contract, and Latch's bot pays the gas.
- **Next:**
  - premium strategy chips (new circuits as new strategies)
  - a keeper service for agent builders
  - white-label factories for wallets and exchanges

Target users and the go-to-market plan are in [SUBMISSION.md](SUBMISSION.md).

## Architecture

```
Browser (web/, viem, OKX Wallet: extension, in-app browser, or OKX Connect from a phone browser)
   │ createVault / fund / pause / setStrategy / withdraw
   ▼
LatchFactory2 ──clones──► LatchVault (EIP-1167, one per user; Buy or Take Profit)
                              │ tick()  ◄── hosted agent (Cloudflare cron every minute, keeper-worker/)
                              ├─ Uniswap V3 TWAP + live price (UniMath)
                              ├─ TapeOut processor.eval(#2) → allow + size
                              ├─ Solidity money rules
                              └─ SwapRouter02 → output to the owner's wallet
DeWEB: the same app, as one HTML file, in circuit #2's container (SiteRegistry) → 2.2.435.tape → TapeKit gateway
```

| Folder | What |
|---|---|
| `circuits/` | `circuit2.py`: rules, NAND builder, exhaustive check on 65,536 inputs, TAP-02 export (`circuit2.json`) |
| `contracts/` | `LatchVault.sol`, `LatchFactory2.sol`, `UniMath.sol`; classic `LatchSwap.sol` + `LatchFactory.sol` |
| `keeper-worker/` | Hosted agent (Cloudflare Worker) |
| `web/` | Website source (Home, Try it, Create, My vaults, The chip, Activity, Safety); built by `scripts/build-web.mjs` |
| `audit/` | Test suites and independent reviews |
| `scripts/` | Fork rehearsals, go-live scripts, the on-chain circuit verifier, DeWEB publishing |

## Run it yourself

```bash
node audit/v2/vault.test.mjs                       # v2 contracts on Uniswap's real V3 code (needs anvil; npm i in audit/swap)
cd keeper-worker && npm install && npm test        # hosted agent
node web/e2e-setup.mjs                             # then: WEB_CONFIG=<tmp>/latch-ui/web-local.json node scripts/build-web.mjs && node web/e2e.mjs
node scripts/verify-circuit2.mjs https://rpc.xlayer.tech 0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813 2   # ask the live chip all 65,536 inputs
./scripts/preflight-v2.sh                          # free mainnet-fork rehearsal (reads keeper/.env)
ONCHAIN=1 node scripts/build-web.mjs && node scripts/check-onchain.mjs   # DeWEB build + TapeKit static rule
```

## History (what changed during the event)

- **Early November:**
  - circuit #1 taped out
  - first savings relay; it lost 15 USDT0 to a fee we hadn't tested for, and since then every mainnet step is rehearsed on a mainnet fork first
- **Mid November:**
  - rebuilt as classic Latch vaults that buy OKB on Uniswap, with a hosted agent and a self-serve site
  - first real buy
  - two independent reviews
- **23 November, v2:**
  - circuit #2 taped out (101 NAND, all 65,536 inputs checked on the live processor)
  - LatchFactory2 live with Buy and Take Profit
  - multi-page site and phone connection via OKX Connect
  - third independent review, all findings fixed
- **24 November:**
  - the app went on chain on DeWEB (`2.2.435.tape`)
  - the "Try it" page shows what a vault would do right now, with no wallet
  - the OKX Plugin Store skill lets AI agents use Latch through the OKX Agentic Wallet

---

## 中文简介

**Latch：逢跌买入 OKB，逢涨止盈。每笔交易的金额由 X Layer 上的一颗芯片决定。**

- **怎么用：** 用户把 USDT0（买入）或 OKB（止盈）存入只有自己能控制的金库（vault），选择策略：定投、只在下跌/上涨时、智能（波动越大买/卖越多），或阶梯。然后设定参考价、价格上限/下限、每笔和每日限额。Latch 的托管机器人每分钟检查一次，在 Uniswap 上完成兑换，所得直接进入用户自己的钱包。
- **TapeOut 电路：** 每一笔交易的大小由 TapeOut 电路 #2（101 个 NAND 门，16 位输入、3 位输出）在链上决定：不交易、1 倍、2 倍或 3 倍。该电路已对全部 65,536 种输入在主网处理器上逐一核验。
- **安全：** 机器人只能触发交易，不能提款、不能提高限额、不能把资金转到别处。限额只能下调。所有者可随时暂停或全部提取。
- **生态集成：** 自有 TapeOut 处理器 `0x3728…6813`，电路 #1 和 #2；整个网站以单个 HTML 文件存放在电路 #2 的 ERC-6551 容器中（DeWEB），域名 `2.2.435.tape`，通过 TapeKit 网关访问：https://2-2-435.tapekit.org/ ，并通过 TapeKit 的"100% 链上"静态规则检查。
- **商业模式：** 每笔交易收取 1% 手续费，随交易量降至 0.25%。机器人支付 Gas。
- **免钱包体验：** https://okblatch.xyz/#/try ：输入策略，立即看到金库此刻会怎么做（使用实时 Uniswap 价格和链上真实芯片）。
