/**
 * Latch helper bot (keeper) — one check per call.
 *
 * Runs on a Cloudflare cron every 2 minutes. Each run:
 *   1. reads the OKB price from several exchanges,
 *   2. ignores single-exchange wicks (spread breaker),
 *   3. needs at least 2 exchanges AND a majority to be at or below THRESHOLD,
 *   4. asks the vault (preview) whether the transfer would pass all 7 checks,
 *   5. only then sends tick(amount).
 *
 * No state is kept between runs. The vault itself enforces the real limits
 * (per-transfer cap, daily cap, savings-only destination), so a bug here can
 * at worst move a capped amount into the owner's own savings wallet.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  encodeFunctionData
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const RELAY_ABI = parseAbi([
  'function feeBpsNow() view returns (uint256)',
  'function tick(uint256 amount)',
  'function preview(uint256 amount) view returns (uint8 bits, bool allow)',
  'function status() view returns (address token_, bool armed_, bool paused_, uint256 balance_, uint256 perTxCap_, uint256 dailyCap_, uint256 spentToday_, address keeper_, address savings_, address treasury_)'
]);
const ERC20_ABI = parseAbi(['function decimals() view returns (uint8)']);

/* ------------------------------------------------------------ prices */

async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'User-Agent': 'latch-keeper/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export const SOURCES = [
  { venue: 'OKX', get: async () => Number((await getJson('https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT')).data[0].last) },
  { venue: 'Binance', get: async () => Number((await getJson('https://api.binance.com/api/v3/ticker/price?symbol=OKBUSDT')).price) },
  { venue: 'CoinGecko', get: async () => Number((await getJson('https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usd')).okb.usd) },
  { venue: 'Gate', get: async () => Number((await getJson('https://api.gateio.ws/api/v4/spot/tickers?currency_pair=OKB_USDT'))[0].last) },
  { venue: 'KuCoin', get: async () => Number((await getJson('https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=OKB-USDT')).data.price) }
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

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/** Pure decision: should we try to save right now? */
export function decide(prices, threshold, maxSpreadPct) {
  const ok = prices.filter((p) => p.ok);
  if (ok.length < 2) return { trigger: false, reason: `only ${ok.length} exchange(s) answered — need 2`, ok: ok.length };
  const mid = median(ok.map((p) => p.price));
  const spread = Math.max(...ok.map((p) => (Math.abs(p.price - mid) / mid) * 100));
  const votes = ok.filter((p) => p.price <= threshold).length;
  const base = { price: mid, votes, ok: ok.length, spread: Number(spread.toFixed(2)) };
  if (spread > maxSpreadPct) return { ...base, trigger: false, reason: `exchanges disagree by ${spread.toFixed(1)}% — looks like a fake crash, ignoring` };
  if (votes >= 2 && votes * 2 > ok.length) return { ...base, trigger: true, reason: `${votes} of ${ok.length} exchanges at or below ${threshold}` };
  return { ...base, trigger: false, reason: `price ${mid.toFixed(2)} is above ${threshold} (${votes}/${ok.length} exchanges below)` };
}

/* ------------------------------------------------------------ config */

export function readConfig(env) {
  const cfg = {
    key: String(env.KEEPER_PRIVATE_KEY || '').trim(),
    rpc: String(env.RPC_URL || 'https://rpc.xlayer.tech'),
    relay: String(env.RELAY_ADDRESS || ''),
    chainId: Number(env.CHAIN_ID || 196),
    threshold: Number(env.THRESHOLD || 48),
    sweep: String(env.SWEEP_USDT || '2'),
    maxSpreadPct: Number(env.MAX_SPREAD_PCT || 6),
    maxGasGwei: BigInt(env.MAX_GAS_GWEI || 50)
  };
  const errors = [];
  if (!/^0x[0-9a-fA-F]{64}$/.test(cfg.key)) errors.push('KEEPER_PRIVATE_KEY secret is missing or not 0x + 64 hex');
  if (!/^0x[0-9a-fA-F]{40}$/.test(cfg.relay)) errors.push('RELAY_ADDRESS is missing or malformed');
  if (!(cfg.threshold > 0)) errors.push('THRESHOLD must be a positive number');
  return { cfg, errors };
}

function clients(cfg) {
  const chain = {
    id: cfg.chainId,
    name: 'X Layer',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpc] } }
  };
  const account = privateKeyToAccount(cfg.key);
  return {
    account,
    pub: createPublicClient({ chain, transport: http(cfg.rpc) }),
    wallet: createWalletClient({ account, chain, transport: http(cfg.rpc) })
  };
}

