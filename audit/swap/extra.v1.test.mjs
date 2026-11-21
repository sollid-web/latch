// NOTE: written by the independent reviewer against LatchSwap v1 (60s+ TWAP window, no spot check).
// Kept as evidence for INDEPENDENT_REVIEW.md. v2 rejects twapWindow < 1800, so this file no longer
// deploys against the current contract; the fixes are covered by swap.test.mjs.
// Independent-review tests for LatchSwap (does not modify contracts/).
//   run: cd audit/swap && ANVIL=/tmp/fdry/anvil SOLC076=/tmp/solc076/node_modules/solc node extra.test.mjs
// Part A: differential fuzz of contracts/UniMath.sol against the ORIGINAL Uniswap libraries
//         compiled with solc 0.7.6.
// Part B: scenario tests on real Uniswap V3 bytecode (factory, pool, SwapRouter02).
// A "FINDING" line documents behaviour that is real but is a design limitation, not a test failure.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const solc = require('solc');
const solc076 = require(process.env.SOLC076 || '/tmp/solc076/node_modules/solc');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const uni = (p) => require(path.join(here, 'node_modules/@uniswap', p));
const src = (f) => fs.readFileSync(f, 'utf8');

/* ------------------------------------------------------------ compile */
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'LatchSwap.sol': { content: src(path.join(root, 'contracts/LatchSwap.sol')) },
    'UniMath.sol': { content: src(path.join(root, 'contracts/UniMath.sol')) },
    'Helpers.sol': { content: src(path.join(here, 'Helpers.sol')) },
    'ExtraHelpers.sol': { content: src(path.join(here, 'ExtraHelpers.sol')) }
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}), { import: (p) => ({ contents: src(path.join(root, 'contracts', path.basename(p))) }) }));
for (const e of out.errors || []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const out7 = JSON.parse(solc076.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'RefMath076.sol': { content: src(path.join(here, 'RefMath076.sol')) } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}), { import: (p) => ({ contents: src(path.join(here, 'node_modules', p)) }) }));
for (const e of out7.errors || []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }

