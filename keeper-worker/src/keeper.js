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
  { venue: 'Binance', get: async () => priceFrom(await getJson('https://api.binance.com/api/v3/ticker/price?symbol=OKBUSDT'), (j) => j.price) },
  { venue: 'CoinGecko', get: async () => priceFrom(await getJson('https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd'), (j) => j.okb.usd) },
  { venue: 'Gate', get: async () => priceFrom(await getJson('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=OKB_USDT'), (j) => j[0].last) },
  { venue: 'KuCoin', get: async () => priceFrom(await getJson('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=OKB-USDT'), (j) => j.data.price) },
  { venue: 'Bitget', get: async () => priceFrom(await getJson('https://api.bitget.com/api/v2/spot/market/tickers?symbol=OKBUSDT'), (j) => j.data[0].lastPr) },
  { venue: 'MEXC', get: async () => priceFrom(await getJson('https://api.mexc.com/api/v3/ticker/price?symbol=OKBUSDT'), (j) => j.price) },
  { venue: 'HTX', get: async () => priceFrom(await getJson('https://api.huobi.pro/market/detail/merged?symbol=okbusdt'), (j) => j.tick.close) }
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
    chainId: Number(env.CHAIN_ID || 196),
    maxDivergencePct: Number(env.MAX_DIVERGENCE_PCT || 2),
    maxSends: Number(env.MAX_SENDS_PER_RUN || 3),
    maxChecks: Number(env.MAX_CHECKS_PER_RUN || 25),
    maxGasGwei: BigInt(env.MAX_GAS_GWEI || 50)
  };
  const errors = [];
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.key)) errors.push('KEEPER_PRIVATE_KEY secret is missing or not 0x + 64 hex');
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.factory)) errors.push('FACTORY_ADDRESS is missing or malformed');
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

/**
 * @param env   Worker env (vars + secrets)
 * @param opts  { send: boolean, prices?: array (tests) }
 */
