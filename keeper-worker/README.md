# Latch helper bot — Cloudflare cron Worker

Runs the helper bot 24/7 on Cloudflare (free plan), every minute. No server, and it keeps
running when your computer is off.

Each run: reads the OKB price from OKX, Binance, CoinGecko, Gate and KuCoin → ignores the run if
the exchanges disagree by more than 6% (fake crash on one exchange) → needs at least 2 exchanges
and a majority at or below `THRESHOLD` → asks the vault `preview()` whether all 7 checks pass →
only then sends `tick()`. The vault's own on-chain limits cap what can ever move.

## Deploy (from this folder)

```
npm install
grep KEEPER_PRIVATE_KEY ../keeper/.env | cut -d= -f2 | npx wrangler secret put KEEPER_PRIVATE_KEY
npx wrangler deploy
```

Settings (vault address, threshold, amount) are in `wrangler.jsonc` under `vars`.

## Check it

- Open `https://latch-keeper.<your-subdomain>.workers.dev/` — a read-only dry run: prices, the
  decision, and the vault state. It never sends a transaction.
- `npx wrangler tail` — live log of every cron run.

## Test locally (no real money)

`npm test` deploys the real LatchRelay to a throwaway anvil chain and checks: normal price holds,
a one-exchange crash is ignored, a real dip saves 2 USDT, the daily limit stops the 4th save, and
a wrong key is refused. Needs `anvil` (Foundry) on PATH.
