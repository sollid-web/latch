// LatchSwap test suite against a REAL Uniswap V3 deployment (official factory, pool and
// SwapRouter02 bytecode from npm) on a throwaway anvil chain. No real money, no internet.
//   needs: anvil on PATH (or ANVIL=/path/to/anvil);  run: npm i && npm test
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, decodeErrorResult, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const require = createRequire(import.meta.url);
const solc = require('solc');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const uni = (p) => require(path.join(here, 'node_modules/@uniswap', p));

/* ------------------------------------------------------------ compile */
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
console.log('sizes (bytes, runtime limit 24576): LatchSwap', (out.contracts['LatchSwap.sol'].LatchSwap.evm.bytecode.object.length / 2) | 0,
  '· LatchFactory', (out.contracts['LatchFactory.sol'].LatchFactory.evm.bytecode.object.length / 2) | 0);
const ERC = art('Helpers.sol', 'TestERC20');
const Proc = art('Helpers.sol', 'NetlistProcessor');
const Driver = art('Helpers.sol', 'PoolDriver');
const Factory = uni('v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');
const Pool = uni('v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json');
const Router = uni('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');

/* ------------------------------------------------------------ chain */
const PORT = 8621, RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--chain-id', '196', '--silent', '--code-size-limit', '100000']);
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
  const hash = await ow.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
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

// Simulate a call and return the custom error name (or 'OK' / raw message).
const ALL_ABIS = [...Swap.abi, ...Router.abi];
async function why(w, address, abi, functionName, args = []) {
  try {
    await pub.simulateContract({ account: w.account, address, abi, functionName, args });
    return 'OK';
  } catch (e) {
    const data = e?.cause?.data?.errorName ? null : (e?.cause?.raw || e?.cause?.cause?.data || e?.data);
    if (e?.cause?.data?.errorName) return e.cause.data.errorName;
    if (typeof data === 'string' && data.startsWith('0x')) {
      try { return decodeErrorResult({ abi: ALL_ABIS, data }).errorName; } catch { /* fallthrough */ }
    }
    return (e.shortMessage || e.message).split('\n')[0];
  }
}

let failures = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + String(detail)));
  if (!cond) failures++;
};

