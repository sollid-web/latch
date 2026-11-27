// Cloudflare Worker entry for the Latch helper bot.
//  - scheduled, every minute: checks prices and, if a real dip passes every check, sends tick().
//  - scheduled, every 2 minutes: records Latch trades (read-only) for the website's full history.
//  - GET /           : a read-only dry run, so anyone can see what the bot would do right now.
//                      It never sends a transaction.
//  - GET /trades     : every Latch trade found on chain so far (vault, tx hash, amounts, chip size).
import { runOnce } from './keeper.js';
import { recordTrades, readTrades } from './trades.js';

const RECORDER_CRON = '*/2 * * * *'; // must match the second entry in wrangler.jsonc triggers
const JSON_HEADERS = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === RECORDER_CRON) { // its own schedule, so it never competes with trading for the per-run request limit
      if (!env.TRADES) return;
      try {
        const t = await recordTrades({ kv: env.TRADES, rpc: env.RPC_URL || 'https://rpc.xlayer.tech',
          factories: [env.FACTORY_ADDRESS, env.FACTORY2_ADDRESS], requests: Number(env.TRADE_SCAN_REQUESTS || 40) });
        console.log(JSON.stringify({ trades: t }));
      } catch (err) {
        console.error('trade recorder failed:', (err && (err.shortMessage || err.message)) || err);
      }
      return;
    }
    try {
      const r = await runOnce(env, { send: true });
      console.log(JSON.stringify({ action: r.action, why: r.why, errors: r.errors, market: r.market, vaults: (r.vaults || []).map((v) => ({ v: v.vault, a: v.action, why: v.why, tx: v.tx })) }));
    } catch (err) {
      console.error('keeper run failed:', (err && (err.shortMessage || err.message)) || err);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/trades') {
      let body;
      try { body = await readTrades(env.TRADES); } catch (err) { body = { complete: false, trades: [], error: String(err?.message || err) }; }
      return new Response(JSON.stringify(body), { headers: { ...JSON_HEADERS, 'cache-control': 'public, max-age=30' } });
    }
    if (url.pathname !== '/') return new Response('not found', { status: 404 });
    let body;
    try {
      body = await runOnce(env, { send: false });
    } catch (err) {
      body = { action: 'error', error: String((err && (err.shortMessage || err.message)) || err) };
    }
    return new Response(JSON.stringify(body, null, 2), { headers: { ...JSON_HEADERS, 'cache-control': 'no-store' } });
  }
};
