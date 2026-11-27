/**
 * Latch hosted helper bot — one pass over every vault created by the LatchFactory.
 *
 * Runs on a Cloudflare cron every minute. Each run:
 *   1. reads the OKB price from several exchanges (needs at least 2 to answer),
 *   2. reads the Uniswap pool's 30-min average price (via a vault's quote()),
 *   3. if the pool and the exchanges disagree by more than MAX_DIVERGENCE_PCT, buys nothing
 *      (someone may be manipulating the pool — review M-1),
 *   4. for each vault that names this bot as its keeper: picks the largest allowed amount,
 *      asks the vault's preview() (all 7 checks incl. the user's price ceiling and spacing),
 *      simulates the swap with eth_estimateGas, and only then sends tick() with 50% gas headroom.
 *
 * The strategy (buy the dip vs. daily/weekly DCA) lives in each vault's own on-chain settings
 * (maxPrice, minInterval), so the bot needs no per-user configuration and cannot override it.
 * No state is kept between runs.
 *
 * Fairness and cost (review v3 H-1): all vaults are paged through; each run checks a rotating
 * window of MAX_CHECKS_PER_RUN vaults (so early vaults cannot hog the bot), reads are batched
 * into single JSON-RPC requests (Cloudflare counts subrequests), at most MAX_SENDS_PER_RUN buys
 * are sent per run with explicit nonces, and a run that finds its own earlier transaction still
 * pending sends nothing (no overlapping runs). Vaults also enforce a minimum buy on chain.
 */
import { createPublicClient, createWalletClient, http, parseAbi, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const VAULT_ABI = parseAbi([
  'function feeBpsNow() view returns (uint256)',
  'function tick(uint256 amount)',
  'function preview(uint256 amount) view returns (uint8 bits, bool allow)',
  'function quote(uint256 amount) view returns (uint256 twapPrice, uint256 expectedOut, uint256 minOut)',
  'function minAmount() view returns (uint256)',
  'function status() view returns (address token_, bool armed_, bool paused_, uint256 balance_, uint256 perTxCap_, uint256 dailyCap_, uint256 spentToday_, address keeper_, address savings_, address treasury_)'
]);
// v2 vaults (LatchFactory2 clones): Buy or Take Profit; the strategy chip (circuit #2) sizes each trade
// on chain, so the bot only asks preview(bot) and, if the amount is above 0, sends tick().
export const VAULT2_ABI = parseAbi([
  'function tick()',
  'function preview(address caller) view returns (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut, uint256 avgPrice)',
  'function keeper() view returns (address)',
  'function direction() view returns (uint8)',
  'function twapPrice() view returns (uint256)',
  'function nextTradeAt() view returns (uint256)',
  'function spentTodayNow() view returns (uint256)',
  'function dailyCap() view returns (uint256)',
  'function minAmount() view returns (uint256)',
  'function tokenIn() view returns (address)',
  'function chip(uint16 inputs) view returns (bool allow, uint8 k)'
]);
const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);
export const FACTORY_ABI = parseAbi([
  'function vaultCount() view returns (uint256)',
  'function vaultsPage(uint256 start, uint256 count) view returns (address[])'
]);

/* ------------------------------------------------------------ prices */

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'latch-keeper/2.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** The price from an exchange answer, or a plain reason why there is none (never a code crash). */
export function priceFrom(json, pick) {
  let v;
  try { v = pick(json); } catch { v = undefined; }
  if (v === undefined || v === null || v === '') {
    const said = json && (json.msg || json.message || json['err-msg'] || json.label || json.error);
    throw new Error(said ? `no OKB/USDT price: ${String(typeof said === 'string' ? said : JSON.stringify(said)).slice(0, 80)}`
      : 'no OKB/USDT price in the answer (pair not listed there?)');
  }
  return Number(v);
}

