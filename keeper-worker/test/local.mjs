// Local end-to-end test of the helper bot against the REAL LatchRelay contract on a
// throwaway anvil chain (no real money, no internet). Prices are stubbed per scenario.
//   needs: anvil on PATH (or ANVIL=/path/to/anvil), npm i (installs solc + viem)
//   run:   npm test
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { runOnce, decide } from '../src/keeper.js';

const require = createRequire(import.meta.url);
const solc = require('solc');
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');

/* ---- compile LatchRelay + test token + TAP-02 processor stand-in ---- */
const testSrc = fs.readFileSync(path.join(root, 'audit/test/LatchRelay.t.sol.txt'), 'utf8');
const mocks = '// SPDX-License-Identifier: MIT\npragma solidity ^0.8.24;\n' +
  testSrc.slice(testSrc.indexOf('contract Token {'), testSrc.indexOf('/// @dev Returns false')) +
  testSrc.slice(testSrc.indexOf('contract NetlistProcessor {'), testSrc.indexOf('/// @dev Processor that always'));
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: {
    'LatchRelay.sol': { content: fs.readFileSync(path.join(root, 'contracts/LatchRelay.sol'), 'utf8') },
    'Mocks.sol': { content: mocks }
  },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } }
})));
for (const e of out.errors || []) if (e.severity === 'error') throw new Error(e.formattedMessage);
const art = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });

/* ---- chain ---- */
const PORT = 8611;
const RPC = `http://127.0.0.1:${PORT}`;
const anvil = spawn(process.env.ANVIL || 'anvil', ['--port', String(PORT), '--chain-id', '196', '--silent']);
await new Promise((r) => setTimeout(r, 1500));
const KEYS = [ // anvil's default dev keys (public, test-only)
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6'
];
const [owner, keeper, savings, stranger] = KEYS.map((k) => privateKeyToAccount(k));
const chain = { id: 196, name: 'anvil', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) });
const ow = createWalletClient({ account: owner, chain, transport: http(RPC) });
async function deploy(a, args) {
  const hash = await ow.deployContract({ abi: a.abi, bytecode: a.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
}
async function send(addr, abi, fn, args) {
  const hash = await ow.writeContract({ address: addr, abi, functionName: fn, args });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error(fn + ' reverted');
}

let failures = 0;
function check(name, cond, detail) {
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  → ' + JSON.stringify(detail, (k, v) => (typeof v === 'bigint' ? v.toString() : v))));
  if (!cond) failures++;
}

try {
  const T = art('Mocks.sol', 'Token'), P = art('Mocks.sol', 'NetlistProcessor'), R = art('LatchRelay.sol', 'LatchRelay');
  const token = await deploy(T, [6]);
  const proc = await deploy(P, []);
  // The real circuit #1 netlist (13 NAND gates, 7 inputs, 1 output), as in index.html.
  const GATES = [[2,2],[3,9],[10,10],[11,4],[12,12],[13,5],[14,14],[15,6],[16,16],[17,7],[18,18],[19,8],[20,20]];
  const net = '0x' + GATES.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join('');
  await send(proc, P.abi, 'tape', [1n, net, 7, 1]);
  const u = 10n ** 6n;
  const relay = await deploy(R, [proc, 1n, token, savings.address, owner.address, keeper.address, 2n * u, 6n * u, 1n * u]);
  await send(token, T.abi, 'mint', [relay, 10n * u]);
  await send(relay, R.abi, 'arm', []);
  await ow.sendTransaction({ to: keeper.address, value: 10n ** 18n }).then((h) => pub.waitForTransactionReceipt({ hash: h }));

  const env = { KEEPER_PRIVATE_KEY: KEYS[1], RPC_URL: RPC, RELAY_ADDRESS: relay, CHAIN_ID: '196', THRESHOLD: '48', SWEEP_USDT: '2' };
  const P3 = (a, b, c) => [{ venue: 'OKX', ok: true, price: a }, { venue: 'Binance', ok: true, price: b }, { venue: 'CoinGecko', ok: true, price: c }];
  const bal = (a) => pub.readContract({ address: token, abi: T.abi, functionName: 'balanceOf', args: [a] });

  // Pure decision rules
  check('decide: price above threshold holds', decide(P3(77, 77.1, 76.9), 48, 6).trigger === false);
  check('decide: 3/3 below threshold triggers', decide(P3(47, 47.2, 46.9), 48, 6).trigger === true);
  check('decide: one-exchange wick is ignored', decide(P3(77, 77.1, 30), 48, 6).trigger === false);
  check('decide: one answer only holds', decide([{ venue: 'OKX', ok: true, price: 40 }, { venue: 'B', ok: false }], 48, 6).trigger === false);

  let r = await runOnce(env, { send: true, prices: P3(77, 77.1, 76.9) });
  check('normal price: holds, nothing moves', r.action === 'hold' && (await bal(savings.address)) === 0n, r);

  r = await runOnce(env, { send: true, prices: P3(77, 77.1, 30) });
  check('fake crash on one exchange: holds', r.action === 'hold' && (await bal(savings.address)) === 0n, r);

  r = await runOnce(env, { send: false, prices: P3(47, 47.2, 46.9) });
  check('dry run on a real dip: would save, sends nothing', r.action === 'would-save' && (await bal(savings.address)) === 0n, r);

  r = await runOnce(env, { send: true, prices: P3(47, 47.2, 46.9) });
  check('real dip: saves 2 USDT to savings on chain', r.action === 'saved' && (await bal(savings.address)) === 2n * u, r);

  r = await runOnce(env, { send: true, prices: P3(47, 47.2, 46.9) });
  r = await runOnce(env, { send: true, prices: P3(47, 47.2, 46.9) });
  check('three dips: 6 USDT saved (daily limit)', (await bal(savings.address)) === 6n * u, { saved: await bal(savings.address) });
  r = await runOnce(env, { send: true, prices: P3(47, 47.2, 46.9) });
  check('fourth dip same day: holds at daily limit', r.action === 'hold' && (await bal(savings.address)) === 6n * u, r);

  r = await runOnce({ ...env, KEEPER_PRIVATE_KEY: KEYS[3] }, { send: true, prices: P3(47, 47.2, 46.9) });
  check('wrong key: refuses with a clear error', r.action === 'config-error', r);

  r = await runOnce({ ...env, KEEPER_PRIVATE_KEY: '' }, { send: true });
  check('missing key: config error, no crash', r.action === 'config-error', r);
} catch (err) {
  console.error('TEST CRASHED:', err);
  failures++;
} finally {
  anvil.kill();
}
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS');
process.exit(failures ? 1 : 0);
