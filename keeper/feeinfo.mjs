// Read-only. Shows which ERC-20 token the TapeOut factory charges for createCPU,
// by reading the token transfers inside a recent successful createCPU, plus your
// balance and allowance of that token and the factory's MAX_MINT_PRICE.
//
//   node feeinfo.mjs                 (uses the newest known creation tx)
//   TX=0x… node feeinfo.mjs          (or any other createCPU tx hash)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, formatUnits, formatEther, defineChain, decodeEventLog } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '').split(/\r?\n/)){
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const FACTORY = '0x1f09daefa827f02cbb40967cc91b259763760761';
const TX = process.env.TX || '0x2c1759ea1ffced5a26b7a58d675064e285b7bae0b25c3a6cb1075d9bb45be8dc';
const chain = defineChain({ id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const ERC20 = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)'
]);
const F = parseAbi(['function deployFee() view returns (uint256)', 'function MAX_MINT_PRICE() view returns (uint256)']);
const me = process.env.OWNER_PRIVATE_KEY && /^0x[0-9a-fA-F]{64}$/.test(process.env.OWNER_PRIVATE_KEY)
  ? privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address : null;

const [fee, maxMint] = await Promise.all([
  pub.readContract({ address: FACTORY, abi: F, functionName: 'deployFee' }),
  pub.readContract({ address: FACTORY, abi: F, functionName: 'MAX_MINT_PRICE' }).catch(() => null)
]);
console.log('deployFee() raw = ' + fee);
if (maxMint !== null) console.log('MAX_MINT_PRICE() = ' + maxMint + ' wei (' + formatEther(maxMint) + ' OKB)');

const tx = await pub.getTransaction({ hash: TX });
const rc = await pub.getTransactionReceipt({ hash: TX });
console.log('\ncreateCPU tx ' + TX + ' from ' + tx.from + ' · status ' + rc.status);
const seen = new Set();
for (const log of rc.logs){
  let ev;
  try { ev = decodeEventLog({ abi: ERC20, data: log.data, topics: log.topics }); } catch { continue; }
  if (ev.eventName !== 'Transfer') continue;
  const token = log.address;
  let symbol = '?', decimals = 18;
  try { symbol = await pub.readContract({ address: token, abi: ERC20, functionName: 'symbol' }); } catch {}
  try { decimals = Number(await pub.readContract({ address: token, abi: ERC20, functionName: 'decimals' })); } catch { decimals = null; }
  const amt = decimals === null ? ev.args.value + ' (NFT id?)' : formatUnits(ev.args.value, decimals) + ' ' + symbol;
  console.log('  Transfer ' + token + ' ' + symbol + ' · ' + ev.args.from + ' → ' + ev.args.to + ' · ' + amt);
  if (decimals !== null && ev.args.from.toLowerCase() === tx.from.toLowerCase() && !seen.has(token)){
    seen.add(token);
    console.log('  ^ FEE TOKEN candidate: ' + symbol + ' ' + token + ' (decimals ' + decimals + '); deployFee = ' + formatUnits(fee, decimals) + ' ' + symbol);
    if (me){
      const [bal, allow] = await Promise.all([
        pub.readContract({ address: token, abi: ERC20, functionName: 'balanceOf', args: [me] }),
        pub.readContract({ address: token, abi: ERC20, functionName: 'allowance', args: [me, FACTORY] })
      ]);
      console.log('    your wallet ' + me + ': balance ' + formatUnits(bal, decimals) + ' ' + symbol + ' · allowance to factory ' + formatUnits(allow, decimals));
    }
  }
}
if (!seen.size) console.log('No ERC-20 transfer from the creator found in that transaction.');
console.log('\nPaste everything above to Claude.');
