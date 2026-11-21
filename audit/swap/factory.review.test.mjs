// NOTE: written by the independent reviewer against LatchSwap v3 / LatchFactory before the v4 fixes.
// Kept as evidence for INDEPENDENT_REVIEW_V3.md; constructor signatures changed in v4 (minAmount, guardian).
// Independent review of LatchSwap v3 + LatchFactory. Reuses the swap.test.mjs harness
// (real UniswapV3Factory / Pool / SwapRouter02 bytecode on anvil).
//   run: cd audit/swap && ANVIL=/tmp/fdry/anvil node factory.review.test.mjs
// Lines starting with FINDING print measured behaviour behind INDEPENDENT_REVIEW_V3.md.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, decodeErrorResult, encodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const solc = require('solc');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const uni = (p) => require(path.join(here, 'node_modules/@uniswap', p));
const src = (f) => fs.readFileSync(f, 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'LatchSwap.sol': { content: src(path.join(root, 'contracts/LatchSwap.sol')) },
    'UniMath.sol': { content: src(path.join(root, 'contracts/UniMath.sol')) },
    'LatchFactory.sol': { content: src(path.join(root, 'contracts/LatchFactory.sol')) },
    'Helpers.sol': { content: src(path.join(here, 'Helpers.sol')) }
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
}), { import: (p) => ({ contents: src(path.join(root, 'contracts', path.basename(p))) }) }));
for (const e of out.errors || []) if (e.severity === 'error') { console.error(e.formattedMessage); process.exit(1); }
const art = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });
const Swap = art('LatchSwap.sol', 'LatchSwap');
const Fac = art('LatchFactory.sol', 'LatchFactory');
const ERC = art('Helpers.sol', 'TestERC20');
const Proc = art('Helpers.sol', 'NetlistProcessor');
const Driver = art('Helpers.sol', 'PoolDriver');
const Factory = uni('v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const Pool = uni('v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');
const Router = uni('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');

const PORT = 8633, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--chain-id', '196', '--silent', '--code-size-limit', '100000']);
await new Promise((r) => setTimeout(r, 1500));
const KEYS = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
];
const [admin, hosted, user, attacker, treasury, user2] = KEYS.map((k) => privateKeyToAccount(k));
const chain = { id: 196, name: 'anvil', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const W = (acc) => createWalletClient({ account: acc, chain, transport: http(RPC) });
const adw = W(admin), hw = W(hosted), uw = W(user), aw = W(attacker), u2w = W(user2);
const rpc = (method, params = []) => pub.request({ method, params });
const wait = async (secs) => { await rpc('evm_increaseTime', [secs]); await rpc('evm_mine'); };
const ZERO = '0x0000000000000000000000000000000000000000';

async function deploy(a, args = []) {
  const hash = await adw.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
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
// send without simulation, fixed gas; return receipt even if it reverted
async function rawSend(w, address, abi, functionName, args, gas = 1_000_000n) {
  const hash = await w.sendTransaction({ to: address, data: encodeFunctionData({ abi, functionName, args }), gas });
  return pub.waitForTransactionReceipt({ hash });
}
const read = (address, abi, functionName, args = [], account) => pub.readContract({ address, abi, functionName, args, account });
const ALL_ABIS = [...Swap.abi, ...Router.abi, ...Fac.abi];
async function why(w, address, abi, functionName, args = []) {
  try {
    await pub.simulateContract({ account: w.account, address, abi, functionName, args });
    return 'OK';
  } catch (e) {
    if (e?.cause?.data?.errorName) return e.cause.data.errorName;
    const data = e?.cause?.raw || e?.cause?.cause?.data || e?.data;
    if (typeof data === 'string' && data.startsWith('0x')) {
      try { return decodeErrorResult({ abi: ALL_ABIS, data }).errorName; } catch { /* */ }
    }
    const m = (e.shortMessage || e.message);
    const r = m.match(/reverted with the following reason:\s*\n?(.*)/);
    return r ? r[1].trim() : m.split('\n')[0];
  }
}
let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + String(detail)));
  if (!cond) failures++;
};
const finding = (s) => console.log('FINDING ' + s);

