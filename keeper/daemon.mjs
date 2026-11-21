#!/usr/bin/env node
/**
 * Latch keeper — off-chain dip-sweep daemon for LatchRelay on X Layer (196).
 *
 * What it is: a Node.js script that watches OKB/USDT, decides when a dip is
 * real, and calls LatchRelay.tick(amount) once the on-chain preview agrees.
 * The keeper key pays gas and can only call tick — it can never choose a
 * destination, raise a cap, unpause, or rescue.
 *
 * Why a script and not a Cloudflare Worker: a Worker's WebCrypto has no
 * secp256k1, so it cannot sign an Ethereum transaction without a hand-rolled
 * curve (the thing that caused the earlier bugs). viem does the signing
 * correctly here — low-s normalisation, chain id, nonce, gas — and the key
 * never leaves the machine that runs this script.
 *
 * Safety gates (all off-chain; zero contract changes / re-tapes):
 *  1. Multi-source consensus (primary): OKX + Binance + CoinGecko. A dip must
 *     be seen by at least two venues before a sweep is even considered.
 *  2. Short TWAP (fallback): if consensus is impossible (rate-limited, or the
 *     pair is missing), the 5–10 minute rolling average must also be a dip.
 *  3. Volatility breaker: an hourly sigma above BREAKER_SIGMA, or a single
 *     venue spread above BREAKER_SWING_PCT, pauses the keeper (its own
 *     internal pause — not the relay's bit 0) for a cooldown.
 *
 * Run:
 *   cp env.example .env    # fill in real values, then:
 *   npm install
 *   node daemon.mjs
 *
 * Env: KEEPER_PRIVATE_KEY, RPC_URL, RELAY_ADDRESS (required);
 *      HEARTBEAT_URL + KEEPER_TOKEN (optional status heartbeat); and the
 *      policy/timing overrides listed in env.example.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  parseAbi,
  parseUnits,
  encodeFunctionData,
  formatUnits
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* ---------------------------------------------------------------- config */

