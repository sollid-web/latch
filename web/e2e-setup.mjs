import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const R = '/home/claude/latch/';
const require = createRequire(R + 'keeper-worker/x.js');
const solc = require('solc');
const { createPublicClient, createWalletClient, http } = await import(R + 'keeper-worker/node_modules/viem/_esm/index.js');
const { privateKeyToAccount } = await import(R + 'keeper-worker/node_modules/viem/_esm/accounts/index.js');
const rd = (f) => fs.readFileSync(R + f, 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({ language: 'Solidity', sources: {
  'LatchSwap.sol': { content: rd('contracts/LatchSwap.sol') }, 'UniMath.sol': { content: rd('contracts/UniMath.sol') },
  'LatchFactory.sol': { content: rd('contracts/LatchFactory.sol') }, 'Helpers.sol': { content: rd('audit/swap/Helpers.sol') } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'cancun', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } }),
  { import: (p) => ({ contents: rd('contracts/' + p.split('/').pop()) }) }));
const art = (f, c) => ({ abi: out.contracts[f][c].abi, bytecode: '0x' + out.contracts[f][c].evm.bytecode.object });
const Fac = art('LatchFactory.sol', 'LatchFactory'), ERC = art('Helpers.sol', 'TestERC20'), Proc = art('Helpers.sol', 'NetlistProcessor'), Driver = art('Helpers.sol', 'PoolDriver');
const U = (p) => require(R + 'keeper-worker/node_modules/@uniswap/' + p);
const Factory = U('v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json'), Pool = U('v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json'), Router = U('swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json');
const RPC = 'http://127.0.0.1:8651';
spawn('/tmp/fdry/anvil', ['--port', '8651', '--chain-id', '196', '--silent', '--auto-impersonate', '--code-size-limit', '100000'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const admin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const bot = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const user = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const chain = { id: 196, name: 'a', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } };
const pub = createPublicClient({ chain, transport: http(RPC) }), w = createWalletClient({ account: admin, chain, transport: http(RPC) });
const dep = async (a, args = []) => (await pub.waitForTransactionReceipt({ hash: await w.deployContract({ abi: a.abi, bytecode: a.bytecode, args }) })).contractAddress;
const tx = async (address, abi, functionName, args = []) => { const r = await pub.waitForTransactionReceipt({ hash: await w.writeContract({ address, abi, functionName, args, gas: 15_000_000n }) }); if (r.status !== 'success') throw new Error(functionName); };
const usdt = await dep(ERC, ['USDT0', 6]), wokb = await dep(ERC, ['WOKB', 18]);
const uf = await dep(Factory), router = await dep(Router, [admin.address, uf, admin.address, wokb]), driver = await dep(Driver);
await tx(uf, Factory.abi, 'createPool', [usdt, wokb, 500]); const pool = await pub.readContract({ address: uf, abi: Factory.abi, functionName: 'getPool', args: [usdt, wokb, 500] });
const usdtIs0 = (await pub.readContract({ address: pool, abi: Pool.abi, functionName: 'token0' })).toLowerCase() === usdt.toLowerCase();
await tx(pool, Pool.abi, 'initialize', [BigInt(Math.floor(Math.sqrt(usdtIs0 ? 1e12 / 78.5 : 78.5 / 1e12) * 2 ** 48)) * 2n ** 48n]);
await tx(pool, Pool.abi, 'increaseObservationCardinalityNext', [200]);
for (const t of [usdt, wokb]) { await tx(t, ERC.abi, 'mint', [admin.address, 10n ** 30n]); await tx(t, ERC.abi, 'approve', [driver, 2n ** 256n - 1n]); }
await tx(driver, Driver.abi, 'addLiquidity', [pool, -887270, 887270, 10n ** 15n]);
await tx(usdt, ERC.abi, 'mint', [user, 100n * 10n ** 6n]);
await pub.request({ method: 'anvil_setBalance', params: [user, '0x56BC75E2D63100000'] });
const proc = await dep(Proc); const G = [[2,2],[3,9],[10,10],[11,4],[12,12],[13,5],[14,14],[15,6],[16,16],[17,7],[18,18],[19,8],[20,20]];
await tx(proc, Proc.abi, 'tape', [1n, '0x' + G.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join(''), 7, 1]);
const fac = await dep(Fac, [proc, 1n, usdt, wokb, router, pool, admin.address, bot.address, 1800, 100n, 1_000_000n]);
await pub.request({ method: 'evm_increaseTime', params: [2100] }); await pub.request({ method: 'evm_mine', params: [] });
fs.writeFileSync('/tmp/ui/web-local.json', JSON.stringify({ chainId: 196, rpc: [RPC], explorer: 'https://www.oklink.com/xlayer', factory: fac, usdt, wokb, pool, processor: proc, circuitId: 1, router, uniFactory: uf, repo: 'https://github.com/sollid-web/latch', user }));
console.log('READY', fac);
await new Promise(() => {});