try {
  /* ---------------------------------------------------- uniswap setup */
  const usdt = await deploy(ERC, ['USDT0', 6]);
  const wokb = await deploy(ERC, ['WOKB', 18]);
  const factory = await deploy({ abi: Factory.abi, bytecode: Factory.bytecode });
  const router = await deploy({ abi: Router.abi, bytecode: Router.bytecode }, [owner.address, factory, owner.address, wokb]);
  const driver = await deploy(Driver);
  const FEE = 3000;
  await tx(ow, factory, Factory.abi, 'createPool', [usdt, wokb, FEE]);
  const pool = await read(factory, Factory.abi, 'getPool', [usdt, wokb, FEE]);
  const t0 = await read(pool, Pool.abi, 'token0');
  const usdtIs0 = t0.toLowerCase() === usdt.toLowerCase();
  // price P = USDT per OKB  →  sqrtPriceX96 of token1/token0 in raw units
  const sqrtX96 = (P) => {
    const raw = usdtIs0 ? 1e12 / P : P / 1e12;
    return BigInt(Math.floor(Math.sqrt(raw) * 2 ** 48)) * (2n ** 48n);
  };
  await tx(ow, pool, Pool.abi, 'initialize', [sqrtX96(77)]);
  await tx(ow, pool, Pool.abi, 'increaseObservationCardinalityNext', [100]);
  const U = 10n ** 6n, O = 10n ** 18n;
  for (const t of [usdt, wokb]) {
    await tx(ow, t, ERC.abi, 'mint', [owner.address, 10n ** 30n]);
    await tx(ow, t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]);
    await tx(ow, t, ERC.abi, 'mint', [attacker.address, 10n ** 30n]);
    await tx(aw, t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]);
  }
  await tx(ow, driver, Driver.abi, 'addLiquidity', [pool, -887220, 887220, 10n ** 15n]);
  await wait(2000);

  /* ---------------------------------------------------- latch setup */
  const proc = await deploy(Proc);
  const GATES = [[2,2],[3,9],[10,10],[11,4],[12,12],[13,5],[14,14],[15,6],[16,16],[17,7],[18,18],[19,8],[20,20]];
  const net = '0x' + GATES.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join('');
  await tx(ow, proc, Proc.abi, 'tape', [1n, net, 7, 1]);
  await tx(ow, proc, Proc.abi, 'tape', [3n, '0x00000001000001', 7, 1]); // one gate NAND(1,1)=0 → always deny
  const cfg = (over = {}) => ({
    owner: '0x0000000000000000000000000000000000000000', minInterval: 0n, minAmount: 100_000n, guardian: '0x0000000000000000000000000000000000000000',
    processor: proc, circuitId: 1n, tokenIn: usdt, tokenOut: wokb, router, pool,
    savings: savings.address, treasury: treasury.address, keeper: keeper.address,
    perTxCap: 2n * U, dailyCap: 6n * U, activationFee: 1n * U, maxPrice: 48n * U, maxSlippageBps: 100n, twapWindow: 1800,
    ...over
  });
  const deployVault = (over) => deploy(Swap, [cfg(over)]);
  const { keccak256, toBytes } = await import('viem');
  const SEL = Object.fromEntries(Swap.abi.filter((x) => x.type === 'error').map((x) =>
    [keccak256(toBytes(x.name + '(' + x.inputs.map((i) => i.type).join(',') + ')')).slice(0, 10), x.name]));
  const deployErr = async (over) => {
    try {
      await pub.call({ account: owner.address, data: encodeDeploy(cfg(over)) });
      return 'OK';
    } catch (e) {
      const m = String(e.shortMessage || e.message).match(/0x[0-9a-f]{8}/i);
      return m ? (SEL[m[0].toLowerCase()] || m[0]) : String(e.shortMessage || e.message).split('\n')[0];
    }
  };
  const { encodeDeployData } = await import('viem');
  const encodeDeploy = (c) => encodeDeployData({ abi: Swap.abi, bytecode: Swap.bytecode, args: [c] });

  // ---- constructor validation
  check('deploy: savings = pool is refused', (await deployErr({ savings: pool })) === 'BadRecipient', await deployErr({ savings: pool }));
  check('deploy: savings = router is refused', (await deployErr({ savings: router })) === 'BadRecipient');
  await tx(ow, factory, Factory.abi, 'createPool', [usdt, wokb, 500]);
  const pool500 = await read(factory, Factory.abi, 'getPool', [usdt, wokb, 500]);
  const fakePool = await deploy(ERC, ['FAKE', 18]);
  check('deploy: a non-pool contract is refused', (await deployErr({ pool: fakePool })) !== 'OK');
  check('deploy: a pool for other tokens is refused', (await deployErr({ tokenOut: fakePool })) === 'BadPool', await deployErr({ tokenOut: fakePool }));
  check('deploy: slippage above 5% is refused', (await deployErr({ maxSlippageBps: 501n })) === 'BadParam');
  check('deploy: TWAP window under 30 min is refused', (await deployErr({ twapWindow: 600 })) === 'BadParam');
  check('deploy: savings = address(1) is refused', (await deployErr({ savings: '0x0000000000000000000000000000000000000001' })) === 'BadRecipient');
  check('deploy: per-tx above daily is refused', (await deployErr({ perTxCap: 7n * U })) === 'OverCap');
  void pool500;

  const vault = await deployVault();
  await tx(ow, usdt, ERC.abi, 'transfer', [vault, 10n * U]);
  check('tick before arming: NotArmed', (await why(kw, vault, Swap.abi, 'tick', [2n * U])) === 'NotArmed');
  await tx(ow, vault, Swap.abi, 'arm');
  check('arm paid 1 USDT0 to treasury', (await read(usdt, ERC.abi, 'balanceOf', [treasury.address])) === 1n * U);

  const [twap0] = await read(vault, Swap.abi, 'quote', [2n * U]);
  check('TWAP price reads ~77 USDT0 per OKB', twap0 > 76n * U && twap0 < 78n * U, twap0);

  // ---- price above the owner's max: blocked on chain, even for the real keeper
  check('price 77 > max 48: tick reverts PriceTooHigh', (await why(kw, vault, Swap.abi, 'tick', [2n * U])) === 'PriceTooHigh');
  let [bits, allow] = await read(vault, Swap.abi, 'preview', [2n * U], keeper.address);
  check('preview at high price: bit 3 off, not allowed', (bits & 8) === 0 && allow === false, bits);

  // ---- owner raises max price (demo mode) → real swap
  check('keeper cannot change max price', (await why(kw, vault, Swap.abi, 'setMaxPrice', [1000n * U])) === 'NotOwner');
  await tx(ow, vault, Swap.abi, 'setMaxPrice', [90n * U]);
  [bits, allow] = await read(vault, Swap.abi, 'preview', [2n * U], keeper.address);
  check('preview after max 90: byte 0x7e allowed', bits === 0x7e && allow === true, bits);
  const [, expOut, minOut] = await read(vault, Swap.abi, 'quote', [2n * U]);
  const vBefore = await read(usdt, ERC.abi, 'balanceOf', [vault]);
  await tx(kw, vault, Swap.abi, 'tick', [2n * U]);
  const gotOkb = await read(wokb, ERC.abi, 'balanceOf', [savings.address]);
  check('swap: savings received WOKB >= minOut', gotOkb >= minOut && gotOkb > 0n, `${gotOkb} vs ${minOut}`);
  check('swap: ~2/77 OKB within 1%', gotOkb * 10000n >= expOut * 9900n, `${gotOkb} vs ${expOut}`);
  check('swap: vault paid exactly 2 + 0.02 fee', vBefore - (await read(usdt, ERC.abi, 'balanceOf', [vault])) === 2_020_000n);
  check('swap: treasury got the 0.02 fee', (await read(usdt, ERC.abi, 'balanceOf', [treasury.address])) === 1_020_000n);
  check('swap: router allowance reset to 0', (await read(usdt, ERC.abi, 'allowance', [vault, router])) === 0n);
  check('swap: totalBought and buys counters', (await read(vault, Swap.abi, 'totalBought')) === gotOkb && (await read(vault, Swap.abi, 'buys')) === 1n);
  check('swap: vault holds no WOKB (output went to savings)', (await read(wokb, ERC.abi, 'balanceOf', [vault])) === 0n);

  // ---- attacker / limits
  check('stranger calling tick: NotKeeper', (await why(aw, vault, Swap.abi, 'tick', [2n * U])) === 'NotKeeper');
  check('rogue 500 USDT0: OverCap', (await why(kw, vault, Swap.abi, 'tick', [500n * U])) === 'OverCap');
  check('dust buy below the minimum: OverCap', (await why(kw, vault, Swap.abi, 'tick', [99_999n])) === 'OverCap');
  check('caps cannot go below the minimum buy', (await why(ow, vault, Swap.abi, 'setCaps', [99_999n, 6n * U])) === 'OverCap');
  await tx(kw, vault, Swap.abi, 'tick', [2n * U]);
  await tx(kw, vault, Swap.abi, 'tick', [2n * U]);
  check('4th buy same day: OverCap (daily 6)', (await why(kw, vault, Swap.abi, 'tick', [1n * U])) === 'OverCap');
  await tx(ow, vault, Swap.abi, 'setPaused', [true]);
  await wait(86400);
  check('paused vault: Paused', (await why(kw, vault, Swap.abi, 'tick', [1n * U])) === 'Paused');
  await tx(ow, vault, Swap.abi, 'setPaused', [false]);
  check('next day, unpaused: allowed again', (await why(kw, vault, Swap.abi, 'tick', [1n * U])) === 'OK');

  // ---- sandwich: attacker pumps OKB spot right before the keeper's buy
  const MIN_SQRT = 4295128740n, MAX_SQRT = 1461446703485210103287273052203988822378723970341n;
  // buying WOKB with USDT pushes OKB price up
  const pumpZeroForOne = usdtIs0; // USDT is token0 → zeroForOne buys token1 (WOKB)
  await tx(aw, driver, Driver.abi, 'push', [pool, pumpZeroForOne, 3000n * U, pumpZeroForOne ? MIN_SQRT : MAX_SQRT]);
  const r1 = await why(kw, vault, Swap.abi, 'tick', [2n * U]);
  check('sandwich (spot pumped, TWAP not): buy refused', r1 !== 'OK', r1);
  // attacker dumps back; let TWAP settle
  await tx(aw, driver, Driver.abi, 'push', [pool, !pumpZeroForOne, 39n * O, !pumpZeroForOne ? MIN_SQRT : MAX_SQRT]);
  await wait(2000);

  // ---- a real dip: price falls to ~40 and stays 10 min → buys under max 48
  await tx(ow, vault, Swap.abi, 'setMaxPrice', [48n * U]);
  check('back near 77 with max 48: refused', (await why(kw, vault, Swap.abi, 'tick', [1n * U])) === 'PriceTooHigh');
  // sell OKB to push price down to ~40
  await tx(aw, driver, Driver.abi, 'push', [pool, !pumpZeroForOne, 10n ** 30n, sqrtX96(40)]);
  await wait(1900);
  const [twapDip] = await read(vault, Swap.abi, 'quote', [1n * U]);
  check('TWAP after the dip ~40', twapDip > 38n * U && twapDip < 42n * U, twapDip);
  const before2 = await read(wokb, ERC.abi, 'balanceOf', [savings.address]);
  await tx(kw, vault, Swap.abi, 'tick', [1n * U]);
  const bought = (await read(wokb, ERC.abi, 'balanceOf', [savings.address])) - before2;
  check('dip buy: ~1/40 OKB bought into savings', bought > (O / 41n) && bought < (O / 39n), bought);

  // ---- spot far from TWAP (pump just before the buy, TWAP still cheap) → PriceUnstable
  await tx(ow, vault, Swap.abi, 'setMaxPrice', [60n * U]);
  await tx(aw, driver, Driver.abi, 'push', [pool, pumpZeroForOne, 10n ** 30n, sqrtX96(44)]);
  const rU = await why(kw, vault, Swap.abi, 'tick', [1n * U]);
  check('spot 10% above TWAP: refused (PriceUnstable)', rU === 'PriceUnstable', rU);
  [bits, allow] = await read(vault, Swap.abi, 'preview', [1n * U], keeper.address);
  check('preview agrees: bit 3 off while unstable', (bits & 8) === 0 && allow === false, bits);
  await wait(2000);
  // ---- worst fill price must respect maxPrice (L-1): TWAP ~44, maxPrice 44.2 → minOut implies > 44.2
  await tx(ow, vault, Swap.abi, 'setMaxPrice', [44_200_000n]);
  const rL1 = await why(kw, vault, Swap.abi, 'tick', [1n * U]);
  check('TWAP under max but worst fill above max: refused', rL1 === 'PriceTooHigh', rL1);
  [bits, allow] = await read(vault, Swap.abi, 'preview', [1n * U], keeper.address);
  check('preview agrees with tick on worst fill (bit 3 off)', (bits & 8) === 0 && allow === false, bits);
  // ---- slippage below the pool fee still trades now (L-2): fee netted out of minOut
  await tx(ow, vault, Swap.abi, 'setMaxPrice', [60n * U]);
  await tx(ow, vault, Swap.abi, 'setMaxSlippage', [25n]);
  const rL2 = await why(kw, vault, Swap.abi, 'tick', [1n * U]);
  check('slippage 0.25% on a 0.3% pool: buy works (fee netted)', rL2 === 'OK', rL2);
  await tx(ow, vault, Swap.abi, 'setMaxSlippage', [100n]);

  // ---- spacing between buys (auto-DCA)
  const dca = await deployVault({ maxPrice: 1000n * U, minInterval: 86400n, activationFee: 0n });
  check('no switch-on fee: vault starts switched on', (await read(dca, Swap.abi, 'armed')) === true);
  await tx(ow, usdt, ERC.abi, 'transfer', [dca, 5n * U]);
  await tx(kw, dca, Swap.abi, 'tick', [1n * U]);
  check('DCA: first buy goes through', (await read(wokb, ERC.abi, 'balanceOf', [savings.address])) > 0n);
  check('DCA: second buy same day refused (TooSoon)', (await why(kw, dca, Swap.abi, 'tick', [1n * U])) === 'TooSoon');
  [bits, allow] = await read(dca, Swap.abi, 'preview', [1n * U], keeper.address);
  check('DCA: preview bit 5 off while too soon', (bits & 32) === 0 && allow === false, bits);
  check('keeper cannot shorten the spacing', (await why(kw, dca, Swap.abi, 'setMinInterval', [0n])) === 'NotOwner');
  check('spacing over 30 days refused', (await why(ow, dca, Swap.abi, 'setMinInterval', [31n * 86400n])) === 'BadParam');
  await wait(86400);
  check('DCA: a day later the next buy is allowed', (await why(kw, dca, Swap.abi, 'tick', [1n * U])) === 'OK');

  // ---- factory: anyone creates a vault they own, risky settings pinned
  const fac = await deploy(Fac, [proc, 1n, usdt, wokb, router, pool, treasury.address, keeper.address, 1800, 100n, 1_000_000n]);
  const userW = aw; // the "attacker" account doubles as an ordinary user here
  const r0 = await tx(userW, fac, Fac.abi, 'createVault', [attacker.address, 2n * U, 6n * U, 1000n * U, 0n, '0x0000000000000000000000000000000000000000']);
  const [uv] = await read(fac, Fac.abi, 'vaultsOf', [attacker.address]);
  check('factory: creator owns the vault', (await read(uv, Swap.abi, 'owner')).toLowerCase() === attacker.address.toLowerCase());
  check('factory: hosted bot is the default keeper', (await read(uv, Swap.abi, 'keeper')).toLowerCase() === keeper.address.toLowerCase());
  check('factory: vault starts switched on', (await read(uv, Swap.abi, 'armed')) === true);
  check('factory: pool, circuit, treasury pinned', (await read(uv, Swap.abi, 'pool')).toLowerCase() === pool.toLowerCase()
    && (await read(uv, Swap.abi, 'circuitId')) === 1n && (await read(uv, Swap.abi, 'treasury')).toLowerCase() === treasury.address.toLowerCase());
  check('factory: isVault + count', (await read(fac, Fac.abi, 'isVault', [uv])) === true && (await read(fac, Fac.abi, 'vaultCount')) === 1n);
  await tx(userW, usdt, ERC.abi, 'transfer', [uv, 3n * U]);
  const ub0 = await read(wokb, ERC.abi, 'balanceOf', [attacker.address]);
  await tx(kw, uv, Swap.abi, 'tick', [2n * U]);
  check('factory vault: hosted bot buys into the user wallet', (await read(wokb, ERC.abi, 'balanceOf', [attacker.address])) > ub0);
  check('factory vault: factory admin cannot withdraw user funds', (await why(ow, uv, Swap.abi, 'withdraw', [usdt, owner.address, 1n])) === 'NotOwner');
  await tx(userW, uv, Swap.abi, 'withdraw', [usdt, attacker.address, 2n ** 256n - 1n]);
  check('factory vault: user withdraws everything', (await read(usdt, ERC.abi, 'balanceOf', [uv])) === 0n);
  await tx(userW, fac, Fac.abi, 'createVault', [attacker.address, 1n * U, 3n * U, 60n * U, 86400n, savings.address]);
  const [, uv2] = await read(fac, Fac.abi, 'vaultsOf', [attacker.address]);
  check('factory: user can pick their own bot / AI agent', (await read(uv2, Swap.abi, 'keeper')).toLowerCase() === savings.address.toLowerCase());
  const page = await read(fac, Fac.abi, 'vaultsPage', [0n, 10n]);
  check('factory: vaultsPage lists both', page.length === 2);
  check('factory: only admin sets hosted bot', (await why(aw, fac, Fac.abi, 'setHostedKeeper', [attacker.address])) === 'NotAdmin');
  const badSav = await why(userW, fac, Fac.abi, 'createVault', [pool, 1n * U, 3n * U, 60n * U, 0n, '0x0000000000000000000000000000000000000000']);
  check('factory: savings = pool refused', badSav === 'BadRecipient', badSav);
  void r0;
  const Zr = '0x0000000000000000000000000000000000000000';
  for (const [label, sav] of [['factory', fac], ['hosted bot', keeper.address], ['treasury', treasury.address], ['another vault', uv]]) {
    const rr = await why(userW, fac, Fac.abi, 'createVault', [sav, 1n * U, 3n * U, 60n * U, 0n, Zr]);
    check('factory: savings = ' + label + ' refused', rr === 'BadSavings', rr);
  }
  check('factory: per-buy below the 1 USDT0 minimum refused', (await why(userW, fac, Fac.abi, 'createVault', [attacker.address, 500_000n, 3n * U, 60n * U, 0n, Zr])) === 'OverCap');
  // stolen hosted key: admin revokes it for every factory vault at once
  await tx(userW, usdt, ERC.abi, 'transfer', [uv, 3n * U]);
  await wait(86400);
  check('before revoke: hosted bot could buy', (await why(kw, uv, Swap.abi, 'tick', [1n * U])) === 'OK');
  check('only admin can revoke', (await why(aw, fac, Fac.abi, 'setRevoked', [keeper.address, true])) === 'NotAdmin');
  await tx(ow, fac, Fac.abi, 'setRevoked', [keeper.address, true]);
  check('after revoke: hosted bot refused in every vault', (await why(kw, uv, Swap.abi, 'tick', [1n * U])) === 'NotKeeper');
  [bits, allow] = await read(uv, Swap.abi, 'preview', [1n * U], keeper.address);
  check('after revoke: preview says no', allow === false && (bits & 2) === 0, bits);
  await tx(userW, uv, Swap.abi, 'setKeeper', [savings.address]);
  check('owner can move to a new bot after a revoke', (await why(W(savings), uv, Swap.abi, 'tick', [1n * U])) === 'OK');
  check('revoke cannot touch funds: owner still withdraws', (await why(userW, uv, Swap.abi, 'withdraw', [usdt, attacker.address, 1n])) === 'OK');

  // ---- circuit denial path
  const vaultDeny = await deployVault({ circuitId: 3n, maxPrice: 1000n * U });
  await tx(ow, usdt, ERC.abi, 'transfer', [vaultDeny, 5n * U]);
  await tx(ow, vaultDeny, Swap.abi, 'arm');
  const denyAllows = await read(vaultDeny, Swap.abi, 'circuitAllows', [0x7e]);
  const rd = await why(kw, vaultDeny, Swap.abi, 'tick', [1n * U]);
  check('circuit that denies 0x7e blocks the buy', denyAllows === false && rd === 'CircuitDenied', `${denyAllows} ${rd}`);
  check('real circuit #1: 0x7e allow, 0x7f deny', (await read(vault, Swap.abi, 'circuitAllows', [0x7e])) === true && (await read(vault, Swap.abi, 'circuitAllows', [0x7f])) === false);

  // ---- owner powers
  check('caps cannot be raised', (await why(ow, vault, Swap.abi, 'setCaps', [3n * U, 6n * U])) === 'CapRaised');
  check('slippage > 5% cannot be set', (await why(ow, vault, Swap.abi, 'setMaxSlippage', [600n])) === 'BadParam');
  check('keeper cannot withdraw', (await why(kw, vault, Swap.abi, 'withdraw', [usdt, keeper.address, 1n])) === 'NotOwner');
  await tx(ow, wokb, ERC.abi, 'transfer', [vault, O]); // stray token sent by mistake
  await tx(ow, vault, Swap.abi, 'withdraw', [wokb, owner.address, 2n ** 256n - 1n]);
  check('owner rescues a stray token', (await read(wokb, ERC.abi, 'balanceOf', [vault])) === 0n);
  await tx(ow, vault, Swap.abi, 'setPaused', [true]);
  await tx(ow, vault, Swap.abi, 'withdraw', [usdt, owner.address, 2n ** 256n - 1n]);
  check('owner withdraws everything while paused', (await read(usdt, ERC.abi, 'balanceOf', [vault])) === 0n);

  // ---- pool without enough history: buys fail closed
  const pool2tok = await deploy(ERC, ['WOKB2', 18]);
  await tx(ow, factory, Factory.abi, 'createPool', [usdt, pool2tok, FEE]);
  const young = await read(factory, Factory.abi, 'getPool', [usdt, pool2tok, FEE]);
  await tx(ow, young, Pool.abi, 'initialize', [sqrtX96(77)]);
  const vYoung = await deployVault({ tokenOut: pool2tok, pool: young, maxPrice: 1000n * U });
  await tx(ow, usdt, ERC.abi, 'transfer', [vYoung, 5n * U]);
  await tx(ow, vYoung, Swap.abi, 'arm');
  const ry = await why(kw, vYoung, Swap.abi, 'tick', [1n * U]);
  check('pool younger than the TWAP window: buy refused (fails closed)', ry !== 'OK', ry);
} catch (err) {
  console.error('TEST CRASHED:', err);
  failures++;
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
