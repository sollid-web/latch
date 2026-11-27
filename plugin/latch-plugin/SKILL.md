---
name: latch-plugin
description: "Latch on X Layer: set up and manage a vault that buys OKB on dips or takes profit on rises, with every trade sized by a TapeOut circuit on chain. Signs with the OKX Agentic Wallet (onchainos wallet contract-call) after the user confirms each transaction. Trigger phrases: buy OKB on dips, DCA OKB, auto-buy OKB, take profit on OKB, latch vault, set up a latch, pause my latch, how is my latch vault doing"
version: "0.1.0"
author: "sollid-web"
tags:
  - xlayer
  - okb
  - dca
  - take-profit
  - tapeout
---

# Latch (X Layer)

## Overview

Latch is automatic OKB trading from a vault the user controls, on X Layer (chain 196).

- **Buy OKB:** the vault holds USDT0 and buys OKB.
- **Take profit:** the vault holds WOKB and sells it for USDT0.
- The output of every trade goes **straight to the wallet the user chose**.

Every trade is sized on chain by TapeOut circuit #2 (101 NAND gates on processor `0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813`). It answers wait, 1×, 2× or 3× the base amount, from:
- how far OKB's 30-minute average has moved from the user's reference price
- how jumpy the market is
- the strategy
- 7 safety checks

Strategies (`--mode`):

| Mode | Buy vault | Take Profit vault |
|---|---|---|
| `steady` | the same amount every time (DCA) | sells the same amount every time, never under the floor |
| `dips` | buys only below the reference price | ("rises only") sells only above the reference price |
| `smart` | 2× from a 10% dip, 3× from 20%; 1× when jumpy; waits when very jumpy | the same, on rises |
| `ladder` | 1× from a 5% dip, 2× from 15%, 3× from 30% | the same, on rises |

What a vault's agent can and can't do:
- **It can:** only trigger trades.
- **It can't:** withdraw, raise limits, change the strategy or send funds anywhere except the chosen wallet.
- **Only the owner can:** withdraw (any time), pause, change the strategy, or lower the limits. Limits can never be raised.

**Fee:** 1% of each trade, falling to 0.25% with volume. Latch's hosted agent pays the gas when it trades.

The `latch` tool reads the chain and **prepares** transactions. It never holds, asks for or sees a private key. The user's **OKX Agentic Wallet** signs every transaction with `onchainos wallet contract-call`, inside OKX's TEE, and only after the user confirms it.

## Install the `latch` tool (once)

Installing this skill adds these instructions, not the `latch` command. Check with `latch --help`. If that fails, install it from npm:

```
npm install -g latch-xlayer
```

