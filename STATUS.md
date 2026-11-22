# Latch — current status (handoff)

**Read this first in any new session.** Repo: github.com/sollid-web/latch (branch `main`).
Network: X Layer mainnet (chain 196). Deadline: TapeOut Accelerate (X Layer Build X), **Dec 7 2026, 23:59 UTC**.
Builder: solo, Lagos (UTC+1), Linux Mint at `~/latch` (also a Termux/proot copy on his phone at `/root/latch`,
which has no `keeper/.env`). Foundry installed. Prefers plain, non-technical explanations, exact copy-paste
commands, and scripts with built-in checks (he lost 15 USDT0 earlier to an untested assumption).

## Product (what Latch is now)
Self-custody vaults that **buy OKB automatically** on X Layer: *Buy the dip* (only at/below a price) or
*Auto-DCA* (fixed amount every day/week, under a ceiling). Anyone creates a vault from the website in one
transaction (factory). A **hosted helper bot** (Cloudflare cron, every minute) sends the buys. Every buy must
pass 7 on-chain rules + **TapeOut circuit #1** (allows only 0x7e). Swaps on Uniswap V3 (0.05% USDT0/WOKB pool),
OKB goes straight to the user's savings wallet. Fee 1% per buy → treasury (ladder down to 0.25%).

## Live on mainnet
| What | Address / URL |
|---|---|
| Website | https://latch.tapeguard.workers.dev (Worker `latch`, built from `web/` into `public/` by `npm run deploy`) |
| Hosted bot | https://latch-keeper.tapeguard.workers.dev (Worker `latch-keeper`, `keeper-worker/`; GET / = read-only report) |
| **LatchFactory** | **0xc700C9865f237612b0bA86408BB4C182D41ABD11** (admin + treasury = owner; min buy 1 USDT0; TWAP 1800 s; slippage 100 bps) |
| Builder's first vault (Auto-DCA 1 USDT0/day, ceiling 120) | 0x8a6e62Efc19af82A25BFaA55754671471aE47f60 — 1 real buy done (0.012537 OKB @ 79.76) |
| TapeOut processor / circuit | 0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813, circuit #1 (13 NAND, eval(0x7e)=allow, eval(0x7f)=deny) |
| Uniswap V3 pool USDT0/WOKB 0.05% | 0xe3BE6A0137f1b0602Fc1a4841686f43B340a5082 (cardinality 2048). Router 0x4f0c28f5…9bca, factory 0x4B2ab38D…6804 |
| USDT0 (6 dec) / WOKB (18 dec) | 0x779Ded0c9e1022225f8E0630b35a9b54bE713736 / 0xe538905cf8410324e03A5A23C1c177a474D59b2b |
| Owner = admin = treasury (key: keeper/.env OWNER_PRIVATE_KEY) | 0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4 — **cannot be a vault's savings** (factory rejects treasury) |
| Savings wallet (Google-login OKX, receive-only) | 0x9005cb6847903AFC626eB4Dee5137606C567FeE7 |
| Hosted bot / keeper (key: keeper/.env KEEPER_PRIVATE_KEY, also a Cloudflare secret) | 0x61A84AF1f9306A7103AA3D33Cc62E045e398dDBd (~0.005 OKB gas ≈ hundreds of buys) |
| Retired | LatchRelay v2 0x7952…a2A0 (emptied); old relay 0xA4b9…7A02 + container 0xa38E…fCe0 (15 USDT0 stuck, unrecoverable) |

Config files: `deployments/web-config.json`, `deployments/xlayer-latch.json`, `keeper-worker/wrangler.jsonc`.

## Code map
- `contracts/LatchSwap.sol` (vault), `LatchFactory.sol`, `UniMath.sol` (Uniswap math port). Earlier: `LatchRelay.sol`.
- `audit/swap/swap.test.mjs` (76 tests, real Uniswap bytecode on anvil), `INDEPENDENT_REVIEW.md`, `INDEPENDENT_REVIEW_V3.md` (all findings fixed/documented). Slither: 0.
- `keeper-worker/` hosted bot + `test/local.mjs` (16 e2e tests). Price sources: OKX, Binance(451 from CF), CoinGecko(429), Gate, KuCoin(429), Bitget, MEXC, HTX; needs ≥2 agreeing and pool within 2%.
- `web/app.js` + `web/index.html` (IBM Plex, circuit-board palette, interactive chip hero, dashboard, dialogs), `web/e2e.mjs` (15 browser steps), `scripts/build-web.mjs`.
- `scripts/preflight-factory.sh` (free mainnet-fork rehearsal — passed), `golive-factory.sh` (`FACTORY=… ` resumes).
- `README.md` is written for judges (problem, users, journey, security, revenue, TapeOut use, audit, roadmap).

## Where we are (as of Nov 22, 2026)
- Done: contracts + 2 reviews + tests; factory live; website v2 + bot live; first real buy; redesign pushed (commit afafb0d).
- **Pending deploy by builder:** `cd ~/latch && git pull && npm run deploy` (site redesign) and `cd keeper-worker && npx wrangler deploy` (extra price sources).

## Next steps
1. Builder redeploys site + bot (above) and checks the live page.
2. Optional: a second vault (*Buy the dip*, e.g. 5 USDT0/buy, 2/day, price 75) to show both strategies; 3–5 friends create small vaults (real-user evidence matters most for "user value").
3. **Demo video script (≤3 min):** problem → create vault from the site → bot buy appears → hero chip: flip a rule, "Ask the real chip" → "Try to steal" impossibility → revenue + roadmap.
4. **Submission text** (product, target users, revenue model, why users pay/stay, processor address + circuit ID) from README.
5. Judging criteria (official page web3.okx.com/xlayer/build-x-series): user value & commercial potential; innovation (circuit, features, UX, new TapeOut use cases); ecosystem integration; product readiness & UX (complete journey, low barrier); demo video ≤3 min. Weakest today: evidence of real users.

## Rules learned the hard way
- Always rehearse on a mainnet fork before any mainnet send; never test only against stand-ins.
- Give one command at a time with what success looks like; scripts must stop with a plain `STOP:` reason.
- Never commit `keeper/.env`. Owner wallet can't be a vault's savings address.
