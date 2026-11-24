# latch-plugin

## Overview

Latch lets an AI agent set up and manage automatic OKB trading on X Layer from a vault the user controls:

- **Buy OKB** on dips or on a schedule.
- **Take profit** as OKB rises.

A 101-gate TapeOut circuit on chain decides the size of every trade (wait, 1×, 2× or 3×). The output always goes straight to the user's chosen wallet. The vault's bot can only trigger trades within the owner's limits; it can never withdraw or raise a limit.

The `latch` tool reads X Layer and prepares transactions. The user's **OKX Agentic Wallet** signs them with `onchainos wallet contract-call`, so no private key ever reaches the tool or the model.

## Prerequisites

- onchainos CLI, logged in to the OKX Agentic Wallet (`onchainos wallet login`)
- Some USDT0 (for a Buy vault) or OKB/WOKB (for a Take Profit vault) on X Layer

## Quick Start

```bash
latch market                                                     # OKB price as vaults see it
latch try --dir buy --mode smart --ref 95 --limit 100 --base 2   # what a vault would do right now (real chip)
latch create --dir buy --mode smart --savings <your wallet> --base 2 --ref 95 --limit 100   # → sign with onchainos wallet contract-call
latch vaults --owner <your Agentic Wallet address>
latch fund --vault <vault> --amount 10                           # → sign
latch status --vault <vault>
```

Web app: https://latch.tapeguard.workers.dev · On chain (DeWEB): https://2-2-435.tapekit.org/ · Source: https://github.com/sollid-web/latch
