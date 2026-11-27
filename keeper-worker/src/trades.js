/**
 * Trade recorder: keeps a complete list of every Latch trade (classic Bought + v2 Traded events)
 * in Workers KV, so the website can show full history.
 *
 * Why: the public X Layer RPC answers eth_getLogs for at most ~100 blocks per call, so a web page
 * can only find a vault's latest trade. The bot already runs every minute, so it walks the chain
 * forward in 100-block windows (many windows per JSON-RPC batch = one Cloudflare subrequest),
 * from the first factory's deployment to the tip, and stores what it finds.
 *
 * Read-only: no keys, no transactions. Anyone can re-check every entry on OKLink by its tx hash.
 * KV writes are kept low (free plan: 1,000/day): it saves when it found trades, while catching up,
 * or at most every ~30 minutes otherwise. Re-scanning a window after a restart is harmless
 * (entries are keyed by tx hash + log index).
 */
import { decodeEventLog, parseAbi, toEventSelector, numberToHex } from 'viem';

export const EVENTS = parseAbi([
  'event Bought(address indexed keeper, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 twapPrice, uint8 bits)',
  'event Traded(address indexed keeper, uint8 direction, uint256 amountIn, uint256 amountOut, uint256 fee, uint256 twapPrice, uint16 inputs, uint8 multiplier)'
]);
const TOPICS = EVENTS.map((e) => toEventSelector(e));
const KEY = 'trades.v1';
const MAX_KEEP = 5000;

async function rpcBatch(url, calls, fetchFn = fetch) {
  const body = calls.map((c, i) => ({ jsonrpc: '2.0', id: i, method: c.method, params: c.params }));
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error('rpc http ' + r.status);
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error('rpc did not answer a batch: ' + JSON.stringify(j).slice(0, 120));
  const byId = new Map(j.map((x) => [x.id, x]));
  return calls.map((_, i) => {
    const x = byId.get(i);
    if (!x || x.error) throw new Error('rpc error: ' + JSON.stringify(x?.error || 'missing').slice(0, 160));
    return x.result;
  });
}

/** A block at or before unix time `ts`, from block timestamps (every node keeps headers; old state it may not).
 *  A few estimate-and-correct steps from the average block time: about 6 requests. */
async function blockAtTime(url, ts, head, fetchFn) {
  const timeOf = async (n) => { const [b] = await rpcBatch(url, [{ method: 'eth_getBlockByNumber', params: [numberToHex(n), false] }], fetchFn); return Number(BigInt(b.timestamp)); };
  const tHead = await timeOf(head);
  if (ts >= tHead) return head;
  let probe = head > 200_000n ? head - 200_000n : 0n;
  let tProbe = await timeOf(probe);
  let guess = head;
  for (let i = 0; i < 5; i++) {
    const rate = (tHead - tProbe) / Number(head - probe || 1n); // seconds per block
    guess = head - BigInt(Math.ceil((tHead - ts) / Math.max(rate, 0.01)));
    if (guess < 0n) guess = 0n;
    const tg = await timeOf(guess);
    if (tg <= ts && ts - tg < 600) return guess;
    probe = guess; tProbe = tg;
    if (tg > ts) continue;
  }
  return guess > 2000n ? guess - 2000n : 0n; // close enough; start a little earlier
}

function decode(log, v2set) {
  try {
    const ev = decodeEventLog({ abi: EVENTS, data: log.data, topics: log.topics });
    const a = ev.args;
    const vault = log.address.toLowerCase();
    const isV2 = ev.eventName === 'Traded';
    return {
      id: log.transactionHash + ':' + Number(log.logIndex),
      vault, version: isV2 || v2set.has(vault) ? 2 : 1,
      hash: log.transactionHash, block: Number(log.blockNumber),
      dir: isV2 ? Number(a.direction) : 0,
      inn: a.amountIn.toString(), out: a.amountOut.toString(), fee: a.fee.toString(), price: a.twapPrice.toString(),
      k: isV2 ? Number(a.multiplier) : 1
    };
  } catch { return null; }
}