export async function runOnce(env, opts = {}) {
  const at = new Date().toISOString();
  const { cfg, errors } = readConfig(env);
  if (errors.length) return { at, action: 'config-error', errors };
  const { account, pub, wallet } = clients(cfg);
  const report = { at, keeper: account.address, factory: cfg.factory, vaults: [] };

  // All vaults, paged; then a rotating window so every vault gets its turn.
  let all = [];
  try {
    const n = Number(await pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'vaultCount' }));
    const pages = [];
    for (let i = 0; i < n; i += 500) pages.push(pub.readContract({ address: cfg.factory, abi: FACTORY_ABI, functionName: 'vaultsPage', args: [BigInt(i), 500n] }));
    all = (await Promise.all(pages)).flat();
  } catch (err) {
    return { ...report, action: 'skip', why: 'could not read the factory: ' + short(err) };
  }
  report.vaultCount = all.length;
  if (!all.length) return { ...report, action: 'idle', why: 'no vaults yet' };
  const start = all.length > cfg.maxChecks ? (opts.offset ?? Math.floor(Date.now() / 60000) * cfg.maxChecks) % all.length : 0;
  const list = [];
  for (let i = 0; i < Math.min(cfg.maxChecks, all.length); i++) list.push(all[(start + i) % all.length]);

  // Pool 30-min average, via a vault's quote() (all vaults share the pinned pool).
  let poolPrice = null;
  for (const v of list) {
    try {
      const [twap] = await pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'quote', args: [1_000_000n] });
      poolPrice = Number(twap) / 1e6;
      break;
    } catch { /* try the next vault */ }
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

  // Batched reads for the whole window.
  const me = account.address.toLowerCase();
  const rows = list.map((v) => ({ vault: v }));
  report.vaults = rows;
  const reads = await Promise.all(list.map((v) => Promise.all([
    pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'status' }),
    pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'feeBpsNow' }),
    pub.readContract({ address: v, abi: VAULT_ABI, functionName: 'minAmount' })
  ]).catch((err) => ({ err }))));
  const candidates = [];
  rows.forEach((row, i) => {
    const r = reads[i];
    if (r.err) { row.action = 'error'; row.why = short(r.err); return; }
    const [s, bps, minAmt] = r;
    const st = { armed: s[1], paused: s[2], balance: s[3], perTxCap: s[4], dailyCap: s[5], spentToday: s[6], keeper: s[7] };
    if (st.keeper.toLowerCase() !== me) { row.action = 'skip'; row.why = 'uses its own bot'; return; }
    if (!st.armed || st.paused) { row.action = 'hold'; row.why = st.paused ? 'paused by owner' : 'not switched on'; return; }
    let amount = st.perTxCap;
    const left = st.dailyCap > st.spentToday ? st.dailyCap - st.spentToday : 0n;
    if (amount > left) amount = left;
    const affordable = (st.balance * 10000n) / (10000n + bps);
    if (amount > affordable) amount = affordable;
    if (amount < minAmt) { row.action = 'hold'; row.why = left < minAmt ? 'daily limit reached' : 'not enough USDT0 in the vault'; return; }
    row.amount = amount.toString();
    candidates.push({ row, amount });
  });
  const previews = await Promise.all(candidates.map(({ row, amount }) =>
    pub.readContract({ address: row.vault, abi: VAULT_ABI, functionName: 'preview', args: [amount], account: account.address }).catch((err) => ({ err }))));
  const ready = [];
  candidates.forEach((c, i) => {
    const p = previews[i];
    if (p.err) { c.row.action = 'error'; c.row.why = short(p.err); return; }
    const [bits, allow] = p;
    c.row.bits = Number(bits);
    if (!allow) {
      c.row.action = 'hold';
      c.row.why = (bits & 2) === 0 ? 'this bot is not allowed for this vault' : (bits & 8) === 0 ? 'price above your ceiling (or unstable)' : (bits & 32) === 0 ? 'waiting for the next buy time' : 'safety checks said no';
      return;
    }
    c.row.action = opts.send ? 'ready' : 'would-buy';
    ready.push(c);
  });
  if (!opts.send || !ready.length) { report.action = 'checked'; return report; }

  // No overlapping runs: if our previous transaction is still pending, wait for the next minute.
  const [latestNonce, pendingNonce] = await Promise.all([
    pub.getTransactionCount({ address: account.address, blockTag: 'latest' }),
    pub.getTransactionCount({ address: account.address, blockTag: 'pending' })
  ]);
  if (pendingNonce > latestNonce) {
    for (const c of ready) { c.row.action = 'later'; c.row.why = 'previous buy still confirming'; }
    report.action = 'checked'; return report;
  }
  const gasPrice = await pub.getGasPrice();
  if (gasPrice > cfg.maxGasGwei * 1_000_000_000n) { report.action = 'hold'; report.why = 'gas price too high'; return report; }
  let nonce = latestNonce, sends = 0;
  for (const c of ready) {
    if (sends >= cfg.maxSends) { c.row.action = 'later'; c.row.why = 'per-run send limit'; continue; }
    const data = encodeFunctionData({ abi: VAULT_ABI, functionName: 'tick', args: [c.amount] });
    try {
      const gas = await pub.estimateGas({ account: account.address, to: c.row.vault, data }); // full simulation of the swap
      const hash = await wallet.sendTransaction({ to: c.row.vault, data, gas: gas + gas / 2n, gasPrice, nonce });
      nonce++; sends++;
      c.row.tx = hash;
      c.row.action = 'sent';
    } catch (err) {
      c.row.action = 'hold'; c.row.why = 'swap would fail: ' + short(err);
    }
  }
  if (opts.wait) {
    for (const c of ready) if (c.row.tx) {
      const r = await pub.waitForTransactionReceipt({ hash: c.row.tx, timeout: 90_000 });
      c.row.action = r.status === 'success' ? 'bought' : 'reverted';
    }
  }
  report.action = sends ? 'sent' : 'checked';
  return report;
}