/* ------------------------------------------------------------ one run */

/**
 * @param env   Worker env (vars + secrets)
 * @param opts  { send: boolean, prices?: array (for tests) }
 * @returns     a plain report object (also what GET / shows)
 */
export async function runOnce(env, opts = {}) {
  const at = new Date().toISOString();
  const { cfg, errors } = readConfig(env);
  if (errors.length) return { at, action: 'config-error', errors };

  // TEST_PRICES (e.g. "47,47.2,46.9") is honoured only against a local test chain, never in production.
  const testPrices = env.TEST_PRICES && /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(cfg.rpc)
    ? String(env.TEST_PRICES).split(',').map((v, i) => ({ venue: 'test' + i, ok: true, price: Number(v) }))
    : null;
  const prices = opts.prices || testPrices || await fetchPrices();
  const verdict = decide(prices, cfg.threshold, cfg.maxSpreadPct);
  const report = {
    at,
    relay: cfg.relay,
    threshold: cfg.threshold,
    prices: prices.map((p) => (p.ok ? { venue: p.venue, price: p.price } : { venue: p.venue, error: p.error })),
    verdict
  };

  const { account, pub, wallet } = clients(cfg);
  report.keeper = account.address;

  let s;
  try {
    s = await pub.readContract({ address: cfg.relay, abi: RELAY_ABI, functionName: 'status' });
  } catch (err) {
    return { ...report, action: 'skip', why: 'could not read the vault: ' + short(err) };
  }
  const vault = { token: s[0], armed: s[1], paused: s[2], balance: s[3], perTxCap: s[4], dailyCap: s[5], spentToday: s[6], keeper: s[7] };
  report.vault = { armed: vault.armed, paused: vault.paused, balance: vault.balance.toString(), spentToday: vault.spentToday.toString() };

  if (vault.keeper.toLowerCase() !== account.address.toLowerCase()) {
    return { ...report, action: 'config-error', errors: ['this key is ' + account.address + ' but the vault expects helper bot ' + vault.keeper] };
  }
  if (!verdict.trigger) return { ...report, action: 'hold', why: verdict.reason };
  if (!vault.armed || vault.paused) return { ...report, action: 'hold', why: 'vault is ' + (vault.paused ? 'paused' : 'not switched on') };

  // Amount: wanted, clamped to per-tx cap, what is left today, and what the vault can pay incl. fee.
  const decimals = Number(await pub.readContract({ address: vault.token, abi: ERC20_ABI, functionName: 'decimals' }));
  let amount = parseUnits(cfg.sweep, decimals);
  if (amount > vault.perTxCap) amount = vault.perTxCap;
  const left = vault.dailyCap > vault.spentToday ? vault.dailyCap - vault.spentToday : 0n;
  if (amount > left) amount = left;
  const bps = await pub.readContract({ address: cfg.relay, abi: RELAY_ABI, functionName: 'feeBpsNow' });
  const affordable = (vault.balance * 10000n) / (10000n + bps);
  if (amount > affordable) amount = affordable;
  if (amount <= 0n) return { ...report, action: 'hold', why: 'daily limit reached or vault empty' };
  report.amount = amount.toString();

  // Ask the vault (as the keeper) whether all 7 checks pass before spending gas.
  const [bits, allow] = await pub.readContract({ address: cfg.relay, abi: RELAY_ABI, functionName: 'preview', args: [amount], account: account.address });
  report.preview = { bits: Number(bits), allow };
  if (!allow) return { ...report, action: 'hold', why: 'vault safety checks said no (bits ' + Number(bits).toString(2).padStart(7, '0') + ')' };

  if (!opts.send) return { ...report, action: 'would-save', why: 'dry run — the cron would send tick now' };

  const data = encodeFunctionData({ abi: RELAY_ABI, functionName: 'tick', args: [amount] });
  const gas = await pub.estimateGas({ account: account.address, to: cfg.relay, data });
  const gasPrice = await pub.getGasPrice();
  if (gasPrice > cfg.maxGasGwei * 1_000_000_000n) return { ...report, action: 'skip', why: 'gas price too high: ' + gasPrice + ' wei' };
  const hash = await wallet.sendTransaction({ to: cfg.relay, data, gas: gas + gas / 5n, gasPrice });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== 'success') return { ...report, action: 'reverted', tx: hash };
  return { ...report, action: 'saved', tx: hash };
}

function short(err) {
  return String((err && (err.shortMessage || err.message)) || err).split('\n')[0];
}