/**
 * One step of catching up. `vaults1/vaults2` are the factories' vault lists (the bot reads them anyway).
 * opts: { kv, rpc, factories, windowSize=100, perBatch=25, batches=6, fetchFn, now }
 */
export async function recordTrades(opts) {
  const { kv, rpc, factories, vaults1 = [], vaults2 = [] } = opts;
  const windowSize = BigInt(opts.windowSize || 100), perBatch = opts.perBatch || 25, batches = opts.batches || 6;
  const fetchFn = opts.fetchFn || fetch;
  if (!kv) return { skipped: 'no TRADES KV binding' };
  const addrs = [...vaults1, ...vaults2].map((a) => a.toLowerCase());
  const state = (await kv.get(KEY, 'json')) || { cursor: null, start: null, trades: [], savedAt: 0 };
  const [headHex] = await rpcBatch(rpc, [{ method: 'eth_blockNumber', params: [] }], fetchFn);
  const head = BigInt(headHex) - 2n; // stay a couple of blocks behind the tip
  if (state.cursor === null) {
    try {
      // Latch's first factory went live on 21 November 2026; nothing to find before that.
      const since = Math.floor(Date.parse(opts.since || '2026-11-21T00:00:00Z') / 1000);
      const start = await blockAtTime(rpc, since, head, fetchFn);
      state.start = Number(start); state.cursor = Number(start);
    } catch (err) {
      state.error = 'could not find the start block: ' + String(err.message || err).slice(0, 160);
      return save(kv, state, true, 0, opts.now);
    }
  }
  if (!addrs.length) { state.cursor = Number(head); return save(kv, state, true, 0); }

  const v2set = new Set(vaults2.map((a) => a.toLowerCase()));
  const per = state.noBatch ? 1 : perBatch; // some RPCs refuse JSON-RPC batches: then one window per request
  const seen = new Set(state.trades.map((t) => t.id));
  let cursor = BigInt(state.cursor), found = 0;
  for (let b = 0; b < batches && cursor <= head; b++) {
    const calls = [];
    for (let i = 0; i < per && cursor <= head; i++) {
      const to = cursor + windowSize - 1n < head ? cursor + windowSize - 1n : head;
      calls.push({ method: 'eth_getLogs', params: [{ address: addrs, topics: [TOPICS], fromBlock: numberToHex(cursor), toBlock: numberToHex(to) }] });
      cursor = to + 1n;
    }
    let results;
    try { results = await rpcBatch(rpc, calls, fetchFn); }
    catch (err) { // keep what we have; the cursor only moves past windows that answered
      cursor = BigInt(calls[0].params[0].fromBlock);
      if (/batch/i.test(String(err.message)) && calls.length > 1) state.noBatch = true;
      state.error = String(err.message || err).slice(0, 200);
      break;
    }
    for (const logs of results) for (const l of logs || []) {
      const t = decode(l, v2set);
      if (t && !seen.has(t.id)) { seen.add(t.id); state.trades.push(t); found++; }
    }
    delete state.error;
  }
  state.cursor = Number(cursor);
  state.head = Number(head);
  state.trades.sort((a, b) => b.block - a.block);
  if (state.trades.length > MAX_KEEP) state.trades.length = MAX_KEEP;
  const catchingUp = BigInt(state.cursor) < head - 5n;
  const due = (opts.now ?? Date.now()) - (state.savedAt || 0) > 30 * 60 * 1000;
  return save(kv, state, found > 0 || catchingUp || due, found, opts.now);
}

async function save(kv, state, write, found, now = Date.now()) {
  if (write) { state.savedAt = now; await kv.put(KEY, JSON.stringify(state)); }
  return { found, cursor: state.cursor, head: state.head, start: state.start, total: state.trades.length, saved: write, error: state.error };
}

/** What GET /trades returns. */
export async function readTrades(kv) {
  const s = kv ? await kv.get(KEY, 'json') : null;
  if (!s) return { complete: false, trades: [], note: 'nothing recorded yet: the agent records on its next runs' };
  return { complete: s.cursor != null && s.cursor >= (s.head ?? s.cursor) - 50, start: s.start, scannedTo: s.cursor, head: s.head, error: s.error, trades: s.trades };
}