export const SOURCES = [
  { venue: 'OKX', get: async () => priceFrom(await getJson('https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT'), (j) => j.data[0].last) },
  { venue: 'CoinGecko', get: async () => priceFrom(await getJson('https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd'), (j) => j.okb.usd) },
  { venue: 'Gate', get: async () => priceFrom(await getJson('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=OKB_USDT'), (j) => j[0].last) },
  { venue: 'KuCoin', get: async () => priceFrom(await getJson('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=OKB-USDT'), (j) => j.data.price) },
  { venue: 'MEXC', get: async () => priceFrom(await getJson('https://api.mexc.com/api/v3/ticker/price?symbol=OKBUSDT'), (j) => j.price) },
  // Checked live from Cloudflare (2026-11-24): Gate, MEXC, LBank and XT answer; OKX, CoinGecko and KuCoin are
  // rate-limited at times. Binance, Bitget (blocked), HTX (no OKB), CoinPaprika, CryptoCompare (paid key), BitMart
  // and CoinEx (errors) were removed to stay within Cloudflare's free-plan request budget.
  { venue: 'LBank', get: async () => priceFrom(await getJson('https://api.lbkex.com/v2/ticker/24hr.do?symbol=okb_usdt'), (j) => j.data[0].ticker.latest) },
  { venue: 'XT', get: async () => priceFrom(await getJson('https://sapi.xt.com/v4/public/ticker/price?symbol=okb_usdt'), (j) => j.result[0].p) },
];

export async function fetchPrices(sources = SOURCES) {
  return Promise.all(sources.map(async (s) => {
    try {
      const price = await s.get();
      if (!Number.isFinite(price) || price <= 0) return { venue: s.venue, ok: false, error: 'bad value' };
      return { venue: s.venue, ok: true, price };
    } catch (err) {
      return { venue: s.venue, ok: false, error: String((err && err.message) || err) };
    }
  }));
}

export function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Pure check: do the exchanges agree with each other and with the pool? */
export function marketCheck(prices, poolPrice, maxDivergencePct, maxSpreadPct = 6) {
  const ok = prices.filter((p) => p.ok);
  if (ok.length < 2) return { safe: false, reason: `only ${ok.length} exchange(s) answered — need 2` };
  const cex = median(ok.map((p) => p.price));
  const spread = Math.max(...ok.map((p) => (Math.abs(p.price - cex) / cex) * 100));
  if (spread > maxSpreadPct) return { safe: false, cex, reason: `exchanges disagree by ${spread.toFixed(1)}%` };
  const div = (Math.abs(poolPrice - cex) / cex) * 100;
  if (div > maxDivergencePct) {
    return { safe: false, cex, pool: poolPrice, reason: `pool price ${poolPrice.toFixed(2)} is ${div.toFixed(1)}% away from exchanges ${cex.toFixed(2)} — not buying` };
  }
  return { safe: true, cex, pool: poolPrice, divergencePct: Number(div.toFixed(2)) };
}

/* ------------------------------------------------------------ config */

export function readConfig(env) {
  const cfg = {
    key: String(env.KEEPER_PRIVATE_KEY || '').trim(),
    rpc: String(env.RPC_URL || 'https://rpc.xlayer.tech'),
    factory: String(env.FACTORY_ADDRESS || ''),
    factory2: String(env.FACTORY2_ADDRESS || ''),
    maxGas: BigInt(env.MAX_GAS_PER_TRADE || 2_500_000),
    feeMustCoverGas: String(env.REQUIRE_FEE_COVERS_GAS || '') === '1',
    chainId: Number(env.CHAIN_ID || 196),
    maxDivergencePct: Number(env.MAX_DIVERGENCE_PCT || 2),
    maxSends: Number(env.MAX_SENDS_PER_RUN || 3),
    maxChecks: Number(env.MAX_CHECKS_PER_RUN || 25),
    maxGasGwei: BigInt(env.MAX_GAS_GWEI || 50)
  };
  const errors = [];
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.key)) errors.push('KEEPER_PRIVATE_KEY secret is missing or not 0x + 64 hex');
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  if (cfg.factory && !isAddr(cfg.factory)) errors.push('FACTORY_ADDRESS is malformed');
  if (cfg.factory2 && !isAddr(cfg.factory2)) errors.push('FACTORY2_ADDRESS is malformed');
  if (!cfg.factory && !cfg.factory2) errors.push('set FACTORY_ADDRESS and/or FACTORY2_ADDRESS');
  return { cfg, errors };
}