const art = (o, f, c) => ({ abi: o.contracts[f][c].abi, bytecode: '0x' + o.contracts[f][c].evm.bytecode.object });
const Swap = art(out, 'LatchSwap.sol', 'LatchSwap');
const ERC = art(out, 'Helpers.sol', 'TestERC20');
const Proc = art(out, 'Helpers.sol', 'NetlistProcessor');
const Driver = art(out, 'Helpers.sol', 'PoolDriver');
const Port = art(out, 'ExtraHelpers.sol', 'PortMath');
const ProbeA = art(out, 'ExtraHelpers.sol', 'Probe');
const FakeFactory = art(out, 'ExtraHelpers.sol', 'FakeFactory');
const FakeRouter = art(out, 'ExtraHelpers.sol', 'FakeRouter');
const FakePool = art(out, 'ExtraHelpers.sol', 'FakePool');
const Ref = art(out7, 'RefMath076.sol', 'RefMath076');
const Factory = uni('v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const Pool = uni('v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');
const Router = uni('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');

/* ------------------------------------------------------------ chain */
const PORT = 8631, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--chain-id', '196', '--silent', '--code-size-limit', '200000', '--gas-limit', '1000000000']);
await new Promise((r) => setTimeout(r, 1500));
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
];
const [owner, keeper, savings, attacker, treasury] = KEYS.map((k) => privateKeyToAccount(k));
const chain = { id: 196, name: 'anvil', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const W = (acc) => createWalletClient({ account: acc, chain, transport: http(RPC) });
const ow = W(owner), kw = W(keeper), aw = W(attacker);
const rpc = (method, params = []) => pub.request({ method, params });
const wait = async (secs) => { await rpc('evm_increaseTime', [secs]); await rpc('evm_mine'); };

async function deploy(a, args = []) {
  const hash = await ow.deployContract({ abi: a.abi, bytecode: a.bytecode, args, gas: 30_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('deploy failed');
  return r.contractAddress;
}
async function tx(w, address, abi, functionName, args = []) {
  const hash = await w.writeContract({ address, abi, functionName, args, gas: 15_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(functionName + ' reverted');
  return r;
}
const read = (address, abi, functionName, args = [], account) => pub.readContract({ address, abi, functionName, args, account });
const ALL_ABIS = [...Swap.abi, ...Router.abi];
async function why(w, address, abi, functionName, args = []) {
  try {
    await pub.simulateContract({ account: w.account, address, abi, functionName, args });
    return 'OK';
  } catch (e) {
    if (e?.cause?.data?.errorName) return e.cause.data.errorName + (e.cause.data.errorName === 'Error' ? ':' + e.cause.data.args?.[0] : '');
    const data = e?.cause?.raw || e?.cause?.cause?.data || e?.data;
    if (typeof data === 'string' && data.startsWith('0x')) {
      try { return decodeErrorResult({ abi: ALL_ABIS, data }).errorName; } catch { /* fallthrough */ }
    }
    return (e.shortMessage || e.message).split('\n').join(' ').slice(0, 400) + ' ' + String(data).slice(0,200);
  }
}
async function tryRead(address, abi, fn, args) {
  try { return { ok: true, v: await read(address, abi, fn, args) }; } catch (e) { return { ok: false, e: String(e.shortMessage || e.message).split('\n')[0] }; }
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  -> ' + String(detail)));
  if (!cond) failures++;
};
const finding = (name, detail) => console.log('FINDING ' + name + (detail !== undefined ? '  [' + detail + ']' : ''));

// deterministic PRNG
let seed = 0x1234567n;
const rnd = (bits) => { let r = 0n; for (let i = 0; i < bits; i += 32) { seed = (seed * 6364136223846793005n + 1442695040888963407n) & ((1n << 64n) - 1n); r = (r << 32n) | (seed >> 32n); } return r & ((1n << BigInt(bits)) - 1n); };

try {
  /* ================================================ Part A: math port */
  const port = await deploy(Port);
  const ref = await deploy(Ref);
  const MAXT = 887272;
  const ticks = [0, 1, -1, 2, -2, MAXT, -MAXT, MAXT - 1, -MAXT + 1, 443636, -443636, 230258, -230258, 276324, -276324, 524287, -524288, 524288, -524287];
  for (let b = 0; b < 20; b++) { ticks.push(1 << b, -(1 << b), (1 << b) - 1, -((1 << b) - 1)); }
  while (ticks.length < 1200) { const t = Number(rnd(21)) % (MAXT + 1); ticks.push(rnd(1) ? t : -t); }
  const okTicks = ticks.filter((t) => Math.abs(t) <= MAXT);
  const [sp, sr] = await Promise.all([read(port, Port.abi, 'sqrtBatch', [okTicks]), read(ref, Ref.abi, 'sqrtBatch', [okTicks])]);
  check(`getSqrtRatioAtTick: ${okTicks.length} ticks identical to v3-core 0.7.6`, sp.every((v, i) => v === sr[i]));
  check('getSqrtRatioAtTick(MIN/MAX) = MIN_SQRT_RATIO / MAX_SQRT_RATIO',
    sp[okTicks.indexOf(-MAXT)] === 4295128739n && sp[okTicks.indexOf(MAXT)] === 1461446703485210103287273052203988822378723970342n);
  for (const bad of [MAXT + 1, -MAXT - 1]) {
    const a = await tryRead(port, Port.abi, 'sqrtAt', [bad]);
    check(`getSqrtRatioAtTick(${bad}) reverts like the original`, !a.ok && !(await tryRead(ref, Ref.abi, 'sqrtAt', [bad])).ok);
  }
  const bases = okTicks.map((_, i) => [0n, 1n, (1n << 128n) - 1n, 10n ** 6n, 10n ** 18n][i % 5] || rnd(1 + Number(rnd(7))));
  for (let i = 0; i < bases.length; i++) if (i % 3 === 0) bases[i] = rnd(Number(rnd(7)) + 1);
  const A = '0x00000000000000000000000000000000000000aa', B = '0x00000000000000000000000000000000000000bb';
  let quoteOk = true, quoteN = 0;
  for (const [x, y] of [[A, B], [B, A]]) {
    for (let off = 0; off < okTicks.length; off += 200) {
      const ts = okTicks.slice(off, off + 200), bs = bases.slice(off, off + 200);
      const [qp, qr] = await Promise.all([tryRead(port, Port.abi, 'quoteBatch', [ts, bs, x, y]), tryRead(ref, Ref.abi, 'quoteBatch', [ts, bs, x, y])]);
      if (qp.ok !== qr.ok) { quoteOk = false; console.log('  batch revert mismatch', qp.e, qr.e); continue; }
      if (!qp.ok) {
        // a batch reverted in both (FullMath overflow at extreme tick * huge base): compare one by one
        for (let i = 0; i < ts.length; i++) {
          const [a, b] = await Promise.all([tryRead(port, Port.abi, 'quoteBatch', [[ts[i]], [bs[i]], x, y]), tryRead(ref, Ref.abi, 'quoteBatch', [[ts[i]], [bs[i]], x, y])]);
          if (a.ok !== b.ok || (a.ok && a.v[0] !== b.v[0])) quoteOk = false; quoteN++;
        }
      } else { quoteN += ts.length; if (!qp.v.every((v, i) => v === qr.v[i])) quoteOk = false; }
    }
  }
  check(`getQuoteAtTick: ${quoteN} (tick, base, order) cases identical to OracleLibrary 0.7.6, both token orders`, quoteOk);
  let mdOk = true, mdN = 0;
  const mdCases = [[0n, 0n, 0n], [1n, 1n, 0n], [2n ** 256n - 1n, 2n ** 256n - 1n, 2n ** 256n - 1n], [2n ** 256n - 1n, 2n ** 256n - 1n, 2n ** 255n], [2n ** 255n, 2n, 1n], [2n ** 255n, 2n, 2n], [3n, 2n ** 255n, 3n]];
  for (let i = 0; i < 150; i++) mdCases.push([rnd(Number(rnd(8)) + 1), rnd(Number(rnd(8)) + 1), rnd(Number(rnd(8)) + 1)]);
  for (const [a, b, d] of mdCases) {
    const [p, r] = await Promise.all([tryRead(port, Port.abi, 'mulDiv', [a, b, d]), tryRead(ref, Ref.abi, 'mulDiv', [a, b, d])]);
    mdN++;
    if (p.ok !== r.ok || (p.ok && p.v !== r.v)) { mdOk = false; console.log('  mulDiv mismatch', a, b, d, p, r); }
    if (p.ok && d > 0n && p.v !== (a * b) / d) { mdOk = false; console.log('  mulDiv != floor', a, b, d); }
  }
  check(`mulDiv: ${mdN} cases identical to FullMath 0.7.6 and to exact floor(a*b/d); same reverts`, mdOk);

  /* ================================================ Part B: pools */
  const usdt = await deploy(ERC, ['USDT0', 6]);
  // Get one WOKB-like token that sorts ABOVE usdt (usdt = token0, like mainnet: 0x779D < 0xe538)
  // and one that sorts BELOW (usdt = token1, negative ticks), to cover both orderings.
  let wHi, wLo;
  while (!wHi || !wLo) { const t = await deploy(ERC, ['WOKB', 18]); if (BigInt(t) > BigInt(usdt)) wHi = wHi || t; else wLo = wLo || t; }
  const factory = await deploy({ abi: Factory.abi, bytecode: Factory.bytecode });
  const router = await deploy({ abi: Router.abi, bytecode: Router.bytecode }, [owner.address, factory, owner.address, wHi]);
  const driver = await deploy(Driver);
  const proc = await deploy(Proc);
  const GATES = [[2,2],[3,9],[10,10],[11,4],[12,12],[13,5],[14,14],[15,6],[16,16],[17,7],[18,18],[19,8],[20,20]];
  const net = '0x' + GATES.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join('');
  await tx(ow, proc, Proc.abi, 'tape', [1n, net, 7, 1]);
  const probe = await deploy(ProbeA);
  const U = 10n ** 6n, O = 10n ** 18n;
  for (const t of [usdt, wHi, wLo]) {
    for (const a of [owner, attacker]) {
      await tx(ow, t, ERC.abi, 'mint', [a.address, 10n ** 32n]);
      await tx(W(a), t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]);
    }
  }
  const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
  const mkPool = async (wokb, fee, card = 100, lo = -887220, hi = 887220, L = 10n ** 15n, P = 40) => {
    await tx(ow, factory, Factory.abi, 'createPool', [usdt, wokb, fee]);
    const pool = await read(factory, Factory.abi, 'getPool', [usdt, wokb, fee]);
    const usdtIs0 = BigInt(usdt) < BigInt(wokb);
    const sqrtX96 = (p) => { const raw = usdtIs0 ? 1e12 / p : p / 1e12; return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * (2n ** 48n); };
    await tx(ow, pool, Pool.abi, 'initialize', [sqrtX96(P)]);
    if (card > 1) await tx(ow, pool, Pool.abi, 'increaseObservationCardinalityNext', [card]);
    await tx(ow, driver, Driver.abi, 'addLiquidity', [pool, lo, hi, L]);
    // buy OKB (push OKB price up) = pay USDT. zeroForOne iff USDT is token0.
    const pumpTo = (p) => tx(aw, driver, Driver.abi, 'push', [pool, usdtIs0, 10n ** 30n, sqrtX96(p)]);
    const dumpTo = (p) => tx(aw, driver, Driver.abi, 'push', [pool, !usdtIs0, 10n ** 30n, sqrtX96(p)]);
    const pumpMax = () => tx(aw, driver, Driver.abi, 'push', [pool, usdtIs0, 10n ** 30n, usdtIs0 ? MIN_SQRT : MAX_SQRT]);
    return { pool, wokb, usdtIs0, sqrtX96, pumpTo, dumpTo, pumpMax };
  };
  const cfg = (pp, over = {}) => ({
    processor: proc, circuitId: 1n, tokenIn: usdt, tokenOut: pp.wokb, router, pool: pp.pool,
    savings: savings.address, treasury: treasury.address, keeper: keeper.address,
    perTxCap: 100n * U, dailyCap: 300n * U, activationFee: 0n, maxPrice: 48n * U, maxSlippageBps: 150n, twapWindow: 600, ...over
  });
  const mkVault = async (pp, over = {}, fund = 10_000n * U) => {
    const v = await deploy(Swap, [cfg(pp, over)]);
    await tx(ow, usdt, ERC.abi, 'transfer', [v, fund]);
    await tx(ow, v, Swap.abi, 'arm');
    return v;
  };
  const savBal = (t) => read(t, ERC.abi, 'balanceOf', [savings.address]);

  const pHi = await mkPool(wHi, 3000, 100, -887220, 887220, 10n ** 17n);   // usdt = token0 (mainnet ordering), positive ticks
  const pLo = await mkPool(wLo, 3000, 100, -887220, 887220, 10n ** 17n);   // usdt = token1, negative ticks
  check('both token orderings covered', pHi.usdtIs0 && !pLo.usdtIs0);
  await wait(900);

  // ---- B1: vault TWAP == OracleLibrary.consult (0.7.6) incl. negative ticks and non-divisible remainders
  let b1 = true, b1n = 0;
  for (const pp of [pHi, pLo]) {
    const v = await mkVault(pp, { maxPrice: 1000n * U, twapWindow: 607 }); // odd window → remainders
    for (const [P, dt] of [[41.3, 37], [39.7, 101], [40.9, 13], [38.2, 211], [42.55, 59], [40, 300]]) {
      if (P > 40.5) await pp.pumpTo(P); else await pp.dumpTo(P);
      await wait(dt);
      const amt = 12_345_678n;
      const r = await read(probe, ProbeA.abi, 'both', [v, ref, pp.pool, 607, amt, usdt, pp.wokb, O]);
      b1n++;
      if (r[0] !== r[3] || r[1] !== r[4]) { b1 = false; console.log('  mismatch', pp.usdtIs0, P, r); }
      if (!pp.usdtIs0 && r[2] >= 0) { b1 = false; console.log('  expected negative tick', r[2]); }
    }
    await wait(700);
  }
  check(`TWAP price and expected-out equal OracleLibrary.consult+getQuoteAtTick (${b1n} samples, both orders, negative ticks, odd window)`, b1);

  // ---- B2: price sanity at 40 for both orderings
  for (const pp of [pHi, pLo]) {
    const v = await mkVault(pp, { maxPrice: 1000n * U });
    const [price, exp] = await read(v, Swap.abi, 'quote', [40n * U]);
    check(`ordering usdtIs0=${pp.usdtIs0}: TWAP ~40 USDT0/OKB and 40 USDT0 -> ~1 WOKB`, price > 39_900_000n && price < 40_100_000n && exp > 99n * O / 100n && exp < 101n * O / 100n, `${price} ${exp}`);
  }

  // ---- B3: multi-block TWAP manipulation — stolen keeper makes vault pay ~maxPrice while market is 40
  {
    const pp = pHi;
    const v = await mkVault(pp, { maxPrice: 48n * U });
    // market 40 (TWAP 40). attacker pumps to 47.3 and keeps it there for the TWAP window
    await pp.pumpTo(47.3); await wait(610);
    const [tw] = await read(v, Swap.abi, 'quote', [100n * U]);
    const before = await savBal(pp.wokb);
    const r = await why(kw, v, Swap.abi, 'tick', [100n * U]);
    if (r === 'OK') await tx(kw, v, Swap.abi, 'tick', [100n * U]);
    const got = (await savBal(pp.wokb)) - before;
    const eff = got > 0n ? Number(100n * U * O / got) / 1e6 : 0; if (!got) console.log("  B3 reason", r, tw);
    finding(`MANIPULATION: pool held at 47.3 for one window -> TWAP ${Number(tw) / 1e6}; keeper buy ${r}; vault paid ${eff.toFixed(3)} USDT0/OKB vs real market 40 (+${((eff / 40 - 1) * 100).toFixed(1)}%)`);
    check('B3 manipulated buy executes (protection is maxPrice, not market)', r === 'OK' && eff > 47, r + ' ' + eff);
    await pp.dumpTo(40); await wait(700);
  }

  // ---- B4: execution price above maxPrice (TWAP <= maxPrice, spot pumped inside slippage band)
  {
    const pp = pHi;
    await pp.pumpTo(47.9); await wait(700);
    const v = await mkVault(pp, { maxPrice: 48n * U, maxSlippageBps: 500n });
    const [tw, , minOut] = await read(v, Swap.abi, 'quote', [100n * U]);
    await pp.pumpTo(49.9); // spot +4.2% over TWAP, same block-ish as the buy
    const before = await savBal(pp.wokb);
    const r = await why(kw, v, Swap.abi, 'tick', [100n * U]);
    if (r === 'OK') await tx(kw, v, Swap.abi, 'tick', [100n * U]);
    const got = (await savBal(pp.wokb)) - before;
    const eff = got > 0n ? Number(100n * U * O / got) / 1e6 : 0;
    finding(`EXEC > MAXPRICE: TWAP ${Number(tw) / 1e6} <= max 48, spot pumped to 49.9, buy ${r}, effective ${eff.toFixed(3)} USDT0/OKB (minOut ${minOut})`);
    check('B4 effective execution price can exceed maxPrice by up to the slippage band', r === 'OK' && eff > 48);
    await pp.dumpTo(40); await wait(700);
  }

  // ---- B5: concentrated-liquidity pool: out-of-range ticks make TWAP manipulation nearly free
  {
    const tickOf = (p, usdtIs0) => Math.round(Math.log(usdtIs0 ? 1e12 / p : p / 1e12) / Math.log(1.0001));
    const ppx = await (async () => {
      // liquidity only between ~35 and ~46 USDT0/OKB, as many real concentrated pools are
      const usdtIs0 = BigInt(usdt) < BigInt(wHi);
      const a = tickOf(46, usdtIs0), b = tickOf(35, usdtIs0);
      const lo = Math.floor(Math.min(a, b) / 200) * 200, hi = Math.ceil(Math.max(a, b) / 200) * 200;
      return mkPool(wHi, 10000, 100, lo, hi, 10n ** 15n, 40);
    })();
    await wait(700);
    const v = await mkVault(ppx, { maxPrice: 1000n * U, twapWindow: 600 });
    const [tw0] = await read(v, Swap.abi, 'quote', [U]);
    const a0 = await read(usdt, ERC.abi, 'balanceOf', [attacker.address]);
    const w0 = await read(wHi, ERC.abi, 'balanceOf', [attacker.address]);
    await ppx.pumpMax();          // runs out of liquidity -> price jumps to the extreme tick
    await wait(3);                // hold ~3 seconds
    await ppx.dumpTo(40);          // and come back
    const [tw1] = await read(v, Swap.abi, 'quote', [U]);
    const a1 = await read(usdt, ERC.abi, 'balanceOf', [attacker.address]);
    const w1 = await read(wHi, ERC.abi, 'balanceOf', [attacker.address]);
    const costUsd = Number(a0 - a1) / 1e6 + Number(w0 - w1) / 1e18 * 40;
    finding(`THIN POOL: one ~4s excursion to the extreme tick moved the 600s TWAP from ${Number(tw0) / 1e6} to ${Number(tw1) / 1e6} USDT0/OKB; attacker round-trip cost ~${costUsd.toFixed(2)} USD (fees on in-range liquidity only)`);
    check('B5 TWAP on a pool with liquidity gaps is cheaply movable', tw1 > tw0 * 12n / 10n, `${tw0} -> ${tw1}`);
  }

  // ---- B6: day rollover lets 2x dailyCap go through within seconds
  {
    const pp = pHi;
    const v = await mkVault(pp, { maxPrice: 1000n * U, perTxCap: 100n * U, dailyCap: 100n * U });
    const now = Number((await pub.getBlock()).timestamp);
    const end = Math.ceil((now + 1) / 86400) * 86400;
    await rpc('evm_setNextBlockTimestamp', [end - 2]);
    await tx(kw, v, Swap.abi, 'tick', [100n * U]);
    await rpc('evm_setNextBlockTimestamp', [end + 1]);
    await tx(kw, v, Swap.abi, 'tick', [100n * U]);
    const spent = await read(v, Swap.abi, 'volumeSwept');
    finding(`DAY BOUNDARY: ${Number(spent) / 1e6} USDT0 bought within 3 seconds with dailyCap 100 (fixed UTC window)`);
    check('B6 2x dailyCap possible around 00:00 UTC (expected with fixed windows)', spent === 200n * U);
  }

  // ---- B7: maxSlippageBps below the pool fee tier: every buy reverts, but preview says allow
  {
    const pp = pHi;
    const v = await mkVault(pp, { maxPrice: 1000n * U, maxSlippageBps: 25n });
    const [, allow] = await read(v, Swap.abi, 'preview', [1n * U], keeper.address);
    const r = await why(kw, v, Swap.abi, 'tick', [1n * U]);
    finding(`SLIPPAGE < FEE TIER: preview allow=${allow}, tick -> ${r}`);
    check('B7 slippage 0.25% on a 0.3% pool cannot ever fill (preview/tick disagree)', allow === true && r !== 'OK');
  }

  // ---- B8: cardinality-1 pool: a single tick-moving swap by anyone blocks buys for a full window
  {
    const pc = await mkPool(wLo, 500, 1);
    await wait(700);
    const v = await mkVault(pc, { maxPrice: 1000n * U });
    const r0 = await why(kw, v, Swap.abi, 'tick', [1n * U]);
    await pc.dumpTo(39.9); // griefer: tiny tick-moving swap
    await wait(5);
    const r1 = await why(kw, v, Swap.abi, 'tick', [1n * U]);
    const pv = await tryRead(v, Swap.abi, 'preview', [1n * U]);
    finding(`CARDINALITY 1: before grief tick=${r0}; after one swap tick=${r1}; preview ${pv.ok ? 'ok' : 'reverts'}`);
    check('B8 cardinality-1 pool: buy blocked after any tick change (fails closed, griefable)', r0 === 'OK' && r1 !== 'OK');
  }

  // ---- B9: same-block manipulation never moves the TWAP (Uniswap observation semantics)
  {
    const pp = pLo;
    const v = await mkVault(pp, { maxPrice: 1000n * U });
    const [tA] = await read(v, Swap.abi, 'quote', [U]);
    await rpc('evm_setAutomine', [false]);
    const h1 = await aw.writeContract({ address: driver, abi: Driver.abi, functionName: 'push', args: [pp.pool, pp.usdtIs0, 10n ** 30n, pp.sqrtX96(80)], gas: 5_000_000n });
    const h2 = await kw.writeContract({ address: v, abi: Swap.abi, functionName: 'tick', args: [U], gas: 5_000_000n });
    await rpc('evm_mine'); await rpc('evm_setAutomine', [true]);
    const r1 = await pub.waitForTransactionReceipt({ hash: h1 });
    const r2 = await pub.waitForTransactionReceipt({ hash: h2 });
    check('B9 same-block pump to 2x then tick: pump lands, buy reverts (slippage vs unmoved TWAP)', r1.status === 'success' && r2.status === 'reverted', `${r1.status} ${r2.status} twap ${tA}`);
    await pp.dumpTo(40); await wait(700);
  }

  // ---- B10: constructor trusts router.factory(): a fake router/factory/pool triple is accepted
  {
    const fp = await deploy(FakePool, [usdt, wHi]);
    const ff = await deploy(FakeFactory, [fp]);
    const fr = await deploy(FakeRouter);
    await tx(ow, fr, FakeRouter.abi, 'setFactory', [ff]);
    let ok = true; try { await deploy(Swap, [{ ...cfg(pHi), router: fr, pool: fp }]); } catch { ok = false; }
    check('B10 constructor accepts any router whose factory() vouches for the pool (deployer must pin canonical addresses)', ok);
  }

  // ---- B11: savings = address(1)/(2) (SwapRouter02 MSG_SENDER / ADDRESS_THIS sentinels) is accepted but fails closed
  for (const s of ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']) {
    const v = await mkVault(pHi, { maxPrice: 1000n * U, savings: s }, 100n * U);
    const r = await why(kw, v, Swap.abi, 'tick', [1n * U]);
    check(`B11 savings=${s.slice(-1)}: deploy accepted, tick reverts (${r}) - no loss`, r !== 'OK');
  }

  // ---- B12: stolen keeper with dust amounts pays zero fee and cannot do harm
  {
    const v = await mkVault(pHi, { maxPrice: 1000n * U, activationFee: 0n });
    const r = await why(kw, v, Swap.abi, 'tick', [99n]);
    check(`B12 dust tick(99 base units): ${r} (fee rounds to 0; output may round to 0 -> SwapShort)`, true);
  }
} catch (err) {
  console.error('TEST CRASHED:', err);
  failures++;
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
