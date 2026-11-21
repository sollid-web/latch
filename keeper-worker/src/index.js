// Cloudflare Worker entry for the Latch helper bot.
//  - scheduled (cron): checks prices and, if a real dip passes every check, sends tick().
//  - GET /           : a read-only dry run, so anyone can see what the bot would do right now.
//                      It never sends a transaction.
import { runOnce } from './keeper.js';

export default {
  async scheduled(event, env, ctx) {
    try {
      const r = await runOnce(env, { send: true });
      console.log(JSON.stringify({ action: r.action, why: r.why, errors: r.errors, market: r.market, vaults: (r.vaults || []).map((v) => ({ v: v.vault, a: v.action, why: v.why, tx: v.tx })) }));
    } catch (err) {
      console.error('keeper run failed:', (err && (err.shortMessage || err.message)) || err);
    }
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/') return new Response('not found', { status: 404 });
    let body;
    try {
      body = await runOnce(env, { send: false });
    } catch (err) {
      body = { action: 'error', error: String((err && (err.shortMessage || err.message)) || err) };
    }
    return new Response(JSON.stringify(body, null, 2), {
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' }
    });
  }
};
