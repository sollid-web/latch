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
say('factory code size: ' + ((code.length - 2) / 2) + ' bytes' + (code.length < 400 ? ' (proxy: ' + code + ')' : ''));
const sel = toFunctionSelector(CREATE);
say('createCPU selector ' + sel + (code.toLowerCase().includes(sel.slice(2)) ? ' found in code' : ' NOT found in code (proxy or renamed)'));

// Walk back through factory logs to find recent createCPU transactions.
let found = [];
let to = head;
const STEP = 5000n;
for (let i = 0; i < 120 && found.length < 3 && to > 0n; i++){
  const fromBlock = to > STEP ? to - STEP : 0n;
  let logs = [];
  try { logs = await pub.getLogs({ address: FACTORY, fromBlock, toBlock: to }); }
  catch (e) { say('getLogs ' + fromBlock + '-' + to + ' failed: ' + (e.shortMessage || e.message).split('\n')[0]); break; }
  const hashes = [...new Set(logs.map((l) => l.transactionHash))].reverse();
  for (const h of hashes){
    if (found.length >= 3) break;
    const tx = await pub.getTransaction({ hash: h });
    if (tx.to?.toLowerCase() !== FACTORY) continue;
    const rc = await pub.getTransactionReceipt({ hash: h });
    if (rc.status !== 'success') continue;
    found.push({ tx, rc });
  }
  to = fromBlock - 1n;
}
if (!found.length) say('No recent factory transactions found in the last ' + (head - to) + ' blocks.');

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
