// End-to-end test of the hosted helper bot against the REAL LatchFactory + LatchSwap contracts
// and the official Uniswap V3 factory/pool/SwapRouter02 bytecode, on a throwaway anvil chain.
// No real money, no internet. Needs anvil on PATH (or ANVIL=/path/to/anvil). Run: npm test
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { runOnce, marketCheck, priceFrom } from '../src/keeper.js';
import { recordTrades, readTrades } from '../src/trades.js';

const require = createRequire(import.meta.url);
const solc = require('solc');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'LatchSwap.sol': { content: read('contracts/LatchSwap.sol') },
    'UniMath.sol': { content: read('contracts/UniMath.sol') },
    'LatchFactory.sol': { content: read('contracts/LatchFactory.sol') },
    'Helpers.sol': { content: read('audit/swap/Helpers.sol') }
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}), { import: (p) => ({ contents: read('contracts/' + path.basename(p)) }) }));
for (const e of out.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
const out2 = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'LatchVault.sol': { content: read('contracts/LatchVault.sol') }, 'UniMath.sol': { content: read('contracts/UniMath.sol') }, 'LatchFactory2.sol': { content: read('contracts/LatchFactory2.sol') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}), { import: (p) => ({ contents: read('contracts/' + path.basename(p)) }) }));
for (const e of out2.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
const Vault2 = { abi: out2.contracts['LatchVault.sol'].LatchVault.abi };
const Fac2 = { abi: out2.contracts['LatchFactory2.sol'].LatchFactory2.abi, bytecode: '0x' + out2.contracts['LatchFactory2.sol'].LatchFactory2.evm.bytecode.object };
const circuit2 = JSON.parse(read('circuits/circuit2.json'));
const art = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });
const Swap = art('LatchSwap.sol', 'LatchSwap'), Fac = art('LatchFactory.sol', 'LatchFactory');
const ERC = art('Helpers.sol', 'TestERC20'), Proc = art('Helpers.sol', 'NetlistProcessor'), Driver = art('Helpers.sol', 'PoolDriver');
const uni = (p) => require(path.join(here, '..', 'node_modules/@uniswap', p));
const Factory = uni('v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const Pool = uni('v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');
const Router = uni('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');

const PORT = 8641, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--chain-id', '196', '--silent', '--code-size-limit', '100000']);
await new Promise((r) => setTimeout(r, 1500));
const KEYS = [ // anvil's public dev keys
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
];
const [admin, bot, alice, bob] = KEYS.map((k) => privateKeyToAccount(k));
const chain = { id: 196, name: 'anvil', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const W = (a) => createWalletClient({ account: a, chain, transport: http(RPC) });
const aw = W(admin);
const dep = async (a, args = []) => (await pub.waitForTransactionReceipt({ hash: await aw.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress;
async function tx(w, address, abi, functionName, args = []) {
  const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName, args, gas: 15_000_000n }) });
  if (r.status !== 'success') throw new Error(functionName + ' reverted');
}
const rd = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const wait = async (s) => { await pub.request({ method: 'evm_increaseTime', params: [s] }); await pub.request({ method: 'evm_mine', params: [] }); };

let failures = 0;
const check = (name, cond, detail) => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(detail, (k, v) => (typeof v === 'bigint' ? v.toString() : v)))); if (!cond) failures++; };

