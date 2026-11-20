// Read-only. Finds the most recent successful createCPU on X Layer and prints
// exactly what it sent (function, arguments, OKB value), then re-simulates
// createCPU from your wallet with that value. Sends nothing, needs no key
// unless OWNER_PRIVATE_KEY is in .env (only used as the "from" address).
//
//   node diagnose.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, formatEther, decodeFunctionData, defineChain, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '').split(/\r?\n/)){
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const FACTORY = '0x1f09daefa827f02cbb40967cc91b259763760761';
const chain = defineChain({ id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const CREATE = 'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address, address)';
const ABI = parseAbi([CREATE, 'function deployFee() view returns (uint256)', 'function cpuCount() view returns (uint256)']);
const from = process.env.OWNER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(process.env.OWNER_PRIVATE_KEY)
  ? privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address : null;

const out = [];
const say = (s) => { console.log(s); out.push(s); };

const head = await pub.getBlockNumber();
const fee = await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'deployFee' }).catch((e) => 'error: ' + e.shortMessage);
say('block ' + head + ' · deployFee() = ' + (typeof fee === 'bigint' ? fee + ' wei (' + formatEther(fee) + ' OKB)' : fee));
say('cpuCount() = ' + await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'cpuCount' }));
const code = await pub.getCode({ address: FACTORY });
say('factory code size: ' + ((code.length - 2) / 2) + ' bytes');
const sel = toFunctionSelector(CREATE);
// ERC-1967 proxy: logic lives at the implementation slot.
let logic = FACTORY;
const slot = await pub.getStorageAt({ address: FACTORY, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' });
if (slot && BigInt(slot) !== 0n){
  logic = '0x' + slot.slice(-40);
  const icode = await pub.getCode({ address: logic });
  say('proxy implementation ' + logic + ' (' + ((icode.length - 2) / 2) + ' bytes)');
  say('createCPU(string,string,string,uint256,uint256) selector ' + sel + (icode.toLowerCase().includes(sel.slice(2)) ? ' FOUND in implementation' : ' NOT in implementation — signature changed'));
  const pushes = [...new Set([...icode.toLowerCase().matchAll(/63([0-9a-f]{8})/g)].map((m) => '0x' + m[1]))].slice(0, 60);
  say('implementation function selectors (first 60): ' + pushes.join(' '));
}

// Try the call with a few plausible fees (simulation only).
if (from){
  const args = ['Latch Diagnose', 'LDIAG', 'diagnostic', 1000n, 10_000_000_000_000n];
  for (const v of [typeof fee === 'bigint' ? fee : 0n, 0n, 6_600_000_000_000_000n, 10_000_000_000_000_000n]){
    const r = await pub.simulateContract({ account: from, address: FACTORY, abi: ABI, functionName: 'createCPU', args, value: v })
      .then(() => 'would SUCCEED').catch((e) => { const d = e.cause && e.cause.data; return 'reverts: ' + (d && d.errorName ? d.errorName + '(' + (d.args || []).map(String).join(', ') + ')' : (e.shortMessage || e.message).split('\n')[0]); });
    say('createCPU with value ' + formatEther(v) + ' OKB → ' + r);
  }
}

// Find the newest processor's creation block by binary search on historical code.
let found = [];
const count = await pub.readContract({ address: FACTORY, abi: ABI, functionName: 'cpuCount' });
const newest = await pub.readContract({ address: FACTORY, abi: parseAbi(['function cpuAt(uint256) view returns (address)']), functionName: 'cpuAt', args: [count - 1n] });
say('newest processor #' + (count - 1n) + ' = ' + newest);
let lo = 0n, hi = head, archive = true;
try { await pub.getCode({ address: newest, blockNumber: head - 1000n }); } catch (e) { archive = false; say('RPC has no history (' + (e.shortMessage || e.message).split('\n')[0] + ')'); }
if (archive){
  while (lo < hi){
    const mid = (lo + hi) / 2n;
    const c = await pub.getCode({ address: newest, blockNumber: mid }).catch(() => undefined);
    if (c && c !== '0x') hi = mid; else lo = mid + 1n;
  }
  say('created in block ' + lo);
  const logs = await pub.getLogs({ address: FACTORY, fromBlock: lo, toBlock: lo }).catch((e) => { say('getLogs failed: ' + e.shortMessage); return []; });
  let hashes = [...new Set(logs.map((l) => l.transactionHash))];
  if (!hashes.length){
    const blk = await pub.getBlock({ blockNumber: lo, includeTransactions: true });
    hashes = blk.transactions.filter((t) => t.to && t.to.toLowerCase() === FACTORY).map((t) => t.hash);
  }
  for (const h of hashes){
    const tx = await pub.getTransaction({ hash: h });
    const rc = await pub.getTransactionReceipt({ hash: h });
    if (rc.status === 'success') found.push({ tx, rc });
  }
}
if (!found.length) say('Could not locate the creation transaction.');

for (const { tx, rc } of found){
  say('\n--- successful factory tx ' + tx.hash + ' (block ' + rc.blockNumber + ')');
  say('selector ' + tx.input.slice(0, 10) + ' · value ' + tx.value + ' wei (' + formatEther(tx.value) + ' OKB) · gas used ' + rc.gasUsed);
  try {
    const d = decodeFunctionData({ abi: ABI, data: tx.input });
    say('decoded ' + d.functionName + '(' + d.args.map((a) => typeof a === 'string' ? JSON.stringify(a.length > 60 ? a.slice(0, 60) + '…' : a) : String(a)).join(', ') + ')');
  } catch {
    say('could not decode with our createCPU ABI — raw input (first 330 chars): ' + tx.input.slice(0, 330));
  }
  if (from){
    const r = await pub.call({ account: from, to: FACTORY, data: tx.input, value: tx.value }).then(() => 'would SUCCEED').catch((e) => 'reverts: ' + (e.shortMessage || e.message).split('\n')[0]);
    say('same call from your wallet: ' + r);
  }
}
console.log('\nPaste everything above to Claude.');
