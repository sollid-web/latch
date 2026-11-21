# Latch — current status (handoff)

Read this first in any new session. Network: X Layer mainnet (chain 196).
Deadline: TapeOut Accelerate, Dec 7 2026. Builder is solo, on Linux, Foundry 1.10.

## Live on mainnet
| What | Address |
|---|---|
| TapeOut processor "Latch Policy" | 0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813 |
| Circuit #1 (13 NAND, allows only 0x7e) | verified on chain: eval(0x7e)=0x01, eval(0x7f)=0x00 |
| **LatchRelay vault (current)** | **0x7952C9B53347518b29016d2EAed8690A9808a2A0** — armed, 4.2 USDT0, caps 2/6 per tx/day |
| Token USDT0 (6 dec) | 0x779Ded0c9e1022225f8E0630b35a9b54bE713736 |
| Owner (key in keeper/.env as OWNER_PRIVATE_KEY) | 0xb4bDEAc86CBdd0C148BB98504e1c35d8451A23a4 (also treasury) |
| Savings (Google-login OKX wallet; receive-only, no exportable key) | 0x9005cb6847903AFC626eB4Dee5137606C567FeE7 |
| Keeper | the address of KEEPER_PRIVATE_KEY in keeper/.env; set on the relay with scripts/set-keeper.sh |
| Old relay (stuck, do not use) | 0xA4b9259279e4D5130FA563cB64B7aB73e2237A02 + container 0xa38E…fCe0 holding 15 USDT0 (TapeOut container fee; see audit/README.md) |

Details and tx hashes: deployments/xlayer-mainnet.json.

## Done
Tape-out, relay deploy (after mainnet-fork rehearsal + on-chain round trip),
fund 5.2 USDT0, arm (1 USDT0 to treasury). Slither 0 findings (102 detectors);
48 tests; independent review applied (audit/INDEPENDENT_REVIEW.md).

## Next
1. `scripts/set-keeper.sh` — point relay at the keeper key in keeper/.env and give it 0.005 OKB.
2. `cd keeper && node daemon.mjs` with THRESHOLD=48 → expect `WATCH hold` (no sweep).
3. Demo: one real sweep (temporarily THRESHOLD above the OKB price, stop after the first SWEPT),
   and a rogue `tick(500 USDT0)` rejected on chain (OverCap). Record ≤3 min video.
4. Put the console online (Cloudflare Workers static assets: `npx wrangler deploy`), README polish, submit.

## Rules learned the hard way
- Never fund a contract before proving on mainnet that money comes back out (golive.sh does this).
- Rehearse on a mainnet fork first: scripts/preflight-fork.sh.
- TapeOut fees moved to BEM (createCPU 0.1, mint 0.01 per call); containers charge 0.0013 OKB per execute.
- OKX Wallet: accounts under the Google-login wallet cannot export keys. Bot keys: generate in the terminal.
- Give the user scripts with built-in checks, not long hand-edited command blocks.