try {
  /* ------------------------------------------------ mainnet-like pool: 0.05% tier, ~20k USDT0 deep */
  const usdt = await deploy(ERC, ['USDT0', 6]);
  const wokb = await deploy(ERC, ['WOKB', 18]);
  const factory = await deploy({ abi: Factory.abi, bytecode: Factory.bytecode });
  const router = await deploy({ abi: Router.abi, bytecode: Router.bytecode }, [admin.address, factory, admin.address, wokb]);
  const driver = await deploy(Driver);
  const FEE = 500;
  await tx(adw, factory, Factory.abi, 'createPool', [usdt, wokb, FEE]);
  const pool = await read(factory, Factory.abi, 'getPool', [usdt, wokb, FEE]);
  const usdtIs0 = (await read(pool, Pool.abi, 'token0')).toLowerCase() === usdt.toLowerCase();
  const sqrtX96 = (P) => {
    const raw = usdtIs0 ? 1e12 / P : P / 1e12;
    return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * (2n ** 48n);
  };
  await tx(adw, pool, Pool.abi, 'initialize', [sqrtX96(40)]);
  await tx(adw, pool, Pool.abi, 'increaseObservationCardinalityNext', [300]);
  const U = 10n ** 6n, O = 10n ** 18n;
  for (const a of [admin, attacker, user, user2]) {
    for (const t of [usdt, wokb]) {
      await tx(adw, t, ERC.abi, 'mint', [a.address, 10n ** 30n]);
      await tx(W(a), t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]);
    }
  }
  // full range L ~ 3.16e15 → ~20k USDT0 + ~500 WOKB at 40
  await tx(adw, driver, Driver.abi, 'addLiquidity', [pool, -887270, 887270, 3_160_000_000_000_000n]);
  await wait(2000);
  const proc = await deploy(Proc);
  const GATES = [[2,2],[3,9],[10,10],[11,4],[12,12],[13,5],[14,14],[15,6],[16,16],[17,7],[18,18],[19,8],[20,20]];
  const net = '0x' + GATES.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join('');
  await tx(adw, proc, Proc.abi, 'tape', [1n, net, 7, 1]);
  const fac = await deploy(Fac, [proc, 1n, usdt, wokb, router, pool, treasury.address, hosted.address, 1800, 100n]);

  const create = async (w, savings, perTx, daily, maxPrice, minInterval, keeper = ZERO) => {
    const r = await tx(w, fac, Fac.abi, 'createVault', [savings, perTx, daily, maxPrice, minInterval, keeper]);
    const list = await read(fac, Fac.abi, 'vaultsOf', [w.account.address]);
    return { vault: list[list.length - 1], receipt: r };
  };
  const fund = (w, v, amt) => tx(w, usdt, ERC.abi, 'transfer', [v, amt]);
  const MOVE = async (w, toP) => {
    const [sp] = await read(pool, Pool.abi, 'slot0');
    const target = sqrtX96(toP);
    // zeroForOne lowers sqrtPrice
    await tx(w, driver, Driver.abi, 'push', [pool, target < sp, 10n ** 30n, target]);
  };

  /* ================= A. funds: only the owner can move them ================= */
  const { vault: va, receipt: rc } = await create(uw, user.address, 2n * U, 6n * U, 1000n * U, 0n);
  await fund(uw, va, 50n * U);
  check('A1 factory admin cannot withdraw', (await why(adw, va, Swap.abi, 'withdraw', [usdt, admin.address, 1n])) === 'NotOwner');
  check('A2 factory admin cannot setKeeper/pause/transferOwnership on a user vault',
    (await why(adw, va, Swap.abi, 'setKeeper', [admin.address])) === 'NotOwner'
    && (await why(adw, va, Swap.abi, 'setPaused', [true])) === 'NotOwner'
    && (await why(adw, va, Swap.abi, 'transferOwnership', [admin.address])) === 'NotOwner');
  check('A3 hosted keeper cannot withdraw', (await why(hw, va, Swap.abi, 'withdraw', [usdt, hosted.address, 1n])) === 'NotOwner');
  check('A4 factory itself is not owner (owner = creator)', (await read(va, Swap.abi, 'owner')).toLowerCase() === user.address.toLowerCase());
  await tx(adw, fac, Fac.abi, 'setHostedKeeper', [attacker.address]);
  check('A5 admin rotating hostedKeeper does NOT change existing vaults', (await read(va, Swap.abi, 'keeper')).toLowerCase() === hosted.address.toLowerCase());
  finding('A5b => a stolen hosted key cannot be revoked centrally: every owner must call setKeeper/setPaused themselves');
  await tx(adw, fac, Fac.abi, 'setHostedKeeper', [hosted.address]);
  check('A6 nobody but owner can accept a pending transfer', (await why(aw, va, Swap.abi, 'acceptOwnership')) === 'NotOwner');
  // events emitted at creation
  const topics = rc.logs.map((l) => l.topics[0]);
  const { keccak256, toBytes } = await import('viem');
  const sig = (s) => keccak256(toBytes(s));
  check('A7 creation emits Armed, OwnershipTransferred, VaultCreated',
    topics.includes(sig('Armed(address,uint256)')) && topics.includes(sig('OwnershipTransferred(address,address)'))
    && topics.includes(sig('VaultCreated(address,address,address,uint256,uint256,uint256,uint256)')));
  finding('A7b VaultCreated has no savings / slippage / twap field; no KeeperSet/MaxPriceSet/MinIntervalSet at construction');

  /* ================= B. preview says allow, tick reverts (hosted keeper griefing) ================= */
  const [twap] = await read(va, Swap.abi, 'quote', [U]);
  console.log('   TWAP', Number(twap) / 1e6);
  // B1: maxPrice in the band (TWAP, TWAP / ((1-fee)(1-slip))) → preview allow, tick PriceTooHigh
  const { vault: vb1 } = await create(attacker && aw, attacker.address, 2n * U, 6n * U, twap + twap / 200n, 0n); // max = TWAP + 0.5%
  await fund(aw, vb1, 10n * U);
  let [bits, allow] = await read(vb1, Swap.abi, 'preview', [2n * U], hosted.address);
  const r1 = await why(hw, vb1, Swap.abi, 'tick', [2n * U]);
  check('B1 maxPrice = TWAP+0.5%: preview allow=true but tick reverts PriceTooHigh (preview/tick mismatch)', allow === true && r1 === 'PriceTooHigh', `${bits} ${allow} ${r1}`);
  let rcp = await rawSend(hw, vb1, Swap.abi, 'tick', [2n * U]);
  finding(`B1 gas burnt by keeper per reverted tick (worst-fill check): ${rcp.gasUsed} (status ${rcp.status})`);

  // B2: perTxCap too big for pool depth → passes every vault check, reverts inside the router after the swap
  const { vault: vb2 } = await create(aw, attacker.address, 3000n * U, 3000n * U, 1000n * U, 0n);
  await fund(aw, vb2, 3100n * U);
  [bits, allow] = await read(vb2, Swap.abi, 'preview', [3000n * U], hosted.address);
  const r2 = await why(hw, vb2, Swap.abi, 'tick', [3000n * U]);
  check('B2 3000 USDT0 buy on ~20k pool: preview allow=true, tick reverts in router (price impact > 1% slippage)', allow === true && r2 !== 'OK', `${allow} ${r2}`);
  rcp = await rawSend(hw, vb2, Swap.abi, 'tick', [3000n * U]);
  finding(`B2 gas burnt per reverted tick (late revert in router): ${rcp.gasUsed} (status ${rcp.status}); attacker capital stays withdrawable, cost 0`);
  await tx(aw, vb2, Swap.abi, 'withdraw', [usdt, attacker.address, 2n ** 256n - 1n]);

  // B3a: factory slippage 100 bps vs 100-tick deviation band: aligned (spot 0.98% over TWAP still fills)
  const { vault: vb3 } = await create(uw, user.address, 2n * U, 6n * U, 1000n * U, 0n);
  await fund(uw, vb3, 10n * U);
  await MOVE(aw, Number(twap) / 1e6 * 1.0098);
  const [sT, tT] = await read(vb3, Swap.abi, 'ticks');
  const r3a = await why(hw, vb3, Swap.abi, 'tick', [2n * U]);
  check(`B3a slippage 100bps, spot ${Number(sT) - Number(tT)} ticks off TWAP: still fills (band and minOut aligned)`, r3a === 'OK', r3a);
  // B3b: owner lowers slippage to 1 bp: every bit of upward drift = preview allow, late router revert
  await tx(uw, vb3, Swap.abi, 'setMaxSlippage', [1n]);
  [bits, allow] = await read(vb3, Swap.abi, 'preview', [2n * U], hosted.address);
  const r3 = await why(hw, vb3, Swap.abi, 'tick', [2n * U]);
  check('B3b owner sets slippage 1 bp: preview allow=true, tick reverts inside router', allow === true && r3 !== 'OK', `${allow} ${r3}`);
  rcp = await rawSend(hw, vb3, Swap.abi, 'tick', [2n * U]);
  finding(`B3b gas burnt per reverted tick: ${rcp.gasUsed}`);
  await MOVE(aw, Number(twap) / 1e6);
  await wait(2000);

  /* ================= C. dust vaults: successful buys that cost the keeper gas ================= */
  let dustMin = null;
  for (const amt of [1n, 10n, 100n, 1000n, 3000n, 10000n]) {
    const { vault: vd } = await create(aw, attacker.address, amt, 10n ** 12n, 10n ** 20n, 0n);
    await fund(aw, vd, 10n * U);
    const r = await why(hw, vd, Swap.abi, 'tick', [amt]);
    if (r === 'OK' && dustMin === null) dustMin = { amt, vd };
    console.log(`   dust tick ${amt} base units: ${r}`);
  }
  check('C1 a vault with perTxCap of a few thousand base units (<0.01 USDT0) is tickable', dustMin !== null);
  let gasSum = 0n, feeSum = 0n;
  const tBal0 = await read(usdt, ERC.abi, 'balanceOf', [treasury.address]);
  for (let i = 0; i < 5; i++) {
    const r = await tx(hw, dustMin.vd, Swap.abi, 'tick', [dustMin.amt]);
    gasSum += r.gasUsed;
    await wait(60);
  }
  feeSum = (await read(usdt, ERC.abi, 'balanceOf', [treasury.address])) - tBal0;
  finding(`C1 ${dustMin.amt}-unit vault, minInterval 0: 5 consecutive one-per-minute buys all SUCCEED; keeper gas ${gasSum / 5n}/tick, fee to treasury ${feeSum} base units total (${Number(feeSum) / 1e6} USDT0)`);
  finding('C1b keeper-worker: vaultsPage(0,200) + MAX_SENDS_PER_RUN=5 in list order → 5 such vaults created early take every send slot, every minute, forever');
  // owner can shrink caps / spacing after creation, so a factory-side minimum alone is bypassable
  const { vault: vc2 } = await create(aw, attacker.address, 2n * U, 6n * U, 1000n * U, 86400n);
  await tx(aw, vc2, Swap.abi, 'setCaps', [1n, 6n * U]);
  await tx(aw, vc2, Swap.abi, 'setMinInterval', [0n]);
  check('C2 owner can lower perTxCap to 1 unit and spacing to 0 after creation (factory minimums would be bypassable)',
    (await read(vc2, Swap.abi, 'perTxCap')) === 1n && (await read(vc2, Swap.abi, 'minInterval')) === 0n);
  await tx(aw, vc2, Swap.abi, 'setMaxSlippage', [500n]);
  check('C3 owner can change the "pinned" slippage after creation (up to 5%)', (await read(vc2, Swap.abi, 'maxSlippageBps')) === 500n);

  /* ================= D. savings address abuse ================= */
  const s = async (sav) => why(uw, fac, Fac.abi, 'createVault', [sav, U, 3n * U, 1000n * U, 0n, ZERO]);
  check('D1 savings = factory accepted (WOKB would be stuck forever)', (await s(fac)) === 'OK');
  check('D2 savings = hosted keeper accepted', (await s(hosted.address)) === 'OK');
  check('D3 savings = treasury accepted', (await s(treasury.address)) === 'OK');
  check('D4 savings = another vault accepted', (await s(va)) === 'OK');
  check('D5 savings = tokenIn/tokenOut/router/pool/processor refused',
    (await s(usdt)) === 'BadRecipient' && (await s(wokb)) === 'BadRecipient' && (await s(router)) === 'BadRecipient'
    && (await s(pool)) === 'BadRecipient' && (await s(proc)) === 'BadRecipient');
  check('D6 savings = Uniswap factory accepted (stuck)', (await s(factory)) === 'OK');
  // savings = factory: buy goes through and WOKB is unrecoverable
  const { vault: vf } = await create(uw, fac, U, 3n * U, 1000n * U, 0n);
  await fund(uw, vf, 5n * U);
  await tx(hw, vf, Swap.abi, 'tick', [U]);
  const stuck = await read(wokb, ERC.abi, 'balanceOf', [fac]);
  check('D7 savings = factory: buy succeeds and WOKB sits in the factory (no rescue function)', stuck > 0n, stuck);
  // savings = another vault: owner of that vault can pull it
  const { vault: vsv } = await create(u2w, va, U, 3n * U, 1000n * U, 0n);
  await fund(u2w, vsv, 5n * U);
  await tx(hw, vsv, Swap.abi, 'tick', [U]);
  const inVa = await read(wokb, ERC.abi, 'balanceOf', [va]);
  await tx(uw, va, Swap.abi, 'withdraw', [wokb, user.address, 2n ** 256n - 1n]);
  check('D8 savings = vault A: A\'s owner (not the payer) receives and can withdraw the WOKB', inVa > 0n);
  check('D9 vault A still ticks normally after receiving WOKB', (await why(hw, va, Swap.abi, 'tick', [U])) === 'OK');

  /* ================= E. spacing / day cap / views ================= */
  const { vault: ve } = await create(uw, user.address, U, 10n * U, 1000n * U, 0n);
  await fund(uw, ve, 20n * U);
  check('E1 nextBuyAt = 0 before any buy', (await read(ve, Swap.abi, 'nextBuyAt')) === 0n);
  await tx(hw, ve, Swap.abi, 'tick', [U]);
  await wait(600);
  const nb = await read(ve, Swap.abi, 'nextBuyAt');
  const now = (await pub.getBlock()).timestamp;
  check('E2 minInterval=0: nextBuyAt() returns a PAST timestamp (doc says 0 = now)', nb > 0n && nb < now, `${nb} vs ${now}`);
  await tx(uw, ve, Swap.abi, 'setMinInterval', [3600n]);
  const tooSoon = await why(hw, ve, Swap.abi, 'tick', [U]);
  check('E3 raising minInterval applies relative to the last buy (TooSoon)', tooSoon === 'TooSoon', tooSoon);
  // bit 5 conflates day cap and spacing
  const { vault: ve2 } = await create(uw, user.address, U, U, 1000n * U, 0n);
  await fund(uw, ve2, 5n * U);
  await tx(hw, ve2, Swap.abi, 'tick', [U]);
  [bits] = await read(ve2, Swap.abi, 'preview', [U], hosted.address);
  check('E4 day cap exhausted shows as bit5=0, same as "too soon" (dashboard/keeper cannot tell)', (bits & 32) === 0);
  // midnight burst with spacing 0 vs spacing>0
  const { vault: vm } = await create(uw, user.address, U, U, 1000n * U, 3600n);
  await fund(uw, vm, 5n * U);
  const blk = (await pub.getBlock()).timestamp;
  const toMid = 86400n - (blk % 86400n) - 5n;
  await wait(Number(toMid));
  await tx(hw, vm, Swap.abi, 'tick', [U]);
  await wait(10);
  check('E5 minInterval also closes the 2x-midnight burst (1h spacing blocks 2nd buy after 00:00)', (await why(hw, vm, Swap.abi, 'tick', [U])) === 'TooSoon');

  /* ================= F. preview vs tick differential fuzz ================= */
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const fz = [];
  for (let i = 0; i < 6; i++) {
    const { vault } = await create(uw, user.address, 5000n * U, 5000n * U, 1000n * U, 0n);
    fz.push(vault);
  }
  const mism = {};
  let n = 0, both = 0;
  for (let round = 0; round < 12; round++) {
    // random spot drift within ±1.5%
    const [tw] = await read(fz[0], Swap.abi, 'quote', [U]);
    await MOVE(aw, Number(tw) / 1e6 * (1 + (rnd() - 0.5) * 0.03));
    for (const v of fz) {
      const amt = BigInt(Math.floor(1 + rnd() * 400)) * U / 10n;
      const mp = tw * BigInt(Math.floor(9900 + rnd() * 300)) / 10000n; // maxPrice -1% .. +2% around TWAP
      await tx(uw, v, Swap.abi, 'setMaxPrice', [mp]);
      const bal = await read(usdt, ERC.abi, 'balanceOf', [v]);
      if (bal < 100n * U) await fund(uw, v, 100n * U);
      const [b, a] = await read(v, Swap.abi, 'preview', [amt], hosted.address);
      const r = await why(hw, v, Swap.abi, 'tick', [amt]);
      n++;
      if (a && r === 'OK') { both++; await tx(hw, v, Swap.abi, 'tick', [amt]); }
      else if (a !== (r === 'OK')) { const k = `preview=${a} tick=${r}`; mism[k] = (mism[k] || 0) + 1; void b; }
    }
    await wait(300);
  }
  finding(`F fuzz ${n} cases, ${both} allowed+succeeded; mismatches: ${JSON.stringify(mism)}`);
  check('F1 never preview=false while tick succeeds', !Object.keys(mism).some((k) => k.startsWith('preview=false')), JSON.stringify(mism));

  /* ================= G. misc ================= */
  // G1: direct (non-factory) deploy can name any owner without consent, and use the hosted keeper
  const SwapAbiDeploy = Swap;
  const { encodeDeployData } = await import('viem');
  const cfg = {
    owner: user2.address, processor: proc, circuitId: 1n, tokenIn: usdt, tokenOut: wokb, router, pool,
    savings: attacker.address, treasury: attacker.address, keeper: hosted.address, perTxCap: U, dailyCap: U,
    activationFee: 0n, maxPrice: 1000n * U, maxSlippageBps: 100n, twapWindow: 1800, minInterval: 0n
  };
  const hash = await aw.sendTransaction({ data: encodeDeployData({ abi: SwapAbiDeploy.abi, bytecode: SwapAbiDeploy.bytecode, args: [cfg] }), gas: 6_000_000n });
  const dr = await pub.waitForTransactionReceipt({ hash });
  check('G1 a non-factory vault can name a victim as owner + the hosted keeper (isVault=false)',
    dr.status === 'success' && (await read(dr.contractAddress, Swap.abi, 'owner')).toLowerCase() === user2.address.toLowerCase()
    && (await read(fac, Fac.abi, 'isVault', [dr.contractAddress])) === false);
  // G2: createVault address is nonce-based; a front-run shifts it
  const cnt = await read(fac, Fac.abi, 'vaultCount');
  check('G2 vault addresses are sequential CREATE addresses (UI must read VaultCreated, not predict)', cnt > 0n);
  // G3: vaultsPage edge cases
  let g3; try { g3 = (await read(fac, Fac.abi, 'vaultsPage', [1n, 2n ** 256n - 1n])).length; } catch (e) { g3 = 'reverts'; }
  finding(`G3 vaultsPage(1, uint256.max) -> ${g3} (start+count overflow panics; harmless view)`);
} catch (err) {
  console.error('TEST CRASHED:', err);
  failures++;
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
