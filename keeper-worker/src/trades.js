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
import { decodeEventLog, parseAbi, toEventSelector, numberToHex, encodeFunctionData } from 'viem';

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
  const timeOf = async (n) => { const b = await one(url, 'eth_getBlockByNumber', [numberToHex(n), false], fetchFn); return Number(BigInt(b.timestamp)); };
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
  const { kv, rpc } = opts;
  const fetchFn = opts.fetchFn || fetch;
  if (!kv) return { skipped: 'no TRADES KV binding' };
  const state = (await kv.get(KEY, 'json')) || { cursor: null, start: null, trades: [], savedAt: 0 };
  // vault lists: given by the caller, or read from the factories (only new entries each run)
  let vaults1 = opts.vaults1, vaults2 = opts.vaults2;
  if (!vaults1 || !vaults2) {
    state.v1 = state.v1 || []; state.v2 = state.v2 || [];
    for (const [f, key] of [[opts.factories?.[0], 'v1'], [opts.factories?.[1], 'v2']]) {
      if (!f) continue;
      const n = Number(BigInt(await call(rpc, f, 'vaultCount', [], fetchFn)));
      for (let i = state[key].length; i < n; i++) state[key].push(decodeAddr(await call(rpc, f, 'vaults', [BigInt(i)], fetchFn)).toLowerCase());
    }
    vaults1 = state.v1; vaults2 = state.v2;
  }
  const addrs = [...vaults1, ...vaults2].map((a) => a.toLowerCase());
  const head = BigInt(await one(rpc, 'eth_blockNumber', [], fetchFn)) - 2n; // stay a couple of blocks behind the tip
  if (state.cursor === null) {
    try {
      // Latch's first factory went live on 21 November 2026; nothing to find before that.
      const since = Math.floor(Date.parse(opts.since || '2026-11-21T00:00:00Z') / 1000);
      const startBlock = await blockAtTime(rpc, since, head, fetchFn);
      state.start = Number(startBlock); state.cursor = Number(startBlock);
    } catch (err) {
      state.error = 'could not find the start block: ' + String(err.message || err).slice(0, 160);
      return save(kv, state, true, 0, opts.now);
    }
  }
  if (!addrs.length) { state.cursor = Number(head) + 1; state.head = Number(head); return save(kv, state, true, 0, opts.now); }

  // Adaptive: the window (blocks per eth_getLogs) and the batch size (windows per HTTP request) start large
  // and halve when the RPC refuses, down to 100 blocks and one window per request. Remembered between runs.
  const minWin = BigInt(opts.minWindow || 100);
  if (!state.rangeHit && state.window != null && state.window < (opts.windowSize || 2000)) state.window = null; // only a real range refusal may keep it small
  let win = BigInt(state.window || opts.windowSize || 2000); if (win < minWin) win = minWin;
  let per = state.perBatch ?? (opts.perBatch || 25);
  const requests = opts.requests || 6;
  const v2set = new Set(vaults2.map((a) => a.toLowerCase()));
  const seen = new Set(state.trades.map((t) => t.id));

  // Paced: send `par` requests at a time (spread over the RPC endpoints), keep the contiguous prefix that
  // answered, and adapt: rate limit → halve the pace and pause; a clean wave → one more next time.
  let rpcs = (opts.rpcs && opts.rpcs.length ? [...opts.rpcs] : [rpc]);
  const maxPar = opts.maxParallel || 8;
  let par = Math.min(state.par || opts.parallel || 2, maxPar);
  const q = (a, b) => ({ method: 'eth_getLogs', params: [{ address: addrs, topics: [TOPICS], fromBlock: numberToHex(a), toBlock: numberToHex(b) }] });
  const urlOf = (i) => rpcs[i % rpcs.length];
  const send = (g, i) => { const url = urlOf(i); return per <= 1 && g.length === 1 ? one(url, 'eth_getLogs', q(...g[0]).params, fetchFn).then((x) => [x]) : rpcBatch(url, g.map((w) => q(...w)), fetchFn); };
  let cursor = BigInt(state.cursor), found = 0, used = 0, waves = 0, rr = state.rr || 0;
  delete state.error;
  outer: while (used < requests && cursor <= head) {
    const groups = []; let c = cursor;
    for (let r = 0; r < par && used + groups.length < requests && c <= head; r++) {
      const g = [];
      for (let i = 0; i < Math.max(per, 1) && c <= head; i++) { const to = c + win - 1n < head ? c + win - 1n : head; g.push([c, to]); c = to + 1n; }
      groups.push(g);
    }
    used += groups.length; waves++;
    const settled = await Promise.allSettled(groups.map((g, i) => send(g, rr + i)));
    rr += groups.length;
    for (let i = 0; i < groups.length; i++) {
      const r = settled[i];
      if (r.status !== 'fulfilled') {
        const msg = String(r.reason?.message || r.reason);
        if (/rate.?limit|too many requests|429|-32016|-32005|capacity|throttl/i.test(msg)) {
          par = Math.max(1, Math.floor(par / 2)); state.par = par; state.rateLimited = (state.rateLimited || 0) + 1;
          await new Promise((res) => setTimeout(res, opts.pauseMs ?? 1500));
          continue outer; // carry on from the last window that answered, slower
        }
        if (/batch/i.test(msg) && per > 1) { state.perBatch = Math.max(1, Math.floor(per / 2)); break outer; }
        if (/range|exceed|too (large|big)|max.*block|block.*(limit|range)/i.test(msg) && win > minWin) { state.window = Number(win / 2n < minWin ? minWin : win / 2n); state.rangeHit = true; break outer; }
        if (rpcs.length > 1) { // that endpoint is down or refuses: drop it for this run, carry on with the others
          const bad = urlOf(rr - groups.length + i); rpcs = rpcs.filter((u) => u !== bad);
          state.skipped = bad + ': ' + msg.slice(0, 120);
          continue outer;
        }
        state.error = msg.slice(0, 200);
        break outer;
      }
      for (const logs of r.value) for (const l of logs || []) {
        const t = decode(l, v2set);
        if (t && !seen.has(t.id)) { seen.add(t.id); state.trades.push(t); found++; }
      }
      cursor = groups[i][groups[i].length - 1][1] + 1n;
    }
    if (settled.every((x) => x.status === 'fulfilled')) { par = Math.min(maxPar, par + 1); state.par = par; }
  }
  state.rr = rr % 1000;
  if (state.window == null) state.window = Number(win);   // report the block window actually in use
  if (state.perBatch == null) state.perBatch = per;
  state.cursor = Number(cursor);
  state.head = Number(head);
  state.trades.sort((a, b) => b.block - a.block);
  if (state.trades.length > MAX_KEEP) state.trades.length = MAX_KEEP;
  const catchingUp = BigInt(state.cursor) < head - 5n;
  const due = (opts.now ?? Date.now()) - (state.savedAt || 0) > 30 * 60 * 1000;
  return save(kv, state, found > 0 || catchingUp || due || !!state.error, found, opts.now);
}