function clients(cfg) {
  const chain = { id: cfg.chainId, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc] } } };
  const account = privateKeyToAccount(cfg.key);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(cfg.rpc, { batch: { batchSize: 100, wait: 10 } }) }),
    wallet: createWalletClient({ account, chain, transport: http(cfg.rpc) })
  };
}

const short = (err) => String((err && (err.shortMessage || err.message)) || err).split('\n')[0];

/* ------------------------------------------------------------ one run */

async function listVaults(pub, factory) {
  if (!factory) return [];
  const n = Number(await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'vaultCount' }));
  const pages = [];
  for (let i = 0; i < n; i += 500) pages.push(pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'vaultsPage', args: [BigInt(i), 500n] }));
  return (await Promise.all(pages)).flat();
}

/** Rotating window, so every vault gets its turn and early vaults cannot hog the bot. */
function windowOf(all, max, offset) {
  const start = all.length > max ? offset % all.length : 0;
  const list = [];
  for (let i = 0; i < Math.min(max, all.length); i++) list.push(all[(start + i) % all.length]);
  return list;
}

/** Plain-English reason a v2 vault is not trading right now (from the chip's input bits). */
/** When the strategy says "no", the vault sizes the trade at 0 and the size-dependent facts fail too, so the
 *  reason is worked out from cheap facts first, then the chip's own answer, then the price facts. */
export function why2(inputs, extra = {}) {
  if (inputs & 1) return 'paused by owner';
  if (!(inputs & 2)) return 'this agent is not allowed for this vault';
  if (extra.dailyDone) return 'daily limit reached';
  if (extra.waitUntil) return 'waiting for the next trade time';
  if (extra.lowBalance) return 'not enough money in the vault';
  if (extra.strategyNo) return 'strategy says wait (no dip / rise yet, or market too jumpy)';
  if (!(inputs & 8)) return 'price outside your limit, or market moving too fast';
  if (!(inputs & 16)) return 'trade size outside your limits';
  return 'safety checks said no';
}

/**
 * @param env   Worker env (vars + secrets)
 * @param opts  { send: boolean, prices?: array (tests), offset?: number (tests), wait?: boolean (tests) }
 */