- Or run it without installing: `npx -y latch-xlayer <command>` wherever this skill says `latch <command>`.
- Needs Node.js 18 or newer.
- If npm is unavailable, install from source: `git clone https://github.com/sollid-web/latch ~/.latch && cd ~/.latch/agent && npm install && npm link` (or use `node ~/.latch/agent/latch.mjs`).
- Signing needs the OKX Agentic Wallet CLI, `onchainos` (OKX's Onchain OS skills). This skill never asks for a private key.

## Pre-flight Checks

0. `latch --help`. If it fails, do "Install the `latch` tool" above first.
1. `onchainos wallet status`. If not logged in, follow `onchainos wallet login`.
2. `onchainos wallet addresses`. Use the **EVM address** for X Layer (chain `196`) as `<wallet>` below.
3. `latch market`. If it returns an error, X Layer's RPC is unreachable; tell the user and stop.

## Commands

Every command prints JSON. Commands that change anything return a `transactions` array. Each entry has:
- `description`: one line in plain words
- `to`, `inputData`, `amt`, `chain`
- `onchainos`: the ready command

### Read (no signing)

| Command | What it returns |
|---|---|
| `latch market` | OKB price as vaults see it: 30-minute average, live price, how jumpy the market is |
| `latch try --dir buy\|sell --mode <mode> --ref <price> --limit <price> [--base <amount>]` | What a vault with these settings would do **right now**, answered by the real chip on X Layer. Use it to help the user choose settings. |
| `latch vaults --owner <address>` | The owner's vaults with settings, balances and totals |
| `latch status --vault <vault>` | One vault, plus `now`: whether it trades now, the size, what the chip sees, and why it waits |

### Write (returns transactions to sign)

| Command | Notes |
|---|---|
| `latch create --dir buy\|sell --mode <mode> --savings <address> --base <amount> --ref <price> --limit <price> [--per-trade <amount>] [--daily <amount>] [--every any\|hour\|day\|week] [--keeper <address>]` | `--base` is in USDT0 for `buy` (at least 1) and OKB for `sell` (at least 0.01). `--limit` is the ceiling for buys and the floor for sells. `--per-trade` and `--daily` default to the strategy's largest size. `--every` defaults to `day`. Leave out `--keeper` to use Latch's hosted agent. |
| `latch fund --vault <vault> --amount <amount>` | USDT0 for Buy vaults, WOKB for Take Profit vaults |
| `latch wrap --amount <okb>` | OKB → WOKB (1:1). Needed before funding a Take Profit vault from plain OKB. |
| `latch pause --vault <vault>` / `latch resume --vault <vault>` | Owner only |
| `latch strategy --vault <vault> [--mode] [--base] [--ref] [--limit] [--every]` | Owner only. Limits can't be raised; `--base` must stay at or under the per-trade limit. |
| `latch withdraw --vault <vault> --to <address>` | Owner only. Takes everything out; may return two transactions. |
| `latch tick --vault <vault> --as <wallet>` | Only when `<wallet>` is the vault's own agent. Returns a trade transaction if the chip allows it now; otherwise returns the reason and an empty `transactions` list. |

### Signing a returned transaction (OKX Agentic Wallet)

For each entry of `transactions`, **in order**:

1. Show the user `description` and ask for confirmation. **Never sign without it,** except `tick` in a keeper loop the user has already approved.
2. Run exactly:
   ```bash
   onchainos wallet contract-call --to <to> --chain 196 --input-data <inputData> --amt <amt>
   ```
   Use the fields unchanged: never edit, re-encode or shorten `inputData`.
3. Wait for the txHash and confirmation before the next entry. If one fails, stop and report what succeeded.

## Typical flows

**"Buy OKB on dips for me, 5 USDT0 a week, never above 100":**
1. `latch market`. Suggest a reference price above today's average, for example 10% above.
2. `latch try --dir buy --mode smart --ref <ref> --limit 100 --base 5` to show what it would do right now.
3. `latch create --dir buy --mode smart --savings <user wallet> --base 5 --ref <ref> --limit 100 --every week`, then sign.
4. `latch vaults --owner <wallet>` to find the new vault.
5. `latch fund --vault <vault> --amount <USDT0>`, then sign.
6. Tell the user: Latch's agent checks every minute; the OKB arrives in `<user wallet>`; the page is `https://okblatch.xyz/#/vaults`.

**"Take profit as OKB rises":** the same, with `--dir sell` and `--limit` as the floor. First `latch wrap` if the wallet holds only OKB.

**"How is my vault doing?":** `latch status --vault <vault>`. Report `now.why`, the balance, what was bought or received, and the average price.

**The Agentic Wallet as the vault's own agent** (create with `--keeper <wallet>`): when the user asks, check periodically with `latch tick --vault <vault> --as <wallet>`. If `transactions` is not empty, sign it. The vault and chip enforce every limit, so the agent can't trade more, more often or at a worse price than the owner allowed.

## Error Handling

| Output | Meaning and what to do |
|---|---|
| `{"error": "missing --…"}` / `"… is not valid"` | Ask the user for that value |
| `"--base must be at least …"` | Below the minimum trade (1 USDT0 or 0.01 OKB) |
| `"that address is Latch's fee wallet"` | Ask for another `--savings` wallet |
| `"--base can be at most the per-trade limit"` | Limits can only be lowered; to trade bigger, create a new vault |
| `status.now.why` / `tick.why` | Plain reason the vault is waiting: say it as is |
| `contract-call` reverts with `NotOwner` | The signing wallet doesn't own this vault |
| `contract-call` reverts with `BadSavings` | The output wallet isn't allowed (the vault's agent, the fee wallet or another vault) |

## Security Notices

- The tool never asks for, stores or uses private keys. Signing happens only in the OKX Agentic Wallet.
- Always confirm each write with the user, showing `description`.
- **Funds:** only the vault owner can withdraw. A vault's agent can only trigger trades within the owner's limits, at a price within about 1% of Uniswap's 30-minute average and inside the owner's ceiling or floor, with the output only to the chosen wallet.
- **Risks:** OKB's price can keep falling after a buy or keep rising after a sale. USDT0's issuer can freeze addresses. The contracts are open source and independently reviewed but not professionally audited, so start small. Not financial advice.
- **External calls:** the X Layer RPC (`rpc.xlayer.tech`) only.