// Load keeper/.env (next to this file) without overriding real env vars.
(function loadEnv(){
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

function env(name, fallback) {
  const v = process.env[name];
  return (v === undefined || v === '') ? fallback : v;
}

const KEEPER_PRIVATE_KEY = env('KEEPER_PRIVATE_KEY', '');
const RPC_URL = env('RPC_URL', '');
const RELAY_ADDRESS = env('RELAY_ADDRESS', '');
const HEARTBEAT_URL = env('HEARTBEAT_URL', '');
const KEEPER_TOKEN = env('KEEPER_TOKEN', '');

const CHAIN_ID = Number(env('CHAIN_ID', '196'));
const THRESHOLD = Number(env('THRESHOLD', '48'));
const SWEEP_USDT = Number(env('SWEEP_USDT', '2'));

const PRICE_INTERVAL_MS = Number(env('PRICE_INTERVAL_MS', '45000'));
const HEARTBEAT_INTERVAL_MS = Number(env('HEARTBEAT_INTERVAL_MS', '200000'));
const SWEEP_COOLDOWN_MS = Number(env('SWEEP_COOLDOWN_MS', '60000'));
const TWAP_WINDOW_MS = Number(env('TWAP_WINDOW_MS', '480000'));
const BREAKER_WINDOW_MS = Number(env('BREAKER_WINDOW_MS', '3600000'));
const BREAKER_SIGMA = Number(env('BREAKER_SIGMA', '0.03'));
const BREAKER_SWING_PCT = Number(env('BREAKER_SWING_PCT', '6'));
const BREAKER_COOLDOWN_MS = Number(env('BREAKER_COOLDOWN_MS', '600000'));

const RELAY_ABI = parseAbi([
  'function feeBpsNow() view returns (uint256)',
  'function tick(uint256 amount)',
  'function preview(uint256 amount) view returns (uint8 bits, bool allow)',
  'function status() view returns (address token_, bool armed_, bool paused_, uint256 balance_, uint256 perTxCap_, uint256 dailyCap_, uint256 spentToday_, address keeper_, address savings_, address treasury_)',
  'function token() view returns (address)',
  'function volumeSwept() view returns (uint256)'
]);

const ERC20_ABI = parseAbi([
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
]);

/* ---------------------------------------------------------------- prices */

const SOURCES = [
  {
    venue: 'OKX',
    fetch: async () => {
      const j = await get('https://www.okx.com/api/v5/market/ticker?instId=OKB-USDT');
      const last = j && j.data && j.data[0] && j.data[0].last;
      return Number(last);
    }
  },
  {
    venue: 'Binance',
    fetch: async () => {
      const j = await get('https://api.binance.com/api/v3/ticker/price?symbol=OKBUSDT');
      return Number(j.price);
    }
  },
  {
    venue: 'CoinGecko',
    fetch: async () => {
      const j = await get('https://api.coingecko.com/api/v3/simple/price?ids=okb&vs_currencies=usdt');
      return Number(j.okb && j.okb.usdt);
    }
  }
];

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPrices() {
  return Promise.all(SOURCES.map(async (src) => {
    try {
      const price = await src.fetch();
      if (!Number.isFinite(price) || price <= 0) {
        return { venue: src.venue, ok: false, price: null, error: 'bad value' };
      }
      return { venue: src.venue, ok: true, price };
    } catch (err) {
      return { venue: src.venue, ok: false, price: null, error: String((err && err.message) || err) };
    }
  }));
}

/* ---------------------------------------------------------------- stats */

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Single-venue spread from the consensus median, in percent. A CoinGecko wick
// far below OKX/Binance produces a large spread and trips the breaker.
function venueSpread(prices) {
  const ok = prices.filter((p) => p.ok);
  if (ok.length < 2) return 0;
  const mid = median(ok.map((p) => p.price));
  if (mid <= 0) return 0;
  let maxDev = 0;
  for (const p of ok) maxDev = Math.max(maxDev, (Math.abs(p.price - mid) / mid) * 100);
  return maxDev;
}

function twap(samples, windowMs) {
  const cutoff = Date.now() - windowMs;
  const recent = samples.filter((s) => s.t >= cutoff);
  if (recent.length < 2) return null;
  const sum = recent.reduce((acc, s) => acc + s.price, 0);
  return sum / recent.length;
}

// Hourly sigma of log returns over the sample window.
function hourlySigma(samples) {
  const cutoff = Date.now() - BREAKER_WINDOW_MS;
  const recent = samples.filter((s) => s.t >= cutoff).map((s) => s.price);
  if (recent.length < 3) return 0;
  const returns = [];
  for (let i = 1; i < recent.length; i++) returns.push(Math.log(recent[i] / recent[i - 1]));
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

/* ---------------------------------------------------------------- chain */

let account = null;
let publicClient = null;
let walletClient = null;

async function readRelayStatus() {
  const s = await publicClient.readContract({
    address: RELAY_ADDRESS,
    abi: RELAY_ABI,
    functionName: 'status'
  });
  let volumeSwept = 0n;
  try {
    volumeSwept = await publicClient.readContract({
      address: RELAY_ADDRESS,
      abi: RELAY_ABI,
      functionName: 'volumeSwept'
    });
  } catch (_) { /* optional */ }
  return {
    token: s[0],
    armed: s[1],
    paused: s[2],
    balance: s[3],
    perTxCap: s[4],
    dailyCap: s[5],
    spentToday: s[6],
    keeper: s[7],
    savings: s[8],
    treasury: s[9],
    volumeSwept
  };
}

// Caps live on the relay in the token's own base units. Read the token's real
// decimals (6 for X Layer USDT) and scale SWEEP_USDT with them, so "50" means
// 50 tokens whatever the token is.
let tokenDecimals = null;
async function sweepAmount(relay) {
  if (tokenDecimals === null) {
    try {
      tokenDecimals = Number(await publicClient.readContract({
        address: relay.token,
        abi: ERC20_ABI,
        functionName: 'decimals'
      }));
    } catch (err) {
      log('SKIP', 'cannot read token decimals: ' + err.message);
      return 0n;
    }
  }
  const wanted = parseUnits(String(SWEEP_USDT), tokenDecimals);
  let amount = wanted > relay.perTxCap ? relay.perTxCap : wanted;
  const dailyLeft = relay.dailyCap > relay.spentToday ? relay.dailyCap - relay.spentToday : 0n;
  if (amount > dailyLeft) amount = dailyLeft;
  // The vault must cover amount + fee; never ask for more than it can pay.
  try {
    const bps = await publicClient.readContract({ address: RELAY_ADDRESS, abi: RELAY_ABI, functionName: 'feeBpsNow' });
    const affordable = (relay.balance * 10_000n) / (10_000n + bps);
    if (amount > affordable) amount = affordable;
  } catch { /* status/preview still gate the send */ }
  if (amount <= 0n) {
    log('SKIP', 'daily cap exhausted — not sweeping');
    return 0n;
  }
  return amount;
}

async function sendTick(amount) {
  const data = encodeFunctionData({ abi: RELAY_ABI, functionName: 'tick', args: [amount] });
  const gas = await publicClient.estimateGas({
    account: account.address,
    to: RELAY_ADDRESS,
    data
  });
  const gasPrice = await publicClient.getGasPrice();
  // Refuse absurd gas prices from a misbehaving RPC (X Layer gas is normally tiny).
  const maxGwei = BigInt(process.env.MAX_GAS_GWEI || '50');
  if (gasPrice > maxGwei * 1_000_000_000n) throw new Error('gas price ' + gasPrice + ' wei above MAX_GAS_GWEI=' + maxGwei);
  const hash = await walletClient.sendTransaction({
    to: RELAY_ADDRESS,
    data,
    gas: gas + gas / 5n, // +20% headroom
    gasPrice
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== 'success') throw new Error('tick mined but reverted: ' + hash);
  return hash;
}

/* ---------------------------------------------------------------- heartbeat */

async function heartbeat(relay, extra) {
  if (!HEARTBEAT_URL || !KEEPER_TOKEN) return;
  const now = Date.now();
  if (!extra.lastTx && now - lastHeartbeat < HEARTBEAT_INTERVAL_MS) return;
  lastHeartbeat = now;
  const body = {
    price: extra.price || 0,
    threshold: THRESHOLD,
    armed: relay ? (relay.armed ? 1 : 0) : 0,
    paused: extra.paused || 0,
    running: extra.running || 1,
    spentToday: relay ? Number(formatUnits(relay.spentToday, tokenDecimals ?? 6)) : 0,
    sweptTotal: relay && relay.volumeSwept !== undefined ? Number(formatUnits(relay.volumeSwept, tokenDecimals ?? 6)) : 0,
    lastTx: extra.lastTx || undefined,
    relay: RELAY_ADDRESS,
    chainId: CHAIN_ID
  };
  try {
    await fetch(HEARTBEAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Keeper-Token': KEEPER_TOKEN },
      body: JSON.stringify(body)
    });
  } catch (err) {
    log('HB', 'heartbeat failed: ' + err.message);
  }
}

/* ---------------------------------------------------------------- loop */

const samples = []; // { t, price } of the consensus price
let breakerPaused = false;
let breakerUntil = 0;
let lastHeartbeat = 0;
let lastSweepAt = 0;

function log(tag, msg) {
  console.log(`[${new Date().toISOString()}] ${tag} ${msg}`);
}

async function runOnce() {
  const prices = await fetchPrices();
  const ok = prices.filter((p) => p.ok);
  const consensusPrice = ok.length ? median(ok.map((p) => p.price)) : null;
  const now = Date.now();

  if (consensusPrice) samples.push({ t: now, price: consensusPrice });
  while (samples.length && samples[0].t < now - BREAKER_WINDOW_MS) samples.shift();

  // 1. Volatility breaker.
  const sigma = hourlySigma(samples);
  const spread = venueSpread(prices);
  if (sigma > BREAKER_SIGMA || spread > BREAKER_SWING_PCT) {
    if (!breakerPaused) {
      log('BREAKER', `trip — hourly sigma ${(sigma * 100).toFixed(2)}%, venue spread ${spread.toFixed(1)}% → paused ${BREAKER_COOLDOWN_MS / 1000}s`);
    }
    breakerPaused = true;
    breakerUntil = Math.max(breakerUntil, now + BREAKER_COOLDOWN_MS);
  } else if (breakerPaused && now >= breakerUntil) {
    breakerPaused = false;
    log('BREAKER', 'volatility normalised — keeper resumed');
  }

  const relay = await readRelayStatus().catch((err) => {
    log('SKIP', 'relay read failed: ' + err.message);
    return null;
  });

  if (breakerPaused) {
    log('WATCH', `breaker holds (${prices.map((p) => (p.ok ? p.venue + ' ' + p.price : p.venue + ' ✗')).join(', ')})`);
    await heartbeat(relay, { paused: 1, running: 1, price: consensusPrice || 0 });
    return;
  }

  // 2. Decide: multi-source consensus first, TWAP as the fallback.
  const votes = ok.filter((p) => p.price <= THRESHOLD).length;
  let trigger = ok.length >= 2 && votes >= 2;
  let via = 'consensus';
  if (!trigger && ok.length < 2) {
    const tw = twap(samples, TWAP_WINDOW_MS);
    if (tw !== null && tw <= THRESHOLD) {
      trigger = true;
      via = 'twap';
    }
  }

  if (!trigger) {
    log('WATCH', `hold — consensus ${consensusPrice === null ? 'n/a' : consensusPrice.toFixed(2)} > ${THRESHOLD} (${votes}/${ok.length} venues)`);
    await heartbeat(relay, { paused: relay ? (relay.paused ? 1 : 0) : 0, running: 1, price: consensusPrice || 0 });
    return;
  }

  // 3. On-chain gate: the relay must agree before we spend gas.
  if (!relay || !relay.armed || relay.paused) {
    log('SKIP', 'on-chain gate closed (not armed or relay paused) — not sweeping');
    await heartbeat(relay, { paused: relay ? (relay.paused ? 1 : 0) : 0, running: 1, price: consensusPrice || 0 });
    return;
  }

  const amount = await sweepAmount(relay);
  if (amount === 0n) {
    await heartbeat(relay, { paused: 0, running: 1, price: consensusPrice || 0 });
    return;
  }

  if (now - lastSweepAt < SWEEP_COOLDOWN_MS) return;

  const preview = await publicClient.readContract({
    address: RELAY_ADDRESS,
    abi: RELAY_ABI,
    functionName: 'preview',
    args: [amount],
    // preview reports the keeper bit from msg.sender, so ask as the keeper.
    account: account.address
  }).then(([bits, allow]) => ({ bits, allow })).catch((err) => {
    log('SKIP', 'preview failed: ' + err.message);
    return null;
  });
  if (!preview || !preview.allow) {
    log('SKIP', `preview denied bits=${preview ? preview.bits : '?'} — not sweeping`);
    await heartbeat(relay, { paused: 0, running: 1, price: consensusPrice || 0 });
    return;
  }

  log('SWEEP', `${via} dip ${consensusPrice.toFixed(2)} <= ${THRESHOLD} (${votes}/${ok.length} venues) — sending tick(${amount})`);
  const hash = await sendTick(amount);
  lastSweepAt = now;
  log('SWEPT', 'tick confirmed ' + hash);
  await heartbeat(relay, { paused: 0, running: 1, price: consensusPrice || 0, lastTx: hash });
}

/* ---------------------------------------------------------------- boot */

function validateConfig() {
  const errors = [];
  if (!/^0x[0-9a-fA-F]{64}$/.test(KEEPER_PRIVATE_KEY)) errors.push('KEEPER_PRIVATE_KEY must be a 0x + 64 hex chars private key');
  if (!RPC_URL) errors.push('RPC_URL is required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(RELAY_ADDRESS)) errors.push('RELAY_ADDRESS must be a 0x + 40 hex chars address');
  if (HEARTBEAT_URL && !KEEPER_TOKEN) errors.push('KEEPER_TOKEN is required when HEARTBEAT_URL is set');
  return errors;
}

async function main() {
  const errors = validateConfig();
  if (errors.length) {
    for (const e of errors) log('CONFIG', e);
    process.exit(1);
  }
  account = privateKeyToAccount(KEEPER_PRIVATE_KEY);
  const chain = {
    id: CHAIN_ID,
    name: 'X Layer',
    network: 'xlayer',
    nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
    rpcUrls: { default: { http: [RPC_URL] }, public: { http: [RPC_URL] } },
    blockExplorers: { default: { name: 'OKLink', url: 'https://www.oklink.com/xlayer' } }
  };
  publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
  walletClient = createWalletClient({ account, chain, transport: http(RPC_URL) });

  const relay = await readRelayStatus().catch(() => null);
  if (relay && account.address.toLowerCase() !== String(relay.keeper).toLowerCase()) {
    log('CONFIG', 'keeper key ' + account.address + ' does not match relay.keeper ' + relay.keeper + ' — tick would revert NotKeeper');
    process.exit(1);
  }

  log('START', 'keeper ' + account.address + ' watching relay ' + RELAY_ADDRESS + ' on chain ' + CHAIN_ID);
  log('START', 'threshold ' + THRESHOLD + ' · sweep ' + SWEEP_USDT + ' USDT · consensus 2/3 · TWAP fallback · volatility breaker on');

  await runOnce().catch((err) => log('ERR', (err && err.message) || String(err)));
  setInterval(() => {
    runOnce().catch((err) => log('ERR', (err && err.message) || String(err)));
  }, PRICE_INTERVAL_MS);
}

main().catch((err) => {
  log('FATAL', (err && err.message) || String(err));
  process.exit(1);
});
