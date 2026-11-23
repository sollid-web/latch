// Latch v2 test suite: LatchVault + LatchFactory2 + strategy circuit #2 (the real TAP-02 netlist from
// circuits/circuit2.json, run by a TAP-02 processor stand-in) against the OFFICIAL Uniswap V3 factory,
// pool and SwapRouter02 bytecode on a throwaway anvil chain. No real money, no internet.
//   needs: anvil on PATH (or ANVIL=...), and `npm i` in audit/swap (solc, viem, Uniswap artifacts).
//   run:   node audit/v2/vault.test.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const swapDir = path.join(root, 'audit', 'swap');
const require = createRequire(path.join(swapDir, 'x.js'));
const solc = require('solc');
const { createPublicClient, createWalletClient, http, decodeErrorResult } = await import(path.join(swapDir, 'node_modules/viem/_esm/index.js'));
const { privateKeyToAccount } = await import(path.join(swapDir, 'node_modules/viem/_esm/accounts/index.js'));
const uni = (p) => require(path.join(swapDir, 'node_modules/@uniswap', p));

/* ---------------- compile ---------------- */
const src = (f) => fs.readFileSync(f, 'utf8');
const C = (f) => src(path.join(root, 'contracts', f));
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'LatchVault.sol': { content: C('LatchVault.sol') }, 'UniMath.sol': { content: C('UniMath.sol') },
    'LatchFactory2.sol': { content: C('LatchFactory2.sol') }, 'Helpers.sol': { content: src(path.join(swapDir, 'Helpers.sol')) }
  },
  settings: { viaIR: true, optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}), { import: (p) => ({ contents: C(path.basename(p)) }) }));
for (const e of out.errors || []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });
const Vault = art('LatchVault.sol', 'LatchVault'), Fac = art('LatchFactory2.sol', 'LatchFactory2');
const ERC = art('Helpers.sol', 'TestERC20'), Proc = art('Helpers.sol', 'NetlistProcessor'), Driver = art('Helpers.sol', 'PoolDriver');
const Factory = uni('v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const Pool = uni('v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');
const Router = uni('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
const circuit2 = JSON.parse(src(path.join(root, 'circuits/circuit2.json')));

/* ---------------- chain ---------------- */
const PORT = 8661, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--chain-id', '196', '--silent', '--code-size-limit', '100000']);
await new Promise((r) => setTimeout(r, 1500));
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a'
];
const [admin, bot, user, stranger, treasury] = KEYS.map((k) => privateKeyToAccount(k));
const chain = { id: 196, name: 'anvil', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const W = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });
const aw = W(admin), bw = W(bot), uw = W(user), sw = W(stranger);
const rpc = (method, params = []) => pub.request({ method, params });
const wait = async (s) => { await rpc('evm_increaseTime', [s]); await rpc('evm_mine'); };
async function deploy(a, args = []) {
  const r = await pub.waitForTransactionReceipt({ hash: await aw.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) });
  if (r.status !== 'success') throw new Error('deploy failed'); return r.contractAddress;
}
async function tx(w, address, abi, functionName, args = []) {
  const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName, args, gas: 15_000_000n }) });
  if (r.status !== 'success') throw new Error(functionName + ' reverted'); return r;
}
const read = (address, abi, functionName, args = [], account) => pub.readContract({ address, abi, functionName, args, account });
const ALL = [...Vault.abi, ...Fac.abi, ...Router.abi];
async function why(w, address, abi, functionName, args = []) {
  try { await pub.simulateContract({ account: w.account, address, abi, functionName, args }); return 'OK'; } catch (e) {
    if (e?.cause?.data?.errorName) return e.cause.data.errorName;
    const data = e?.cause?.raw || e?.cause?.cause?.data || e?.data;
    if (typeof data === 'string' && data.startsWith('0x')) { try { return decodeErrorResult({ abi: ALL, data }).errorName; } catch { /* */ } }
    return (e.shortMessage || e.message).split('\n')[0];
  }
}
let failures = 0;
const check = (name, cond, detail) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + String(detail))); if (!cond) failures++; };

