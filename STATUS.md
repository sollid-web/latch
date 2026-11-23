# Latch — current status (handoff)

**Read this first in any new session.** Repo: github.com/sollid-web/latch (branch `main`).
Network: X Layer mainnet (chain 196). Deadline: TapeOut Accelerate (X Layer Build X), **Dec 7 2026, 23:59 UTC**.
Working style: plain, non-technical explanations, exact copy-paste commands, and scripts with built-in
checks (15 USDT0 were lost earlier to an untested assumption). Only a machine with `keeper/.env` can deploy.

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
| Savings wallet (receive-only) | 0x9005cb6847903AFC626eB4Dee5137606C567FeE7 |
| Hosted bot / keeper (key: keeper/.env KEEPER_PRIVATE_KEY, also a Cloudflare secret) | 0x61A84AF1f9306A7103AA3D33Cc62E045e398dDBd (~0.005 OKB gas ≈ hundreds of buys) |
| Retired | LatchRelay v2 0x7952…a2A0 (emptied); old relay 0xA4b9…7A02 + container 0xa38E…fCe0 (15 USDT0 stuck, unrecoverable) |

Config files: `deployments/web-config.json`, `deployments/xlayer-latch.json`, `keeper-worker/wrangler.jsonc`.

## Code map
- `contracts/LatchSwap.sol` (vault), `LatchFactory.sol`, `UniMath.sol` (Uniswap math port). Earlier: `LatchRelay.sol`.
- `audit/swap/swap.test.mjs` (76 tests, real Uniswap bytecode on anvil), `INDEPENDENT_REVIEW.md`, `INDEPENDENT_REVIEW_V3.md` (all findings fixed/documented). Slither: 0.
- `keeper-worker/` hosted bot + `test/local.mjs` (19 tests). Price sources: OKX, Binance, CoinGecko, Gate, KuCoin, Bitget, MEXC, HTX; needs ≥2 agreeing and pool within 2%.
  Live check Nov 22: only Gate and MEXC answered (OKX/CoinGecko 429, Binance 451, Bitget 403, KuCoin/HTX no OKB price) — one more failure stops all buys; add sources that work from Cloudflare.
- `circuits/circuit2.py` → `circuit2.json`: circuit #2, 93 NAND, exhaustively verified (not taped out yet).
- `web/app.js` + `web/index.html` (IBM Plex, circuit-board palette, interactive chip hero, dashboard, dialogs), `web/e2e.mjs` (15 browser steps), `scripts/build-web.mjs`.
- `scripts/preflight-factory.sh` (free mainnet-fork rehearsal — passed), `golive-factory.sh` (`FACTORY=… ` resumes).
- `README.md` is written for judges (problem, users, journey, security, revenue, TapeOut use, audit, roadmap).

## Where we are (as of Nov 22, 2026)
- Done: contracts + 2 reviews + tests; factory live; website v2 + bot live; first real buy; redesign pushed (commit afafb0d).
- Live check Nov 22: redesign and extra bot price sources are deployed; 1 vault, 1 buy.
- Nov 22 audit fixes (branch `ccr-6b62b3c4-ptyeq4`): site log searches in 100-block pieces (the public RPC refuses
  more), homepage numbers no longer wait for logs, WOKB / fee / AI-review wording, old v1 page + `src/` + `server/`
  removed, LICENSE added, bot price parsing gives clear reasons, broken audit suites and e2e made runnable.
- **Pending by builder:** merge that branch into `main`, then `npm run deploy` (site) and
  `cd keeper-worker && npx wrangler deploy` (bot). Phone Connect now opens the OKX app via OKX's https universal link (test on a real phone).

## Gaps to close before submission
Circuit #1 is 13 NAND and, in a real buy, always receives 0x7e (Solidity rejects first), so the chip never
changes an outcome; no DeWEB/TapeSend/TapeKit yet; no demo video yet.

### Latch v2 plan ("the strategy is a chip") — approved direction, spend needs per-step approval
1. **Strategy circuit #2** on processor 0x3728…6813 (~16 inputs, 3 outputs, ~60–120 NAND, exhaustively verified):
   inputs = 7 safety bits + 3-bit dip depth vs owner's reference price (above, ~2.5, 5, 10, 15, 20, 30, deeper %)
   + 2-bit volatility (spot vs TWAP) + 2-bit mode (plain DCA / dip-only / smart DCA / ladder);
   outputs = allow + 2-bit size multiplier (0–3 × base amount). E.g. smart DCA: 1× normally, 2× at −10%, 3× at −20%, 1× if jumpy.
2. **LatchSwap v2 + LatchFactory v2**: vault computes the inputs, reads the multiplier, amount = base × mult (capped by limits);
   new tests, fork rehearsal, 3rd independent review. Old factory/vault keep running.
3. **Bot + website**: show "chip chose 2× because OKB is 12% below your reference price"; interactive hero uses circuit #2.
4. **DeWEB**: publish the site in circuit #2's container (open container 0.08 OKB; files via SiteRegistry putFile/appendChunk,
   24,000-byte chunks; no off-chain references → self-host fonts, no Google Fonts; X Layer addresses as reported
   by other TapeOut projects, verify on chain first: SiteRegistry 0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6,
   DomainBinding 0x68809fd2fb343aa57d0aeb7f33defe477c9666f9, TapeSend hub 0xe61a9c7213a6aa616c246a2b569e555b417b25ee). TapeSend buy alerts only if docs are found.
5. Submission text (must include: product, target users + how to reach them, revenue model, why users pay/stay,
   processor address + circuit IDs, access link, TapeOut features used, what was built during the event) + demo video ≤3 min.
6. ~~Remove `web/v1.html`~~ — done (removed with `src/` and `server/`; the build deletes any old `public/v1.html`).
7. Factory size: LatchFactory runtime is 21,242 of 24,576 bytes and embeds the whole vault, so a larger
   LatchSwap v2 will not fit. Deploy vaults through a separate deployer or minimal proxies.
Cost estimate: ~0.1 OKB (container 0.08, tapeout ~0.0013, storage gas) + ~0.01 BEM (mint ~120 NAND) + gas.
Every mainnet step: fork rehearsal first, then ask the builder before spending.

## Rules learned the hard way
- Always rehearse on a mainnet fork before any mainnet send; never test only against stand-ins.
- Give one command at a time with what success looks like; scripts must stop with a plain `STOP:` reason.
- Never commit `keeper/.env`. Owner wallet can't be a vault's savings address.