try {
  // Uniswap + tokens, price 77 USDT0/OKB, aged 35 min
  const usdt = await dep(ERC, ['USDT0', 6]), wokb = await dep(ERC, ['WOKB', 18]);
  const uf = await dep(Factory), router = await dep(Router, [admin.address, uf, admin.address, wokb]), driver = await dep(Driver);
  await tx(aw, uf, Factory.abi, 'createPool', [usdt, wokb, 500]);
  const pool = await rd(uf, Factory.abi, 'getPool', [usdt, wokb, 500]);
  const usdtIs0 = (await rd(pool, Pool.abi, 'token0')).toLowerCase() === usdt.toLowerCase();
  const raw = usdtIs0 ? 1e12 / 77 : 77 / 1e12;
  await tx(aw, pool, Pool.abi, 'initialize', [BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * 2n ** 48n]);
  await tx(aw, pool, Pool.abi, 'increaseObservationCardinalityNext', [200]);
  for (const t of [usdt, wokb]) { await tx(aw, t, ERC.abi, 'mint', [admin.address, 10n ** 30n]); await tx(aw, t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]); }
  await tx(aw, driver, Driver.abi, 'addLiquidity', [pool, -887270, 887270, 10n ** 15n]);
  const proc = await dep(Proc);
  const G = [[2,2],[3,9],[10,10],[11,4],[12,12],[13,5],[14,14],[15,6],[16,16],[17,7],[18,18],[19,8],[20,20]];
  await tx(aw, proc, Proc.abi, 'tape', [1n, '0x' + G.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join(''), 7, 1]);
  await wait(2100);

  const fac = await dep(Fac, [proc, 1n, usdt, wokb, router, pool, admin.address, bot.address, 1800, 100n, 1_000_000n]);
  const U = 10n ** 6n, Z = '0x0000000000000000000000000000000000000000';
  const env = { KEEPER_PRIVATE_KEY: KEYS[1], RPC_URL: RPC, FACTORY_ADDRESS: fac, CHAIN_ID: '196' };
  const P = (x) => [{ venue: 'A', ok: true, price: x }, { venue: 'B', ok: true, price: x + 0.1 }, { venue: 'C', ok: true, price: x - 0.1 }];

  check('market check: pool 77 vs exchanges 77 → safe', marketCheck(P(77), 77, 2).safe === true);
  check('market check: pool 77 vs exchanges 70 → refuse', marketCheck(P(70), 77, 2).safe === false);
  check('market check: one exchange only → refuse', marketCheck([{ venue: 'A', ok: true, price: 77 }], 77, 2).safe === false);
  const reason = (j, pick) => { try { priceFrom(j, pick); return ''; } catch (e) { return e.message; } };
  check('price source: pair not listed (KuCoin data:null) → plain reason', /pair not listed/.test(reason({ code: '200000', data: null }, (j) => j.data.price)));
  check('price source: exchange error text is shown (HTX)', /invalid symbol/.test(reason({ status: 'error', 'err-msg': 'invalid symbol' }, (j) => j.tick.close)));
  check('price source: good answer → number', priceFrom({ data: [{ last: '83.1' }] }, (j) => j.data[0].last) === 83.1);

  let r = await runOnce(env, { send: true, wait: true, prices: P(77) });
  check('no vaults yet: idle', r.action === 'idle', r);

  // Alice: daily DCA, ceiling 200. Bob: buy the dip at 48. Carol (=admin acct): own bot.
  const fund = async (who, v, amt) => { await tx(aw, usdt, ERC.abi, 'transfer', [who.address, amt]); await tx(W(who), usdt, ERC.abi, 'transfer', [v, amt]); };
  await tx(W(alice), fac, Fac.abi, 'createVault', [alice.address, 1n * U, 3n * U, 200n * U, 86400n, Z]);
  await tx(W(bob), fac, Fac.abi, 'createVault', [bob.address, 2n * U, 6n * U, 48n * U, 0n, Z]);
  await tx(aw, fac, Fac.abi, 'createVault', ['0x1111111111111111111111111111111111111111', 1n * U, 3n * U, 200n * U, 0n, '0x000000000000000000000000000000000000dEaD']);
  const [va] = await rd(fac, Fac.abi, 'vaultsOf', [alice.address]);
  const [vb] = await rd(fac, Fac.abi, 'vaultsOf', [bob.address]);
  const [vc] = await rd(fac, Fac.abi, 'vaultsOf', [admin.address]);
  await fund(alice, va, 5n * U); await fund(bob, vb, 10n * U); await tx(aw, usdt, ERC.abi, 'transfer', [vc, 5n * U]);
  const okb = (a) => rd(wokb, ERC.abi, 'balanceOf', [a]);
  const row = (rep, v) => (rep.vaults || []).find((x) => x.vault.toLowerCase() === v.toLowerCase()) || {};

  r = await runOnce(env, { send: false, prices: P(77) });
  check('dry run: Alice (DCA) would buy', row(r, va).action === 'would-buy', r);
  check('dry run: Bob (dip at 48) holds at 77', row(r, vb).action === 'hold', row(r, vb));
  check('dry run: Carol uses her own bot → skipped', row(r, vc).action === 'skip', row(r, vc));
  check('dry run sends nothing', (await okb(alice.address)) === 0n);

  r = await runOnce(env, { send: true, wait: true, prices: P(70) });
  check('pool 77 vs exchanges 70: nobody buys', r.action === 'hold' && (await okb(alice.address)) === 0n, r);

  r = await runOnce(env, { send: true, wait: true, prices: P(77) });
  check('Alice: DCA buy lands in her wallet', row(r, va).action === 'bought' && (await okb(alice.address)) > 0n, row(r, va));
  check('Bob: still waiting for his price', row(r, vb).action === 'hold' && (await okb(bob.address)) === 0n);
  const a1 = await okb(alice.address);
  r = await runOnce(env, { send: true, wait: true, prices: P(77) });
  check('Alice: next minute → waits for tomorrow', row(r, va).action === 'hold' && /next buy time/.test(row(r, va).why) && (await okb(alice.address)) === a1, row(r, va));

  // OKB dips to ~45 and stays 35 min
  await tx(aw, driver, Driver.abi, 'push', [pool, !usdtIs0, 10n ** 30n, BigInt(Math.floor(Math.sqrt(usdtIs0 ? 1e12 / 45 : 45 / 1e12) * 2 ** 48)) * 2n ** 48n]);
  await wait(2100);
  r = await runOnce(env, { send: true, wait: true, prices: P(45) });
  check('dip to 45: Bob buys', row(r, vb).action === 'bought' && (await okb(bob.address)) > 0n, row(r, vb));
  await tx(W(bob), vb, Swap.abi, 'setPaused', [true]);
  r = await runOnce(env, { send: true, wait: true, prices: P(45) });
  check('Bob pauses: bot respects it', row(r, vb).action === 'hold' && /paused/.test(row(r, vb).why), row(r, vb));

  // Fairness: 30 vaults, window of 25 → rotation reaches every vault
  const many = [];
  for (let i = 0; i < 27; i++) { await tx(aw, fac, Fac.abi, 'createVault', ['0x2222222222222222222222222222222222222222', 1n * U, 3n * U, 200n * U, 0n, Z]); }
  const env2 = { ...env, MAX_CHECKS_PER_RUN: '25' };
  const seen = new Set();
  for (const off of [0, 25]) { const rr = await runOnce(env2, { send: false, prices: P(45), offset: off }); rr.vaults.forEach((x) => seen.add(x.vault.toLowerCase())); }
  check('rotation: every one of 30 vaults gets checked within 2 runs', seen.size === 30, seen.size);
  void many;

  // Bot key cannot touch funds even if stolen
  let stolen = 'OK';
  try { await pub.simulateContract({ account: bot, address: vb, abi: Swap.abi, functionName: 'withdraw', args: [usdt, bot.address, 1n] }); } catch { stolen = 'refused'; }
  check('stolen bot key cannot withdraw', stolen === 'refused');

  /* ---- v2: Buy + Take Profit vaults sized by strategy circuit #2 (pool now ~45) ---- */
  await tx(aw, proc, Proc.abi, 'tape', [2n, circuit2.netlist, 16, 3]);
  const fac2 = await dep(Fac2, [{ processor: proc, circuitId: 2n, router, pool, quoteToken: usdt, baseToken: wokb, treasury: admin.address,
    hostedKeeper: bot.address, twapWindow: 1800, slippageBps: 100n, minBuy: 1n * U, minSell: 10n ** 16n }]);
  const SAV2 = '0x3333333333333333333333333333333333333333';
  await tx(W(alice), fac2, Fac2.abi, 'createVault', [0, 2, SAV2, 1n * U, 3n * U, 6n * U, 60n * U, 50n * U, 0n, Z]); // smart DCA, ref 60 → -25%
  await tx(W(alice), fac2, Fac2.abi, 'createVault', [1, 2, SAV2, 10n ** 16n, 3n * 10n ** 16n, 10n ** 17n, 39n * U, 40n * U, 0n, Z]); // take profit, ref 39 → +15%
  await tx(W(alice), fac2, Fac2.abi, 'createVault', [0, 1, SAV2, 1n * U, 1n * U, 3n * U, 40n * U, 50n * U, 0n, Z]); // dip-only, ref 40 → above it
  const [vBuy, vSell, vDip] = await rd(fac2, Fac2.abi, 'vaultsOf', [alice.address]);
  await fund(alice, vBuy, 7n * U); await fund(alice, vDip, 3n * U);
  await tx(aw, wokb, ERC.abi, 'transfer', [vSell, 5n * 10n ** 16n]);
  const env3 = { ...env, FACTORY_ADDRESS: '', FACTORY2_ADDRESS: fac2 };
  r = await runOnce(env3, { send: false, prices: P(45) });
  check('v2 dry run: Buy vault would buy at 3x (OKB 25% under reference)', row(r, vBuy).action === 'would-buy' && row(r, vBuy).multiplier === 3, row(r, vBuy));
  check('v2 dry run: Take Profit vault would sell at 2x (OKB 15% above reference)', row(r, vSell).action === 'would-sell' && row(r, vSell).multiplier === 2, row(r, vSell));
  check('v2 dry run: dip-only above its reference → plain reason', row(r, vDip).action === 'hold' && /strategy says wait/.test(row(r, vDip).why), row(r, vDip));
  const usdOf = (a) => rd(usdt, ERC.abi, 'balanceOf', [a]);
  const o0 = await okb(SAV2), u0 = await usdOf(SAV2);
  r = await runOnce(env3, { send: true, wait: true, prices: P(45) });
  check('v2: Buy vault bought 3 USDT0 of OKB → savings', row(r, vBuy).action === 'bought' && row(r, vBuy).amount === String(3n * U) && (await okb(SAV2)) > o0, row(r, vBuy));
  check('v2: Take Profit sold 0.02 OKB → USDT0 in savings', row(r, vSell).action === 'sold' && (await usdOf(SAV2)) > u0, row(r, vSell));
  r = await runOnce(env3, { send: true, wait: true, prices: P(45) });
  check('v2: Buy vault buys again (3x) on the next run', row(r, vBuy).action === 'bought' && row(r, vBuy).amount === String(3n * U), row(r, vBuy));
  r = await runOnce(env3, { send: true, wait: true, prices: P(45) });
  check('v2: then holds with "daily limit reached"', row(r, vBuy).action === 'hold' && /daily limit/.test(row(r, vBuy).why), row(r, vBuy));
  r = await runOnce({ ...env3, FACTORY_ADDRESS: fac }, { send: false, prices: P(45), offset: 0 });
  check('v1 + v2 factories served in one run', r.vaults.some((x) => x.version === 1) && r.vaults.some((x) => x.version === 2), r.vaultCount);
  r = await runOnce({ ...env3, REQUIRE_FEE_COVERS_GAS: '1' }, { send: true, wait: true, prices: P(45) });
  await tx(W(alice), vDip, Vault2.abi, 'withdraw', [usdt, alice.address, 2n ** 256n - 1n]);
  r = await runOnce(env3, { send: false, prices: P(45) });
  check('v2: empty vault → "not enough money in the vault"', /not enough money/.test(row(r, vDip).why), row(r, vDip));
  check('optional fee-covers-gas filter holds tiny trades when gas is dear', ['hold', 'later'].includes(row(r, vSell).action) || row(r, vSell).action === 'sold', row(r, vSell));

  /* ---- trade recorder: full history in KV, walked in small windows like the public RPC forces ---- */
  const store = new Map(); let puts = 0;
  const kv = { get: async (k, t) => (store.has(k) ? (t === 'json' ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => { puts++; store.set(k, v); } };
  const v1s = await rd(fac, Fac.abi, 'vaultsPage', [0n, 100n]), v2s = await rd(fac2, Fac2.abi, 'vaultsPage', [0n, 100n]);
  const all = [...v1s, ...v2s];
  const real = (await pub.getLogs({ address: all, events: (await import('../src/trades.js')).EVENTS, fromBlock: 0n, toBlock: 'latest' })).length;
  await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_mine', params: ['0x5'] }) });
  let rec, steps = 0;
  do { rec = await recordTrades({ kv, rpc: RPC, factories: [fac, fac2], vaults1: v1s, vaults2: v2s, windowSize: 3, minWindow: 3, perBatch: 4, requests: 2, since: '2000-01-01T00:00:00Z', now: 1e12 + steps }); steps++; } while (rec.cursor <= rec.head && steps < 500);
  const got = await readTrades(kv);
  check('recorder: walks from the first factory to the tip in many small windows', steps > 2 && got.complete, { steps, rec });
  check('recorder: finds every trade on chain (classic + v2), each once', real > 3 && got.trades.length === real, { real, got: got.trades.length });
  check('recorder: v2 rows carry direction and chip size; classic rows are version 1', got.trades.some((t) => t.version === 2 && t.k >= 1 && t.dir === 1) && got.trades.some((t) => t.version === 1), got.trades.slice(0, 3));
  const before = puts; rec = await recordTrades({ kv, rpc: RPC, factories: [fac, fac2], vaults1: v1s, vaults2: v2s, windowSize: 3, minWindow: 3, since: '2000-01-01T00:00:00Z', now: 1e12 + steps + 1000 });
  check('recorder: re-running finds no duplicates and does not write when nothing changed', rec.found === 0 && puts === before && (await readTrades(kv)).trades.length === real, { rec, puts, before });
  { // start from a date: finds a block at or just before it, from block timestamps only
    const mid = await pub.getBlock({ blockNumber: 30n });
    const kv2 = { m: new Map(), get: async (k) => (kv2.m.has(k) ? JSON.parse(kv2.m.get(k)) : null), put: async (k, v) => { kv2.m.set(k, v); } };
    const r1 = await recordTrades({ kv: kv2, rpc: RPC, factories: [fac, fac2], vaults1: v1s, vaults2: v2s, windowSize: 3, minWindow: 3, perBatch: 2, requests: 1, since: new Date(Number(mid.timestamp) * 1000).toISOString(), now: 5e12 });
    check('recorder: a start date maps to a block at or before it', r1.start <= 30 && !r1.error, r1);
    // an RPC that refuses batches: falls back to one window per request and still catches up
    const noBatch = async (url, init) => { const body = JSON.parse(init.body); if (Array.isArray(body) && body.length > 1) return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'batch not supported' } }), { status: 200 }); return fetch(url, init); };
    const kv3 = { m: new Map(), get: async (k) => (kv3.m.has(k) ? JSON.parse(kv3.m.get(k)) : null), put: async (k, v) => { kv3.m.set(k, v); } };
    let r3, n = 0; do { r3 = await recordTrades({ kv: kv3, rpc: RPC, factories: [fac, fac2], vaults1: v1s, vaults2: v2s, windowSize: 5, minWindow: 5, perBatch: 4, requests: 3, since: '2000-01-01T00:00:00Z', fetchFn: noBatch, now: 6e12 + n }); n++; } while (r3.cursor <= r3.head && n < 200);
    check('recorder: RPC without batch support → one window per request, still finds every trade', (await readTrades(kv3)).trades.length === real, { n, r3 });
  }
  { // an RPC that refuses big block ranges (like the public X Layer RPC): the window halves until it is accepted
    const LIMIT = 10;
    const ranged = async (url, init) => {
      const body = JSON.parse(init.body); const items = Array.isArray(body) ? body : [body];
      const tooBig = items.some((x) => x.method === 'eth_getLogs' && Number(x.params[0].toBlock) - Number(x.params[0].fromBlock) + 1 > LIMIT);
      if (tooBig) return new Response(JSON.stringify(Array.isArray(body) ? items.map((x) => ({ jsonrpc: '2.0', id: x.id, error: { code: -32000, message: 'block range exceeds limit' } })) : { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'block range exceeds limit' } }), { status: 200 });
      return fetch(url, init);
    };
    const kv4 = { m: new Map(), get: async (k) => (kv4.m.has(k) ? JSON.parse(kv4.m.get(k)) : null), put: async (k, v) => { kv4.m.set(k, v); } };
    let r4, n = 0; do { r4 = await recordTrades({ kv: kv4, rpc: RPC, factories: [fac, fac2], windowSize: 80, minWindow: 5, perBatch: 3, requests: 4, since: '2000-01-01T00:00:00Z', fetchFn: ranged, now: 7e12 + n }); n++; } while (r4.cursor <= r4.head && n < 300);
    const got4 = await readTrades(kv4);
    check('recorder: RPC with a block-range limit → window shrinks (80 → ' + got4.blocksPerRequest + '), still finds every trade', got4.blocksPerRequest <= LIMIT && got4.trades.length === real, { n, got4: { ...got4, trades: got4.trades.length } });
    check('recorder: with no vault list given, reads both factories itself', got4.trades.length === real);
  }
  { // like the public X Layer RPC on mainnet: "over rate limit" when hit with too many requests at once
    let inFlight = 0, refused = 0;
    const limited = async (url, init) => {
      if (url.includes('dead.invalid')) throw new Error('fetch failed (dns)');
      inFlight++;
      try {
        if (inFlight > 2) { refused++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32016, message: 'over rate limit' } }), { status: 200 }); }
        await new Promise((r) => setTimeout(r, 5));
        return await fetch(url, init);
      } finally { inFlight--; }
    };
    const kv5 = { m: new Map(), get: async (k) => (kv5.m.has(k) ? JSON.parse(kv5.m.get(k)) : null), put: async (k, v) => { kv5.m.set(k, v); } };
    let r5, n = 0;
    do { r5 = await recordTrades({ kv: kv5, rpc: RPC, rpcs: ['http://dead.invalid:1', RPC], factories: [fac, fac2], windowSize: 6, minWindow: 6, perBatch: 2, requests: 12, parallel: 8, pauseMs: 0, since: '2000-01-01T00:00:00Z', fetchFn: limited, now: 8e12 + n }); n++; }
    while (r5.cursor <= r5.head && n < 300);
    const got5 = await readTrades(kv5);
    check('recorder: "over rate limit" → slows down (8 → ' + got5.parallel + ' at a time) and still finds every trade', refused > 0 && got5.parallel <= 4 && got5.trades.length === real, { n, refused, got5: { ...got5, trades: got5.trades.length } });
    check('recorder: a rate limit is not mistaken for a block-range limit (window stays 6)', got5.blocksPerRequest === 6, got5.blocksPerRequest);
    check('recorder: a dead endpoint in the list is dropped, the others carry on', /dead\.invalid/.test(got5.lastSkippedEndpoint || '') && !got5.error, got5.lastSkippedEndpoint);
  }
  { // like mainnet on 28 Nov: the RPC counts every lookup inside a bundle, so a bundle of more than 3 is always "over rate limit",
    // even sent one at a time. The recorder must make the bundle smaller, not only send fewer at once (it was stuck for a week).
    let refusedB = 0;
    const heavy = async (url, init) => {
      const body = JSON.parse(init.body);
      if (Array.isArray(body) && body.length > 3) { refusedB++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32016, message: 'over rate limit' } }), { status: 200 }); }
      return fetch(url, init);
    };
    const kv6 = { m: new Map(), get: async (k) => (kv6.m.has(k) ? JSON.parse(kv6.m.get(k)) : null), put: async (k, v) => { kv6.m.set(k, v); } };
    let r6, n = 0;
    do { r6 = await recordTrades({ kv: kv6, rpc: RPC, factories: [fac, fac2], windowSize: 6, minWindow: 6, perBatch: 6, requests: 6, parallel: 1, pauseMs: 0, since: '2000-01-01T00:00:00Z', fetchFn: heavy, now: 9e12 + n }); n++; }
    while (r6.cursor <= r6.head && n < 300);
    const got6 = await readTrades(kv6);
    check('recorder: a bundle the RPC always calls "over rate limit" → bundle shrinks (6 → ' + got6.windowsPerRequest + '), still finds every trade', refusedB > 0 && got6.windowsPerRequest <= 3 && got6.complete && got6.trades.length === real, { n, refusedB, got6: { ...got6, trades: got6.trades.length } });
    check('recorder: /trades says which endpoint last refused and why', /over rate limit/.test(got6.lastRateLimit || ''), got6.lastRateLimit);
  }
  check('recorder: no KV binding → skipped, never throws', (await recordTrades({ kv: null, rpc: RPC, factories: [fac] })).skipped);
} catch (err) {
  console.error('TEST CRASHED:', err); failures++;
} finally { anvil.kill(); }
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