try {
  /* ---------------- Uniswap at 80 USDT0 / OKB ---------------- */
  const usdt = await deploy(ERC, ['USDT0', 6]), wokb = await deploy(ERC, ['WOKB', 18]);
  const uf = await deploy({ abi: Factory.abi, bytecode: Factory.bytecode });
  const router = await deploy({ abi: Router.abi, bytecode: Router.bytecode }, [admin.address, uf, admin.address, wokb]);
  const driver = await deploy(Driver);
  await tx(aw, uf, Factory.abi, 'createPool', [usdt, wokb, 500]);
  const pool = await read(uf, Factory.abi, 'getPool', [usdt, wokb, 500]);
  const usdtIs0 = (await read(pool, Pool.abi, 'token0')).toLowerCase() === usdt.toLowerCase();
  const sqrtX96 = (P) => BigInt(Math.floor(Math.sqrt(usdtIs0 ? 1e12 / P : P / 1e12) * 2 ** 48)) * 2n ** 48n;
  await tx(aw, pool, Pool.abi, 'initialize', [sqrtX96(80)]);
  await tx(aw, pool, Pool.abi, 'increaseObservationCardinalityNext', [300]);
  const U = 10n ** 6n, O = 10n ** 18n, Z = '0x0000000000000000000000000000000000000000';
  for (const t of [usdt, wokb]) {
    for (const a of [admin, user, stranger]) { await tx(aw, t, ERC.abi, 'mint', [a.address, 10n ** 30n]); await tx(W(a), t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]); }
  }
  await tx(aw, driver, Driver.abi, 'addLiquidity', [pool, -887270, 887270, 10n ** 16n]);
  const MIN = 4295128740n, MAXS = 1461446703485210103287273052203988822378723970341n;
  const moveTo = async (P) => { // push the spot price to P (buy OKB to raise, sell OKB to lower)
    const s0 = await read(pool, Pool.abi, 'slot0'); const target = sqrtX96(P);
    const zeroForOne = target < s0[0];
    await tx(sw, driver, Driver.abi, 'push', [pool, zeroForOne, 10n ** 28n, target]);
  };
  await wait(2000);

  /* ---------------- circuit #2 on a TAP-02 processor ---------------- */
  const proc = await deploy(Proc);
  await tx(aw, proc, Proc.abi, 'tape', [2n, circuit2.netlist, 16, 3]);
  const fac = await deploy(Fac, [{
    processor: proc, circuitId: 2n, router, pool, quoteToken: usdt, baseToken: wokb, treasury: treasury.address,
    hostedKeeper: bot.address, twapWindow: 1800, slippageBps: 100n, minBuy: 1n * U, minSell: 10n ** 16n
  }]);
  const impl = await read(fac, Fac.abi, 'implementation');
  const create = async (w, a) => {
    await tx(w, fac, Fac.abi, 'createVault', [a.direction, a.mode, a.savings, a.base, a.perTx, a.daily, a.ref, a.limit, a.interval, a.keeper || Z]);
    const list = await read(fac, Fac.abi, 'vaultsOf', [w.account.address]); return list[list.length - 1];
  };
  const SAV = '0x00000000000000000000000000000000cafe0001';
  const okbOf = (a) => read(wokb, ERC.abi, 'balanceOf', [a]);
  const usdOf = (a) => read(usdt, ERC.abi, 'balanceOf', [a]);
  const tradedIn = (r) => { // amountIn + multiplier from the Traded event
    for (const l of r.logs) { try { const { decodeEventLog } = viemExtra; const e = decodeEventLog({ abi: Vault.abi, data: l.data, topics: l.topics }); if (e.eventName === 'Traded') return e.args; } catch { /* */ } }
    return null;
  };
  const viemExtra = await import(path.join(swapDir, 'node_modules/viem/_esm/index.js'));

  const implWhy = await why(sw, impl, Vault.abi, 'initialize', [{
    owner: stranger.address, processor: proc, circuitId: 2n, router, pool, twapWindow: 1800, quoteToken: usdt, baseToken: wokb, direction: 0, mode: 0,
    savings: SAV, treasury: treasury.address, keeper: stranger.address, guardian: Z, minAmount: 1n, baseAmount: 1n, perTxCap: 1n, dailyCap: 1n,
    refPrice: 1n, limitPrice: 1n, minInterval: 0n, maxSlippageBps: 100n }]);
  check('implementation cannot be initialised by anyone', implWhy === 'AlreadyInitialized', implWhy);

  /* ---- 1. BUY · smart DCA: OKB 20% under the reference → chip says 3x ---- */
  const smart = await create(uw, { direction: 0, mode: 2, savings: SAV, base: 2n * U, perTx: 6n * U, daily: 12n * U, ref: 102n * U, limit: 120n * U, interval: 3600n });
  check('vault: owner is the creator, keeper is the hosted bot', (await read(smart, Vault.abi, 'owner')).toLowerCase() === user.address.toLowerCase()
    && (await read(smart, Vault.abi, 'keeper')).toLowerCase() === bot.address.toLowerCase());
  check('vault cannot be initialised twice', (await why(sw, smart, Vault.abi, 'initialize', [{
    owner: stranger.address, processor: proc, circuitId: 2n, router, pool, twapWindow: 1800, quoteToken: usdt, baseToken: wokb, direction: 0, mode: 0,
    savings: SAV, treasury: treasury.address, keeper: stranger.address, guardian: Z, minAmount: 1n, baseAmount: 1n, perTxCap: 1n, dailyCap: 1n,
    refPrice: 1n, limitPrice: 1n, minInterval: 0n, maxSlippageBps: 100n }])) === 'AlreadyInitialized');
  await tx(uw, usdt, ERC.abi, 'transfer', [smart, 30n * U]);
  let p = await read(smart, Vault.abi, 'preview', [bot.address]);
  check('smart DCA at -21.5%: chip picks 3x (6 USDT0)', p[1] === 3 && p[2] === 6n * U, `k=${p[1]} amount=${p[2]} inputs=0x${p[0].toString(16)}`);
  const o0 = await okbOf(SAV);
  let r = await tx(bw, smart, Vault.abi, 'tick');
  let ev = tradedIn(r);
  check('tick trades exactly what preview said, OKB lands in savings', ev && ev.amountIn === 6n * U && ev.multiplier === 3 && (await okbOf(SAV)) > o0, JSON.stringify(ev, (k, v) => typeof v === 'bigint' ? v.toString() : v));
  check('fee 1% to treasury', (await usdOf(treasury.address)) === 60_000n);
  check('spacing: second trade within the hour refused', (await why(bw, smart, Vault.abi, 'tick')) === 'TooSoon');
  check('stranger cannot trade', (await why(sw, smart, Vault.abi, 'tick')) === 'NotKeeper');

  /* ---- 2. jumpy market: smart drops to 1x; very jumpy: smart pauses ---- */
  await wait(3700);
  await moveTo(80 * 1.0045); // ~45 ticks away from the TWAP → "jumpy"
  p = await read(smart, Vault.abi, 'preview', [bot.address]);
  check('jumpy (spot ~0.45% off the average): smart falls back to 1x', p[1] === 1 && p[2] === 2n * U, `k=${p[1]} amount=${p[2]} in=0x${p[0].toString(16)}`);
  await moveTo(80 * 1.008); // ~80 ticks → "very jumpy"
  p = await read(smart, Vault.abi, 'preview', [bot.address]);
  check('very jumpy (~0.8%): smart pauses (amount 0)', p[2] === 0n, `k=${p[1]} amount=${p[2]}`);
  check('very jumpy: tick refused by the chip', (await why(bw, smart, Vault.abi, 'tick')) === 'ChipSaysNo');
  await moveTo(80 * 1.015); // ~150 ticks → beyond the hard 1% stability rule
  check('beyond 1%: hard stability rule refuses before the chip', (await why(bw, smart, Vault.abi, 'tick')) === 'PriceUnstable');
  // review M-1: trending market, spot ~0.9% against a BUY (inside the 1% limit): preview yes ⇒ tick succeeds
  const trend = await create(uw, { direction: 0, mode: 0, savings: SAV, base: 2n * U, perTx: 2n * U, daily: 4n * U, ref: 80n * U, limit: 100n * U, interval: 0n });
  await tx(uw, usdt, ERC.abi, 'transfer', [trend, 5n * U]);
  await moveTo(80); await wait(2000); await moveTo(80 * 1.009);
  p = await read(trend, Vault.abi, 'preview', [bot.address]);
  const tw = await why(bw, trend, Vault.abi, 'tick');
  check('trending ~0.9% against a buy: preview and tick agree', (p[2] > 0n && tw === 'OK') || (p[2] === 0n && tw !== 'OK'), `preview ${p[2]} tick ${tw}`);
  check('trending ~0.9%: the trade goes through', tw === 'OK', tw);
  await moveTo(80); await wait(2000);

  /* ---- 3. dip-only above the reference: no trade ---- */
  const dip = await create(uw, { direction: 0, mode: 1, savings: SAV, base: 1n * U, perTx: 1n * U, daily: 3n * U, ref: 70n * U, limit: 100n * U, interval: 0n });
  await tx(uw, usdt, ERC.abi, 'transfer', [dip, 5n * U]);
  p = await read(dip, Vault.abi, 'preview', [bot.address]);
  check('dip-only with OKB above the reference: chip says no', p[2] === 0n);
  check('dip-only: tick refused (ChipSaysNo)', (await why(bw, dip, Vault.abi, 'tick')) === 'ChipSaysNo');
  await tx(uw, dip, Vault.abi, 'setStrategy', [1n * U, 1n * U, 3n * U, 85n * U, 100n * U, 0n, 1]);
  p = await read(dip, Vault.abi, 'preview', [bot.address]);
  check('dip-only after reference raised to 85 (OKB ~6% under): buys 1x', p[1] === 1 && p[2] === 1n * U, `k=${p[1]}`);

  /* ---- 4. ladder: 1x at 5-15%, 2x at 15-30% ---- */
  const lad = await create(uw, { direction: 0, mode: 3, savings: SAV, base: 1n * U, perTx: 3n * U, daily: 9n * U, ref: 90n * U, limit: 100n * U, interval: 0n });
  await tx(uw, usdt, ERC.abi, 'transfer', [lad, 20n * U]);
  p = await read(lad, Vault.abi, 'preview', [bot.address]);
  check('ladder at -11%: 1x', p[1] === 1 && p[2] === 1n * U, `k=${p[1]}`);
  await tx(uw, lad, Vault.abi, 'setStrategy', [1n * U, 3n * U, 9n * U, 96n * U, 100n * U, 0n, 3]);
  p = await read(lad, Vault.abi, 'preview', [bot.address]);
  check('ladder at -16.7%: 2x', p[1] === 2 && p[2] === 2n * U, `k=${p[1]}`);

  /* ---- 5. plain DCA + caps ---- */
  const plain = await create(uw, { direction: 0, mode: 0, savings: SAV, base: 1n * U, perTx: 1n * U, daily: 2n * U, ref: 80n * U, limit: 90n * U, interval: 0n });
  await tx(uw, usdt, ERC.abi, 'transfer', [plain, 10n * U]);
  await tx(bw, plain, Vault.abi, 'tick'); await tx(bw, plain, Vault.abi, 'tick');
  p = await read(plain, Vault.abi, 'preview', [bot.address]);
  check('plain DCA: daily limit reached after 2 buys → preview 0', p[2] === 0n);
  check('plain DCA: 3rd buy same day refused early and cheaply (before the chip)', (await why(bw, plain, Vault.abi, 'tick')) === 'OverCap');
  check('caps cannot be raised', (await why(uw, plain, Vault.abi, 'setStrategy', [1n * U, 2n * U, 2n * U, 80n * U, 90n * U, 0n, 0])) === 'CapRaised');
  check('keeper cannot change the strategy', (await why(bw, plain, Vault.abi, 'setStrategy', [1n * U, 1n * U, 2n * U, 80n * U, 1000n * U, 0n, 0])) === 'NotOwner');

  /* ---- 6. price limit + worst-fill rule ---- */
  const tight = await create(uw, { direction: 0, mode: 0, savings: SAV, base: 1n * U, perTx: 1n * U, daily: 3n * U, ref: 80n * U, limit: 79n * U, interval: 0n });
  await tx(uw, usdt, ERC.abi, 'transfer', [tight, 5n * U]);
  check('BUY above the limit price refused', (await why(bw, tight, Vault.abi, 'tick')) === 'PriceOutside');
  await tx(uw, tight, Vault.abi, 'setStrategy', [1n * U, 1n * U, 3n * U, 80n * U, 80_200_000n, 0n, 0]);
  p = await read(tight, Vault.abi, 'preview', [bot.address]);
  check('average under the limit but worst fill above it: preview 0, bit 3 off', p[2] === 0n && (p[0] & 8) === 0, `in=0x${p[0].toString(16)}`);

  /* ---- 7. SELL · take profit: OKB 14% above the reference → smart 2x, USDT0 to savings ---- */
  const tp = await create(uw, { direction: 1, mode: 2, savings: SAV, base: 2n * 10n ** 16n, perTx: 6n * 10n ** 16n, daily: 10n ** 18n, ref: 70n * U, limit: 75n * U, interval: 0n });
  await tx(uw, wokb, ERC.abi, 'transfer', [tp, O]);
  p = await read(tp, Vault.abi, 'preview', [bot.address]);
  check('take profit at +14%: chip picks 2x (0.04 OKB)', p[1] === 2 && p[2] === 4n * 10n ** 16n, `k=${p[1]} amount=${p[2]}`);
  const u0 = await usdOf(SAV);
  r = await tx(bw, tp, Vault.abi, 'tick'); ev = tradedIn(r);
  const gotUsd = (await usdOf(SAV)) - u0;
  check('take profit: sold 0.04 OKB, ~3.2 USDT0 to savings', ev && ev.direction === 1 && gotUsd > 3_100_000n && gotUsd < 3_210_000n, `got ${gotUsd}`);
  check('take profit fee is 1% of the OKB sold, to treasury', (await okbOf(treasury.address)) === 4n * 10n ** 14n);
  check('take profit volume counted in USDT0 at the trade price (~3.2)', (await read(tp, Vault.abi, 'volumeQuote')) > 3_150_000n && (await read(tp, Vault.abi, 'volumeQuote')) < 3_250_000n);
  await tx(uw, tp, Vault.abi, 'setStrategy', [2n * 10n ** 16n, 6n * 10n ** 16n, 10n ** 18n, 10n ** 30n, 75n * U, 0n, 0]);
  check('fee tier cannot be gamed with a huge reference price (still 1%)', (await read(tp, Vault.abi, 'feeBpsNow')) === 100n);
  await tx(uw, tp, Vault.abi, 'setStrategy', [2n * 10n ** 16n, 6n * 10n ** 16n, 10n ** 18n, 70n * U, 85n * U, 0n, 2]);
  check('take profit below the floor price refused', (await why(bw, tp, Vault.abi, 'tick')) === 'PriceOutside');

  /* ---- 8. guardian, withdraw, factory rules ---- */
  await tx(aw, fac, Fac.abi, 'setRevoked', [bot.address, true]);
  check('revoked bot refused in every vault', (await why(bw, lad, Vault.abi, 'tick')) === 'NotKeeper');
  check('revoke does not touch funds: owner withdraws', (await why(uw, lad, Vault.abi, 'withdraw', [usdt, user.address, 2n ** 256n - 1n])) === 'OK');
  await tx(aw, fac, Fac.abi, 'setRevoked', [bot.address, false]);
  check('only admin revokes', (await why(sw, fac, Fac.abi, 'setRevoked', [bot.address, true])) === 'NotAdmin');
  check('factory admin cannot withdraw user funds', (await why(aw, lad, Vault.abi, 'withdraw', [usdt, admin.address, 1n])) === 'NotOwner');
  check('bot cannot withdraw', (await why(bw, lad, Vault.abi, 'withdraw', [usdt, bot.address, 1n])) === 'NotOwner');
  await tx(uw, tp, Vault.abi, 'withdraw', [wokb, user.address, 2n ** 256n - 1n]);
  check('owner withdraws all OKB from the take-profit vault', (await okbOf(tp)) === 0n);
  for (const [label, sav] of [['factory', fac], ['hosted bot', bot.address], ['treasury', treasury.address], ['another vault', smart], ['the pool', pool]]) {
    const rr = await why(uw, fac, Fac.abi, 'createVault', [0, 0, sav, 1n * U, 1n * U, 1n * U, 80n * U, 90n * U, 0n, Z]);
    check('factory: savings = ' + label + ' refused', rr === 'BadSavings' || rr === 'BadRecipient', rr);
  }
  check('factory: buy below the 1 USDT0 minimum refused', (await why(uw, fac, Fac.abi, 'createVault', [0, 0, SAV, 500_000n, 1n * U, 1n * U, 80n * U, 90n * U, 0n, Z])) === 'OverCap');
  check('factory: per-trade below base refused', (await why(uw, fac, Fac.abi, 'createVault', [0, 0, SAV, 2n * U, 1n * U, 3n * U, 80n * U, 90n * U, 0n, Z])) === 'OverCap');
  check('factory: bad mode refused', (await why(uw, fac, Fac.abi, 'createVault', [0, 4, SAV, 1n * U, 1n * U, 1n * U, 80n * U, 90n * U, 0n, Z])) === 'BadParam');
  check('factory: count + list', (await read(fac, Fac.abi, 'vaultCount')) === 7n && (await read(fac, Fac.abi, 'vaultsPage', [0n, 10n])).length === 7);

  /* ---- 9. the chip agrees with the spec on sample inputs ---- */
  const viaVault = async (x) => read(smart, Vault.abi, 'chip', [x]);
  const s = 0x7e;
  const cases = [[s | (5 << 7) | (2 << 12), true, 3], [s | (3 << 7) | (2 << 12), true, 2], [s | (2 << 12), true, 1], [s | (5 << 7) | (2 << 10) | (2 << 12), true, 1],
    [s | (5 << 7) | (3 << 10) | (2 << 12), false, 0], [s | (1 << 12), false, 0], [s | (1 << 7) | (1 << 12), true, 1], [s | (6 << 7) | (3 << 12), true, 3],
    [s | (6 << 7) | (2 << 10) | (3 << 12), true, 1], [0x7f | (5 << 7) | (2 << 12), false, 0], [s | (1 << 14), false, 0]];
  let okc = 0; for (const [x, a, k] of cases) { const [ga, gk] = await viaVault(x); if (ga === a && gk === k) okc++; }
  check(`chip answers ${cases.length} spot checks like the spec (paused, reserved bits, modes, volatility)`, okc === cases.length, `${okc}/${cases.length}`);
} catch (err) {
  console.error('TEST CRASHED:', err); failures++;
} finally { anvil.kill(); }
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