const FACT = parseAbi(['function vaultCount() view returns (uint256)', 'function vaults(uint256) view returns (address)']);
async function call(rpc, to, fn, args, fetchFn) {
  return one(rpc, 'eth_call', [{ to, data: encodeFunctionData({ abi: FACT, functionName: fn, args }) }, 'latest'], fetchFn);
}
const decodeAddr = (hex) => '0x' + hex.slice(-40);
/** One JSON-RPC request (not a batch: some RPCs refuse batches). */
async function one(url, method, params, fetchFn = fetch) {
  const r = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  if (!r.ok) throw new Error('rpc http ' + r.status);
  const j = await r.json();
  if (j.error) throw new Error('rpc error: ' + JSON.stringify(j.error).slice(0, 160));
  return j.result;
}

async function save(kv, state, write, found, now = Date.now()) {
  if (write) { state.savedAt = now; await kv.put(KEY, JSON.stringify(state)); }
  return { found, cursor: state.cursor, head: state.head, start: state.start, total: state.trades.length, saved: write, error: state.error };
}

/** What GET /trades returns. */
export async function readTrades(kv) {
  const s = kv ? await kv.get(KEY, 'json') : null;
  if (!s) return { complete: false, trades: [], note: 'nothing recorded yet: the agent records on its next runs' };
  return { complete: s.cursor != null && s.cursor >= (s.head ?? s.cursor) - 50, start: s.start, scannedTo: s.cursor, head: s.head,
    blocksPerRequest: s.window || 2000, windowsPerRequest: s.perBatch ?? 25, parallel: s.par, rateLimitedRuns: s.rateLimited, lastSkippedEndpoint: s.skipped, error: s.error, trades: s.trades };
}
