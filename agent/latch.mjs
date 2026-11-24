#!/usr/bin/env node
// latch: command-line tool for AI agents (OKX Plugin Store skill "latch").
// Reads Latch on X Layer and PREPARES transactions; it never holds or asks for a private key.
// Every write is printed as JSON with a ready `onchainos wallet contract-call` command, so the
// agent's OKX Agentic Wallet signs it inside OKX's TEE.
//
//   latch market                                   live OKB price as Latch vaults see it
//   latch try --dir buy --mode smart --ref 95 --limit 100 --base 2     what would a vault do right now (real chip)
//   latch vaults --owner 0x…                       an owner's vaults
//   latch status --vault 0x…                       one vault: settings, balance, what the chip sees, next action
//   latch create --dir buy --mode smart --savings 0x… --base 2 --ref 95 --limit 100 [--per-trade 6 --daily 6 --every day --keeper 0x…]
//   latch fund --vault 0x… --amount 10             add USDT0 (Buy vault) or WOKB (Take Profit vault)
//   latch wrap --amount 0.1                        OKB → WOKB (Take Profit vaults hold WOKB)
//   latch pause|resume --vault 0x…
//   latch strategy --vault 0x… [--mode --base --ref --limit --every]
//   latch withdraw --vault 0x… --to 0x…            everything back to the owner
//   latch tick --vault 0x… --as 0x…                for an agent that IS the vault's bot: trade now if the chip allows
// Global: --rpc <url> (or LATCH_RPC), LATCH_CONFIG=<json file> to point at other deployments (tests).
import fs from 'node:fs';
import { createPublicClient, http, parseAbi, encodeFunctionData, parseUnits, formatUnits, getAddress, isAddress, decodeErrorResult } from 'viem';

const MAINNET = {
  chainId: 196,
  rpc: 'https://rpc.xlayer.tech',
  factory2: '0x4Af276338A81DA70e5dA4108FA0A7F6d294381b8',
  processor: '0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813',
  circuit2Id: 2,
  usdt: '0x779Ded0c9e1022225f8E0630b35a9b54bE713736',
  wokb: '0xe538905cf8410324e03A5A23C1c177a474D59b2b',
  pool: '0xe3BE6A0137f1b0602Fc1a4841686f43B340a5082',
  site: 'https://latch.tapeguard.workers.dev'
};
const C = { ...MAINNET, ...(process.env.LATCH_CONFIG ? JSON.parse(fs.readFileSync(process.env.LATCH_CONFIG, 'utf8')) : {}) };

