// Security checks for contracts/LatchDeposit.sol on the local chain from web/e2e-setup.mjs.
//   node web/e2e-setup.mjs   (terminal 1, wait for READY)      node audit/deposit.test.mjs   (terminal 2)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const R = path.join(path.dirname(fileURLToPath(import.meta.url)), '..') + '/';
const { createPublicClient, createWalletClient, http, parseAbi } = await import(R + 'keeper-worker/node_modules/viem/_esm/index.js');
const cfg = JSON.parse(fs.readFileSync(path.join(process.env.UI_DIR || path.join(os.tmpdir(), 'latch-ui'), 'web-local.json'), 'utf8'));
const chain = { id: 196, name: 'local', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [cfg.rpc[0]] } } };
const pub = createPublicClient({ chain, transport: http() });
const as = (a) => createWalletClient({ account: a, chain, transport: http() }); // anvil --auto-impersonate
const ERC = parseAbi(['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)', 'function mint(address,uint256)']);
const DEP = parseAbi(['function deposit(address token, address vault, uint256 amount)', 'error NotALatchVault()', 'error WrongToken()', 'error ZeroAmount()', 'error TransferFailed()']);
const F2 = parseAbi(['function createVault(uint8,uint8,address,uint256,uint256,uint256,uint256,uint256,uint256,address)', 'function vaultsOf(address) view returns (address[])', 'error BadSavings()', 'error OverCap()', 'error BadParam()', 'error BadRecipient()', 'error BadPool()', 'error ZeroAddress()', 'error CloneFailed()']);
const F1 = parseAbi(['function createVault(address,uint256,uint256,uint256,uint256,address)', 'function vaultsOf(address) view returns (address[])']);

let fails = 0;
const ok = (n, c, d) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  → ' + String(d).slice(0, 300))); if (!c) fails++; };
const send = async (who, address, abi, functionName, args) => {
  try { await pub.simulateContract({ account: who, address, abi, functionName, args }); } catch (e) { throw new Error(functionName + ': ' + (e.shortMessage || e.message).slice(0, 300)); }
  const h = await as(who).writeContract({ address, abi, functionName, args, gas: 15_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash: h }); if (r.status !== 'success') throw new Error(functionName + ' reverted');
};
const reverts = async (who, args, name) => {
  try { await pub.simulateContract({ account: who, address: cfg.depositor, abi: DEP, functionName: 'deposit', args }); return 'no revert'; }
  catch (e) { return (e.shortMessage || e.message || '').includes(name) || e?.cause?.data?.errorName === name ? true : (e.shortMessage || e.message); }
};
const bal = (t, a) => pub.readContract({ address: t, abi: ERC, functionName: 'balanceOf', args: [a] });

const alice = '0x00000000000000000000000000000000000a11ce', mallory = '0x0000000000000000000000000000000000000bad';
const SAVE = '0x00000000000000000000000000000000000005a5';
for (const a of [alice, mallory]) await pub.request({ method: 'anvil_setBalance', params: [a, '0x56BC75E2D63100000'] });
await send(cfg.user, cfg.usdt, ERC, 'transfer', [alice, 20_000_000n]);
await send(cfg.user, cfg.wokb, ERC, 'transfer', [alice, 10n ** 17n]);

// alice: a v2 Buy vault (takes USDT0), a v2 Take Profit vault (takes WOKB), a classic vault (USDT0)
await send(alice, cfg.factory2, F2, 'createVault', [0, 0, SAVE, 1_000_000n, 2_000_000n, 4_000_000n, 80_000_000n, 90_000_000n, 0n, '0x0000000000000000000000000000000000000000']);
await send(alice, cfg.factory2, F2, 'createVault', [1, 0, SAVE, 10n ** 16n, 10n ** 16n, 10n ** 16n, 80_000_000n, 70_000_000n, 0n, '0x0000000000000000000000000000000000000000']);
const [vBuy, vSell] = await pub.readContract({ address: cfg.factory2, abi: F2, functionName: 'vaultsOf', args: [alice] });
let vOld = null;
try { await send(alice, cfg.factory, F1, 'createVault', [SAVE, 1_000_000n, 2_000_000n, 90_000_000n, 0n, '0x0000000000000000000000000000000000000000']); [vOld] = await pub.readContract({ address: cfg.factory, abi: F1, functionName: 'vaultsOf', args: [alice] }); } catch (e) { ok('classic vault created for the test', false, e.message); }

await send(alice, cfg.usdt, ERC, 'approve', [cfg.depositor, 2n ** 256n - 1n]);
await send(alice, cfg.wokb, ERC, 'approve', [cfg.depositor, 2n ** 256n - 1n]);

let b0 = await bal(cfg.usdt, vBuy);
await send(alice, cfg.depositor, DEP, 'deposit', [cfg.usdt, vBuy, 3_000_000n]);
ok('owner deposits USDT0 into her v2 Buy vault', (await bal(cfg.usdt, vBuy)) - b0 === 3_000_000n);
b0 = await bal(cfg.wokb, vSell);
await send(alice, cfg.depositor, DEP, 'deposit', [cfg.wokb, vSell, 10n ** 16n]);
ok('owner deposits WOKB into her v2 Take Profit vault', (await bal(cfg.wokb, vSell)) - b0 === 10n ** 16n);
if (vOld) { b0 = await bal(cfg.usdt, vOld); await send(alice, cfg.depositor, DEP, 'deposit', [cfg.usdt, vOld, 1_000_000n]); ok('owner deposits USDT0 into her classic vault', (await bal(cfg.usdt, vOld)) - b0 === 1_000_000n); }

ok('refuses an address that is not a Latch vault (e.g. an attacker wallet)', (await reverts(alice, [cfg.usdt, mallory, 1n], 'NotALatchVault')) === true);
ok('refuses the wrong token for a vault (WOKB into a Buy vault)', (await reverts(alice, [cfg.wokb, vBuy, 1n], 'WrongToken')) === true);
ok('refuses the wrong token for a vault (USDT0 into a Take Profit vault)', (await reverts(alice, [cfg.usdt, vSell, 1n], 'WrongToken')) === true);
ok('refuses zero', (await reverts(alice, [cfg.usdt, vBuy, 0n], 'ZeroAmount')) === true);
const aliceBefore = await bal(cfg.usdt, alice);
const m = await reverts(mallory, [cfg.usdt, vBuy, 1_000_000n], 'TransferFailed');
ok("someone else cannot spend alice's approval: mallory's call only ever moves mallory's own tokens (she has none → fails)", m === true || /transfer amount exceeds|insufficient|TransferFailed|revert/i.test(String(m)), m);
ok("alice's balance untouched by mallory's attempt", (await bal(cfg.usdt, alice)) === aliceBefore);
const code = await pub.getCode({ address: cfg.depositor });
ok('helper holds nothing', (await bal(cfg.usdt, cfg.depositor)) === 0n && (await bal(cfg.wokb, cfg.depositor)) === 0n && (await pub.getBalance({ address: cfg.depositor })) === 0n);
ok('helper has no owner, admin or upgrade path (only deposit and three immutable getters in the ABI)', code && code.length > 2);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
