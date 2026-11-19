# Latch keeper — off-chain dip-sweep daemon

A Node.js script that watches OKB/USDT and calls `LatchRelay.tick(amount)` only
when the market signal is real and the on-chain preview agrees. The keeper key
pays gas and can only call `tick` — it can never pick a destination, raise a
cap, unpause, or rescue.

## Why a script, not a Worker

A Cloudflare Worker's WebCrypto has no secp256k1, so it cannot sign an Ethereum
transaction without reimplementing the curve by hand (the source of the earlier
bugs). This script signs with `viem`, which handles low-s normalisation, chain
id, nonce and gas correctly. The key lives only on the machine that runs it —
never in the page and never in the Worker.

## Run

```sh
cp env.example .env    # fill in real values
npm install
node daemon.mjs
```

Run one instance at a time (nonce management is single-process).

## Environment

| Variable | Required | Meaning |
| --- | --- | --- |
| `KEEPER_PRIVATE_KEY` | yes | the gas-only keeper key (`0x` + 64 hex) |
| `RPC_URL` | yes | X Layer RPC, e.g. `https://rpc.xlayer.tech` |
| `RELAY_ADDRESS` | yes | the deployed `LatchRelay` address |
| `HEARTBEAT_URL` | no | Worker `/api/heartbeat` endpoint for the status page |
| `KEEPER_TOKEN` | no | the Worker's `KEEPER_TOKEN` secret (status only, not the keeper key) |
| `THRESHOLD` / `SWEEP_USDT` | no | default 48 OKB / 50 USDT, matching the relay |

## Safety model (all off-chain, zero re-tapes)

1. **Multi-source consensus** — OKX, Binance and CoinGecko. A dip must be seen
   by at least two venues.
2. **Short TWAP fallback** — if consensus is impossible (rate limit / missing
   pair), the 5–10 minute rolling average must also be a dip.
3. **Volatility breaker** — an hourly sigma above `BREAKER_SIGMA` or a
   single-venue spread above `BREAKER_SWING_PCT` pauses the keeper for
   `BREAKER_COOLDOWN_MS` and skips execution until the market normalises.

The breaker's pause is internal to the daemon. It never touches the relay's
`paused` bit (owner-only), so the separation stays clean: the circuit decides
what money may move, the keeper decides whether the market signal is real.

## Security notes

- Keep `.env` out of version control. The key is gas-only, but it is still a key.
- `HEARTBEAT_URL`/`KEEPER_TOKEN` carry status only — never a key or an amount.
- The daemon reads the token's real `decimals()` and scales `SWEEP_USDT` with
  it, so `50` means 50 USDT on 6-decimal X Layer USDT. Relay caps are in the
  token's base units, set at deploy.
- `preview` is called with `from` = the keeper, because the relay reports the
  keeper bit from `msg.sender`.