const FACTORY2 = parseAbi([
  'function createVault(uint8 direction, uint8 mode, address savings, uint256 baseAmount, uint256 perTxCap, uint256 dailyCap, uint256 refPrice, uint256 limitPrice, uint256 minInterval, address keeper) returns (address)',
  'function vaultsOf(address owner) view returns (address[])',
  'function treasury() view returns (address)',
  'function hostedKeeper() view returns (address)',
  'function minBuy() view returns (uint256)',
  'function minSell() view returns (uint256)'
]);
const VAULT2 = parseAbi([
  'function owner() view returns (address)', 'function keeper() view returns (address)', 'function savings() view returns (address)',
  'function paused() view returns (bool)', 'function direction() view returns (uint8)', 'function mode() view returns (uint8)',
  'function tokenIn() view returns (address)', 'function tokenOut() view returns (address)',
  'function baseAmount() view returns (uint256)', 'function perTxCap() view returns (uint256)', 'function dailyCap() view returns (uint256)',
  'function refPrice() view returns (uint256)', 'function limitPrice() view returns (uint256)', 'function minInterval() view returns (uint256)',
  'function minAmount() view returns (uint256)', 'function nextTradeAt() view returns (uint256)', 'function spentTodayNow() view returns (uint256)',
  'function volumeIn() view returns (uint256)', 'function totalOut() view returns (uint256)', 'function trades() view returns (uint256)',
  'function feeBpsNow() view returns (uint256)', 'function twapPrice() view returns (uint256)',
  'function preview(address caller) view returns (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut, uint256 avgPrice)',
  'function chip(uint16 inputs) view returns (bool allow, uint8 k)',
  'function tick()', 'function setPaused(bool next)',
  'function setStrategy(uint256 baseAmount, uint256 perTxCap, uint256 dailyCap, uint256 refPrice, uint256 limitPrice, uint256 minInterval, uint8 mode)',
  'function withdraw(address token, address to, uint256 amount)',
  'error NotOwner()', 'error OverCap()', 'error CapRaised()', 'error BadParam()', 'error BadSavings()', 'error BadRecipient()', 'error Underfunded()'
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function transfer(address to, uint256 amount) returns (bool)']);
const WOKB = parseAbi(['function deposit() payable']);
const POOL = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function token0() view returns (address)', 'function observe(uint32[] secondsAgos) view returns (int56[], uint160[])']);
const PROC = parseAbi(['function eval(uint256 id, bytes inputs) view returns (bytes)']);
const MAX = 2n ** 256n - 1n;
const ZERO = '0x0000000000000000000000000000000000000000';

const MODES = ['steady', 'dips', 'smart', 'ladder'];
const MODE_TEXT = [
  ['Steady: the same amount every time', 'Dips only: buys only below the reference price', 'Smart: 2× or 3× more on bigger dips, 1× when the market is jumpy', 'Ladder: 1× from a 5% dip, 2× from 15%, 3× from 30%'],
  ['Steady: sells the same amount every time (never under the floor)', 'Rises only: sells only above the reference price', 'Smart: 2× or 3× more on bigger rises, 1× when the market is jumpy', 'Ladder: 1× from a 5% rise, 2× from 15%, 3× from 30%']
];
const DEPTHS = ['no move past the reference', 'under 5%', '5–10%', '10–15%', '15–20%', '20–30%', '30–40%', '40% or more'];
const VOLS = ['calm', 'a little busy', 'jumpy', 'very jumpy'];
const EVERY = { any: 0n, hour: 3600n, day: 86400n, week: 604800n };

/* ------------------------------------------------------------------ args */
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = {};
for (let i = 1; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { const k = argv[i].slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'; opt[k] = v; }
}
const pub = createPublicClient({ transport: http(opt.rpc || process.env.LATCH_RPC || C.rpc, { timeout: 30_000 }) });
const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const out = (o) => { process.stdout.write(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2) + '\n'); };
class UserError extends Error {}
const need = (k, check, what) => {
  const v = opt[k];
  if (v === undefined || v === 'true') throw new UserError(`missing --${k} (${what})`);
  if (check && !check(v)) throw new UserError(`--${k} is not valid: ${what}`);
  return v;
};
const addr = (k, what) => getAddress(need(k, isAddress, what));
const dirOf = (v) => { if (v === 'buy' || v === '0') return 0; if (v === 'sell' || v === 'take-profit' || v === 'takeprofit' || v === '1') return 1; throw new UserError('--dir must be buy or sell'); };
const modeOf = (v) => { const i = MODES.indexOf(String(v).toLowerCase()); if (i < 0) throw new UserError('--mode must be steady, dips, smart or ladder'); return i; };
const usd = (v) => Number(formatUnits(v, 6));
const amtOf = (v, dir) => (dir === 0 ? `${usd(v)} USDT0` : `${Number(formatUnits(v, 18))} OKB`);

/** A transaction for the agent's OKX Agentic Wallet to sign (never signed here). */
function tx(description, to, data, value = 0n) {
  return {
    description, chain: C.chainId, to, inputData: data, amt: value.toString(),
    onchainos: `onchainos wallet contract-call --to ${to} --chain ${C.chainId} --input-data ${data} --amt ${value}`
  };
}

/* ------------------------------------------------------------------ market + chip */
async function market() {
  const [s0, t0, obs] = await Promise.all([read(C.pool, POOL, 'slot0'), read(C.pool, POOL, 'token0'), read(C.pool, POOL, 'observe', [[1800, 0]])]);
  const d = obs[0][1] - obs[0][0];
  let avgTick = Number(d / 1800n); if (d < 0n && d % 1800n !== 0n) avgTick--;
  const usdtIs0 = t0.toLowerCase() === C.usdt.toLowerCase();
  const px = (t) => { const raw = Math.pow(1.0001, t); return usdtIs0 ? 1e12 / raw : raw * 1e12; };
  const gap = Math.abs(Number(s0[1]) - avgTick);
  return { avg30min: +px(avgTick).toFixed(4), live: +px(Number(s0[1])).toFixed(4), gapTicks: gap, market: VOLS[gap < 15 ? 0 : gap < 35 ? 1 : gap < 60 ? 2 : 3], stable: gap <= 100 };
}
function depthOf(price, ref, dir) {
  const move = dir === 0 ? (ref - price) / ref : (price - ref) / ref;
  if (!(move > 0)) return 0;
  const bps = move * 10000;
  return bps < 500 ? 1 : bps < 1000 ? 2 : bps < 1500 ? 3 : bps < 2000 ? 4 : bps < 3000 ? 5 : bps < 4000 ? 6 : 7;
}
async function askChip(input) {
  const hex = '0x' + (input & 0xff).toString(16).padStart(2, '0') + ((input >> 8) & 0xff).toString(16).padStart(2, '0');
  const o = parseInt((await read(C.processor, PROC, 'eval', [BigInt(C.circuit2Id), hex])).slice(2, 4), 16);
  return { allow: (o & 1) === 1, k: o & 1 ? (o >> 1) & 3 : 0 };
}

/* ------------------------------------------------------------------ vault reads */
async function vaultInfo(v) {
  const F = ['owner', 'keeper', 'savings', 'paused', 'direction', 'mode', 'tokenIn', 'tokenOut', 'baseAmount', 'perTxCap', 'dailyCap', 'refPrice', 'limitPrice',
    'minInterval', 'minAmount', 'nextTradeAt', 'spentTodayNow', 'volumeIn', 'totalOut', 'trades', 'feeBpsNow', 'twapPrice'];
  const r = Object.fromEntries(await Promise.all(F.map(async (f) => [f, await read(v, VAULT2, f)])));
  r.dir = Number(r.direction); r.modeIx = Number(r.mode);
  r.balance = await read(r.tokenIn, ERC20, 'balanceOf', [v]);
  r.leftover = await read(r.tokenOut, ERC20, 'balanceOf', [v]);
  return r;
}
async function decision(v, r, caller) {
  const [inputs, k, amount, fee] = await read(v, VAULT2, 'preview', [caller]);
  const x = Number(inputs);
  const dep = (x >> 7) & 7, vol = (x >> 10) & 3;
  let why;
  if (amount > 0n) why = `the chip says ${r.dir === 0 ? 'buy' : 'sell'} ${Number(k)}× (${amtOf(amount, r.dir)})`;
  else if (r.paused) why = 'paused by the owner';
  else if (caller.toLowerCase() !== r.keeper.toLowerCase()) why = `only the vault's bot (${r.keeper}) can trade`;
  else if (r.dailyCap - r.spentTodayNow < r.minAmount) why = "today's limit is used";
  else if (r.nextTradeAt > 0n) why = `next trade possible at ${new Date(Number(r.nextTradeAt) * 1000).toISOString()}`;
  else if (r.balance < r.minAmount) why = `the vault needs ${r.dir === 0 ? 'USDT0' : 'WOKB'}`;
  else {
    const [allow, kk] = await read(v, VAULT2, 'chip', [(x & 0xff80) | 0x7e]);
    if (!allow || Number(kk) === 0) why = vol === 3 && r.modeIx >= 2 ? 'the market is very jumpy; the strategy waits' : `OKB is ${DEPTHS[dep]} ${r.dir === 0 ? 'below' : 'above'} the reference; the strategy waits`;
    else why = r.dir === 0 ? 'OKB is above the ceiling, or moving too fast' : 'OKB is under the floor, or moving too fast';
  }
  return { tradeNow: amount > 0n, multiplier: Number(k), amount: amtOf(amount, r.dir), fee: amtOf(fee, r.dir), why,
    chipSees: { move: DEPTHS[dep], market: VOLS[vol], safetyChecksPassed: (x & 0x7f) === 0x7e, inputBits: '0x' + x.toString(16).padStart(4, '0') } };
}
const summary = (v, r) => ({
  vault: v, job: r.dir === 0 ? 'Buy OKB' : 'Take profit', strategy: MODE_TEXT[r.dir][r.modeIx], paused: r.paused,
  owner: r.owner, outputGoesTo: r.savings, bot: r.keeper,
  baseAmount: amtOf(r.baseAmount, r.dir), mostPerTrade: amtOf(r.perTxCap, r.dir), mostPerDay: amtOf(r.dailyCap, r.dir), usedToday: amtOf(r.spentTodayNow, r.dir),
  referencePrice: usd(r.refPrice), [r.dir === 0 ? 'ceiling' : 'floor']: usd(r.limitPrice), average30min: usd(r.twapPrice),
  spacingSeconds: Number(r.minInterval), balance: amtOf(r.balance, r.dir),
  [r.dir === 0 ? 'okbBought' : 'usdt0Received']: r.dir === 0 ? Number(formatUnits(r.totalOut, 18)) : usd(r.totalOut),
  trades: Number(r.trades), feePercent: Number(r.feeBpsNow) / 100, page: `${C.site}/#/vaults`
});

/* ------------------------------------------------------------------ commands */
async function run() {
  switch (cmd) {
    case 'market': return out({ okb: await market(), note: 'Prices in USDT0 per OKB, from the Uniswap V3 pool every Latch vault uses.' });
    case 'try': {
      const dir = dirOf(need('dir', null, 'buy or sell')); const mode = modeOf(opt.mode || 'smart');
      const ref = Number(need('ref', (v) => Number(v) > 0, 'reference price, USDT0 per OKB'));
      const limit = Number(need('limit', (v) => Number(v) > 0, dir === 0 ? 'ceiling price' : 'floor price'));
      const base = Number(opt.base || (dir === 0 ? 2 : 0.02));
      const m = await market();
      const depth = depthOf(m.avg30min, ref, dir); const vol = m.gapTicks < 15 ? 0 : m.gapTicks < 35 ? 1 : m.gapTicks < 60 ? 2 : 3;
      const priceOk = (dir === 0 ? m.avg30min <= limit : m.avg30min >= limit) && m.stable;
      const input = ((priceOk ? 0x7e : 0x76) | (depth << 7) | (vol << 10) | (mode << 12));
      const c = await askChip(input);
      return out({
        answer: c.allow ? `${dir === 0 ? 'buy' : 'sell'} ${c.k}× = ${+(base * c.k).toFixed(6)} ${dir === 0 ? 'USDT0' : 'OKB'}` : 'wait',
        why: !priceOk ? (dir === 0 ? 'the 30-minute average is above the ceiling (or the market is unstable)' : 'the 30-minute average is under the floor (or the market is unstable)')
          : c.allow ? `OKB is ${DEPTHS[depth]} ${dir === 0 ? 'below' : 'above'} ${ref}; market ${VOLS[vol]}` : (vol === 3 && mode >= 2 ? 'very jumpy market: strategy waits' : `OKB is ${DEPTHS[depth]} ${dir === 0 ? 'below' : 'above'} ${ref}: strategy waits`),
        strategy: MODE_TEXT[dir][mode], market: m, chip: { circuit: C.circuit2Id, processor: C.processor, input: '0x' + input.toString(16).padStart(4, '0') },
        assumes: 'vault funded, inside its limits, not paused'
      });
    }
    case 'vaults': {
      const owner = addr('owner', 'owner address');
      const list = await read(C.factory2, FACTORY2, 'vaultsOf', [owner]);
      return out({ owner, vaults: await Promise.all(list.map(async (v) => summary(v, await vaultInfo(v)))) });
    }
    case 'status': {
      const v = addr('vault', 'vault address'); const r = await vaultInfo(v);
      return out({ ...summary(v, r), now: await decision(v, r, r.keeper) });
    }
    case 'create': {
      const dir = dirOf(need('dir', null, 'buy or sell')); const mode = modeOf(opt.mode || 'smart'); const dec = dir === 0 ? 6 : 18;
      const savings = addr('savings', 'wallet that receives the output');
      const [treasury, hosted, minB, minS] = await Promise.all(['treasury', 'hostedKeeper', 'minBuy', 'minSell'].map((f) => read(C.factory2, FACTORY2, f)));
      if (savings.toLowerCase() === treasury.toLowerCase()) throw new UserError("that address is Latch's fee wallet; choose another --savings");
      const base = parseUnits(need('base', (v) => Number(v) > 0, 'amount per trade'), dec);
      const maxK = mode >= 2 ? 3n : 1n;
      const perTx = opt['per-trade'] ? parseUnits(opt['per-trade'], dec) : base * maxK;
      const daily = opt.daily ? parseUnits(opt.daily, dec) : perTx;
      const min = dir === 0 ? minB : minS;
      if (base < min) throw new UserError(`--base must be at least ${amtOf(min, dir)}`);
      if (perTx < base || daily < perTx) throw new UserError('need base ≤ per-trade ≤ daily');
      const every = EVERY[opt.every || 'day']; if (every === undefined) throw new UserError('--every must be any, hour, day or week');
      const keeper = opt.keeper ? getAddress(opt.keeper) : ZERO;
      const data = encodeFunctionData({ abi: FACTORY2, functionName: 'createVault',
        args: [dir, mode, savings, base, perTx, daily, parseUnits(need('ref', (v) => Number(v) > 0, 'reference price'), 6), parseUnits(need('limit', (v) => Number(v) > 0, dir === 0 ? 'ceiling price' : 'floor price'), 6), every, keeper] });
      return out({ transactions: [tx(`Create a ${dir === 0 ? 'Buy OKB' : 'Take profit'} vault (${MODES[mode]}): ${amtOf(base, dir)} per trade, up to ${amtOf(perTx, dir)} per trade and ${amtOf(daily, dir)} per day, output to ${savings}, bot: ${keeper === ZERO ? `Latch hosted (${hosted})` : keeper}`, C.factory2, data)],
        next: 'After it confirms: `latch vaults --owner <the signing wallet>` to get the vault address, then `latch fund`.' });
    }
    case 'fund': {
      const v = addr('vault', 'vault address'); const r = await vaultInfo(v); const dec = r.dir === 0 ? 6 : 18;
      const amount = parseUnits(need('amount', (x) => Number(x) > 0, 'amount'), dec);
      return out({ transactions: [tx(`Add ${amtOf(amount, r.dir)} to the vault`, r.tokenIn, encodeFunctionData({ abi: ERC20, functionName: 'transfer', args: [v, amount] }))],
        note: r.dir === 1 ? 'Take Profit vaults hold WOKB. If the wallet has only OKB, run `latch wrap` first.' : undefined });
    }
    case 'wrap': {
      const amount = parseUnits(need('amount', (x) => Number(x) > 0, 'OKB amount'), 18);
      return out({ transactions: [tx(`Wrap ${formatUnits(amount, 18)} OKB into WOKB (1:1, unwrap any time)`, C.wokb, encodeFunctionData({ abi: WOKB, functionName: 'deposit' }), amount)] });
    }
    case 'pause': case 'resume': {
      const v = addr('vault', 'vault address');
      return out({ transactions: [tx(`${cmd === 'pause' ? 'Pause' : 'Resume'} the vault (owner only)`, v, encodeFunctionData({ abi: VAULT2, functionName: 'setPaused', args: [cmd === 'pause'] }))] });
    }
    case 'strategy': {
      const v = addr('vault', 'vault address'); const r = await vaultInfo(v); const dec = r.dir === 0 ? 6 : 18;
      const base = opt.base ? parseUnits(opt.base, dec) : r.baseAmount;
      if (base > r.perTxCap) throw new UserError(`--base can be at most the per-trade limit, ${amtOf(r.perTxCap, r.dir)} (limits can only go down)`);
      const mode = opt.mode ? modeOf(opt.mode) : r.modeIx;
      const ref = opt.ref ? parseUnits(opt.ref, 6) : r.refPrice; const limit = opt.limit ? parseUnits(opt.limit, 6) : r.limitPrice;
      const every = opt.every ? EVERY[opt.every] : r.minInterval; if (every === undefined) throw new UserError('--every must be any, hour, day or week');
      return out({ transactions: [tx(`Change strategy: ${MODES[mode]}, ${amtOf(base, r.dir)} per trade, reference ${usd(ref)}, ${r.dir === 0 ? 'ceiling' : 'floor'} ${usd(limit)} (owner only)`, v,
        encodeFunctionData({ abi: VAULT2, functionName: 'setStrategy', args: [base, r.perTxCap, r.dailyCap, ref, limit, every, mode] }))] });
    }
    case 'withdraw': {
      const v = addr('vault', 'vault address'); const to = addr('to', 'where the money goes'); const r = await vaultInfo(v);
      const t = [];
      if (r.balance > 0n) t.push(tx(`Withdraw ${amtOf(r.balance, r.dir)} (owner only)`, v, encodeFunctionData({ abi: VAULT2, functionName: 'withdraw', args: [r.tokenIn, to, MAX] })));
      if (r.leftover > 0n) t.push(tx('Withdraw leftover output token (owner only)', v, encodeFunctionData({ abi: VAULT2, functionName: 'withdraw', args: [r.tokenOut, to, MAX] })));
      return out({ transactions: t, note: t.length ? 'Run them in order.' : 'The vault is already empty.' });
    }
    case 'tick': {
      const v = addr('vault', 'vault address'); const as = addr('as', "the agent wallet address (must be the vault's bot)"); const r = await vaultInfo(v);
      const d = await decision(v, r, as);
      return out({ ...d, transactions: d.tradeNow ? [tx(`Trade now: ${d.why}`, v, encodeFunctionData({ abi: VAULT2, functionName: 'tick' }))] : [],
        note: d.tradeNow ? 'Sign it now; the vault re-checks everything at the moment of the trade.' : 'Nothing to do now. Ask again later (the bot checks about once a minute).' });
    }
    default:
      process.stdout.write(fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').filter((l) => l.startsWith('//')).slice(0, 18).map((l) => l.slice(3)).join('\n') + '\n');
      process.exit(cmd ? 1 : 0);
  }
}
run().catch((e) => {
  let msg = e instanceof UserError ? e.message : (e.shortMessage || e.message || String(e)).split('\n')[0];
  try { const data = e?.cause?.data || e?.data; if (typeof data === 'string') msg += ' (' + decodeErrorResult({ abi: VAULT2, data }).errorName + ')'; } catch { /* */ }
  out({ error: msg }); process.exit(1);
});
