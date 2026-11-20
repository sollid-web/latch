// Read-only. Works out how your processor's transistor contract wants NAND minted:
// prints its fees and IDs, then simulates mint with several token IDs and OKB values
// and shows the exact result for each. Sends nothing.
//
//   node mintprobe.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, formatEther, defineChain, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '').split(/\r?\n/)){
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const BEM = '0x60e62efa9405d6873c5deabd4e6cc91c25363952';
const chain = defineChain({ id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const me = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address;
const state = JSON.parse(fs.readFileSync(path.join(HERE, 'tapeout-state.json'), 'utf8'));
const proc = state.processor;

const A = parseAbi([
  'function transistors() view returns (address)',
  'function mintPrice() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function mint(uint256 id, uint256 amount) payable',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function totalSupply(uint256 id) view returns (uint256)',
  'function maxSupply() view returns (uint256)',
  'function supply() view returns (uint256)',
  'function minted() view returns (uint256)',
  'function NAND() view returns (uint256)',
  'function LATCH() view returns (uint256)',
  'function owner() view returns (address)',
  'function creator() view returns (address)',
  'function uri(uint256) view returns (string)',
  'function allowance(address,address) view returns (uint256)'
]);
const ERRS = parseAbi([
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error OwnableUnauthorizedAccount(address account)'
]);
const r = (address, functionName, args = []) => pub.readContract({ address, abi: A, functionName, args }).then(String).catch(() => '—');

const tr = state.transistors || await pub.readContract({ address: proc, abi: A, functionName: 'transistors' });
console.log('processor   ' + proc);
console.log('transistors ' + tr + ' (' + ((((await pub.getCode({ address: tr })) || '0x').length - 2) / 2) + ' bytes)');
for (const f of ['mintPrice', 'protocolFee', 'maxSupply', 'supply', 'minted', 'NAND', 'LATCH', 'owner', 'creator']) console.log('  ' + f.padEnd(12) + await r(tr, f));
for (const id of [0n, 1n]) console.log('  id ' + id + ': your balance ' + await r(tr, 'balanceOf', [me, id]) + ' · totalSupply ' + await r(tr, 'totalSupply', [id]) + ' · uri ' + (await r(tr, 'uri', [id])).slice(0, 80));
console.log('  BEM allowance you → transistors: ' + await r(BEM, 'allowance', [me, tr]));
const pfee = BigInt((await r(tr, 'protocolFee')).replace('—', '0'));
const price = BigInt((await r(tr, 'mintPrice')).replace('—', '0'));
const okb = await pub.getBalance({ address: me });
console.log('  your OKB ' + formatEther(okb));

console.log('\nSimulating mint(id, amount) — nothing is sent:');
const values = [...new Set([pfee, pfee * 13n, price * 13n + pfee, price * 13n + pfee * 13n, 0n].map(String))].map(BigInt);
for (const id of [0n, 1n]){
  for (const amount of [13n, 1n]){
    for (const value of values){
      if (value > okb) continue;
      let out;
      try {
        await pub.call({ account: me, to: tr, data: (await import('viem')).encodeFunctionData({ abi: A, functionName: 'mint', args: [id, amount] }), value });
        out = 'would SUCCEED';
      } catch (e) {
        let c = e; let data = null;
        while (c){ if (typeof c.data === 'string' && c.data.startsWith('0x')) { data = c.data; break; } c = c.cause; }
        if (data && data.length > 2){
          try { const d = decodeErrorResult({ abi: ERRS, data }); out = d.errorName + '(' + d.args.map(String).join(', ') + ')'; }
          catch {
            if (data.startsWith('0x08c379a0')) { try { out = 'Error("' + (await import('viem')).decodeAbiParameters([{ type: 'string' }], '0x' + data.slice(10))[0] + '")'; } catch { out = data.slice(0, 74); } }
            else out = 'error data ' + data.slice(0, 74);
          }
        } else out = (e.shortMessage || e.message).split('\n')[0];
      }
      console.log('  id ' + id + ' × ' + amount + ' with ' + formatEther(value) + ' OKB → ' + out);
    }
  }
}
console.log('\nPaste everything above to Claude.');