export async function runOnce(env, opts = {}) {
  const at = new Date().toISOString();
  const { cfg, errors } = readConfig(env);
  if (errors.length) return { at, action: 'config-error', errors };
  const { account, pub, wallet } = clients(cfg);
  const report = { at, keeper: account.address, factory: cfg.factory || undefined, factory2: cfg.factory2 || undefined, vaults: [] };

  let all1 = [], all2 = [];
  try {
    [all1, all2] = await Promise.all([listVaults(pub, cfg.factory), listVaults(pub, cfg.factory2)]);
  } catch (err) {
    return { ...report, action: 'skip', why: 'could not read the factory: ' + short(err) };
  }
  report.vaultCount = all1.length + all2.length;
  if (opts.onVaults) opts.onVaults(all1, all2); // the trade recorder reuses this list
  if (!report.vaultCount) return { ...report, action: 'idle', why: 'no vaults yet' };
  const offset = opts.offset ?? Math.floor(Date.now() / 60000) * cfg.maxChecks;
  const list1 = windowOf(all1, cfg.maxChecks, offset), list2 = windowOf(all2, cfg.maxChecks, offset);

  // Pool 30-min average (all vaults share the pinned pool).
  let poolPrice = null;
  for (const v of list2) {
    try { poolPrice = Number(await pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'twapPrice' })) / 1e6; break; } catch { /* next */ }
  }
  if (poolPrice === null) for (const v of list1) {
    try {
      const [twap] = await pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'quote', args: [1_000_000n] });
      poolPrice = Number(twap) / 1e6;
      break;
    } catch { /* next */ }
  }
  if (poolPrice === null) return { ...report, action: 'skip', why: 'pool average price unavailable' };

  const testPrices = env.TEST_PRICES && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpc)
    ? String(env.TEST_PRICES).split(',').map((v, i) => ({ venue: 'test' + i, ok: true, price: Number(v) }))
    : null;
  const prices = opts.prices || testPrices || await fetchPrices();
  report.prices = prices.map((p) => (p.ok ? { venue: p.venue, price: p.price } : { venue: p.venue, error: p.error }));
  const market = marketCheck(prices, poolPrice, cfg.maxDivergencePct);
  report.market = market;
  if (!market.safe) return { ...report, action: 'hold', why: market.reason };
  const me = account.address.toLowerCase();
  const ready = []; // { row, data, feeUsd }

  /* ---- v1 vaults (LatchFactory): fixed-size buys ---- */
  const rows1 = list1.map((v) => ({ vault: v, version: 1 }));
  const reads = await Promise.all(list1.map((v) => Promise.all([
    pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'status' }),
    pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'feeBpsNow' }),
    pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'minAmount' })
  ]).catch((err) => ({ err }))));
  const candidates = [];
  rows1.forEach((row, i) => {
    const r = reads[i];
    if (r.err) { row.action = 'error'; row.why = short(r.err); return; }
    const [s, bps, minAmt] = r;
    const st = { armed: s[1], paused: s[2], balance: s[3], perTxCap: s[4], dailyCap: s[5], spentToday: s[6], keeper: s[7] };
    if (st.keeper.toLowerCase() !== me) { row.action = 'skip'; row.why = 'uses its own agent'; return; }
    if (!st.armed || st.paused) { row.action = 'hold'; row.why = st.paused ? 'paused by owner' : 'not switched on'; return; }
    let amount = st.perTxCap;
    const left = st.dailyCap > st.spentToday ? st.dailyCap - st.spentToday : 0n;
    if (amount > left) amount = left;
    const affordable = (st.balance * 10000n) / (10000n + bps);
    if (amount > affordable) amount = affordable;
    if (amount < minAmt) { row.action = 'hold'; row.why = left < minAmt ? 'daily limit reached' : 'not enough USDT0 in the vault'; return; }
    row.amount = amount.toString();
    candidates.push({ row, amount, bps });
  });
  const previews = await Promise.all(candidates.map(({ row, amount }) =>
    pub.readContract({ address: row.vault, abi: VAULT_ABI, functionName: 'preview', args: [amount], account: account.address }).catch((err) => ({ err }))));
  candidates.forEach((c, i) => {
    const p = previews[i];
    if (p.err) { c.row.action = 'error'; c.row.why = short(p.err); return; }
    const [bits, allow] = p;
    c.row.bits = Number(bits);
    if (!allow) {
      c.row.action = 'hold';
      c.row.why = (bits & 2) === 0 ? 'this agent is not allowed for this vault' : (bits & 8) === 0 ? 'price above your ceiling (or unstable)' : (bits & 32) === 0 ? 'waiting for the next buy time' : 'safety checks said no';
      return;
    }
    c.row.action = opts.send ? 'ready' : 'would-buy';
    ready.push({ row: c.row, data: encodeFunctionData({ abi: VAULT_ABI, functionName: 'tick', args: [c.amount] }), feeUsd: (Number(c.amount) * Number(c.bps)) / 1e10 });
  });

  /* ---- v2 vaults (LatchFactory2): Buy or Take Profit, sized by the strategy chip ---- */
  const rows2 = list2.map((v) => ({ vault: v, version: 2 }));
  const now = BigInt(Math.floor(Date.now() / 1000));
  const reads2 = await Promise.all(list2.map((v) => Promise.all([
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'keeper' }),
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'direction' }),
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'preview', args: [account.address] }),
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'nextTradeAt' }),
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'spentTodayNow' }),
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'dailyCap' }),
    pub.readContract({ address: v, abi: VAULT2_ABI, functionName: 'minAmount' })
  ]).catch((err) => ({ err }))));
  const holds = [];
  rows2.forEach((row, i) => {
    const r = reads2[i];
    if (r.err) { row.action = 'error'; row.why = short(r.err); return; }
    const [keeper, dir, p, next, spent, daily, minAmt] = r;
    row.kind = Number(dir) === 0 ? 'buy' : 'take-profit';
    if (keeper.toLowerCase() !== me) { row.action = 'skip'; row.why = 'uses its own agent'; return; }
    const [inputs, k, amount, fee] = p;
    row.inputs = Number(inputs); row.multiplier = Number(k);
    if (amount === 0n) {
      row.action = 'hold';
      holds.push({ row, inputs: Number(inputs), minAmt, extra: { dailyDone: daily - spent < minAmt, waitUntil: next > now ? Number(next) : 0 } });
      return;
    }
    row.amount = amount.toString();
    // fee in USD: Buy fees are USDT0 (6 decimals), Take Profit fees are WOKB (18 decimals)
    const feeUsd = Number(dir) === 0 ? Number(fee) / 1e6 : (Number(fee) / 1e18) * market.cex;
    row.action = opts.send ? 'ready' : (Number(dir) === 0 ? 'would-buy' : 'would-sell');
    ready.push({ row, data: encodeFunctionData({ abi: VAULT2_ABI, functionName: 'tick' }), feeUsd });
  });
  // Explain holds: vault balance and the chip's answer when every safety fact holds.
  await Promise.all(holds.map(async (h) => {
    try {
      const tokenIn = await pub.readContract({ address: h.row.vault, abi: VAULT2_ABI, functionName: 'tokenIn' });
      const [bal, [allow, k]] = await Promise.all([
        pub.readContract({ address: tokenIn, abi: ERC20_ABI, functionName: 'balanceOf', args: [h.row.vault] }),
        pub.readContract({ address: h.row.vault, abi: VAULT2_ABI, functionName: 'chip', args: [(h.inputs & 0xff80) | 0x7e] })
      ]);
      h.extra.lowBalance = bal < h.minAmt;
      h.extra.strategyNo = !allow || Number(k) === 0;
    } catch { /* reason from the bits alone */ }
    h.row.why = why2(h.inputs, h.extra);
  }));
  report.vaults = [...rows1, ...rows2];
  if (!opts.send || !ready.length) { report.action = 'checked'; return report; }

  // No overlapping runs: if our previous transaction is still pending, wait for the next minute.
  const [latestNonce, pendingNonce] = await Promise.all([
    pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
  ]);
  if (pendingNonce > latestNonce) {
    for (const c of ready) { c.row.action = 'later'; c.row.why = 'previous trade still confirming'; }
    report.action = 'checked'; return report;
  }
  const gasPrice = await pub.getGasPrice();
  if (gasPrice > cfg.maxGasGwei * 1_000_000_000n) { report.action = 'hold'; report.why = 'gas price too high'; return report; }
  let nonce = latestNonce, sends = 0;
  for (const c of ready) {
    if (sends >= cfg.maxSends) { c.row.action = 'later'; c.row.why = 'per-run send limit'; continue; }
    try {
      const gas = await pub.estimateGas({ account: account.address, to: c.row.vault, data: c.data }); // full simulation of the swap
      if (gas > cfg.maxGas) { c.row.action = 'hold'; c.row.why = 'needs too much gas (' + gas + ')'; continue; }
      const gasUsd = (Number(gas) * Number(gasPrice) / 1e18) * market.cex;
      c.row.gasUsd = Number(gasUsd.toFixed(5));
      if (cfg.feeMustCoverGas && c.feeUsd < gasUsd) { c.row.action = 'hold'; c.row.why = 'trade too small to cover gas right now'; continue; }
      const hash = await wallet.sendTransaction({ to: c.row.vault, data: c.data, gas: gas + gas / 2n, gasPrice, nonce });
      nonce++; sends++;
      c.row.tx = hash;
      c.row.action = 'sent';
    } catch (err) {
      c.row.action = 'hold'; c.row.why = 'trade would fail: ' + short(err);
    }
  }
  if (opts.wait) {
    for (const c of ready) if (c.row.tx) {
      const r = await pub.waitForTransactionReceipt({ hash: c.row.tx, timeout: 90_000 });
      c.row.action = r.status === 'success' ? (c.row.version === 2 && c.row.kind === 'take-profit' ? 'sold' : 'bought') : 'reverted';
    }
  }
  report.action = sends ? 'sent' : 'checked';
  return report;
}
