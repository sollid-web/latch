// Read-only. Can the old relay (0xA4b9…7A02) still get the 15 USDT0 out of the
// container? Simulates relay.withdraw() from the owner with "pretend" OKB balances
// (state overrides), and looks for fee settings on the container and the opener.
// Sends nothing, costs nothing.
//
//   node rescueprobe.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, parseAbi, formatEther, defineChain, encodeFunctionData, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '').split(/\r?\n/)){
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const chain = defineChain({ id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const pub = createPublicClient({ chain, transport: http(RPC_URL) });
const me = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY).address;

const OLD_RELAY = process.env.OLD_RELAY || '0xA4b9259279e4D5130FA563cB64B7aB73e2237A02';
const CONTAINER = '0xa38EB1b5Bf13C423b5aE5D844F08dc6774A9fCe0';
const OPENER = '0x536add8f30f03b69f6fbf29d425a816a0dc50106';
const PROCESSOR = '0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813';
const TOKEN = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';

const say = (s) => console.log(s);
const relayAbi = parseAbi(['function withdraw(address to, uint256 amount)', 'function owner() view returns (address)']);
const erc20 = parseAbi(['function balanceOf(address) view returns (uint256)']);

say('owner wallet   ' + me);
say('relay owner    ' + await pub.readContract({ address: OLD_RELAY, abi: relayAbi, functionName: 'owner' }));
const bal = await pub.readContract({ address: TOKEN, abi: erc20, functionName: 'balanceOf', args: [CONTAINER] });
say('container USDT0 ' + bal + ' (' + Number(bal) / 1e6 + ')');
say('container OKB   ' + formatEther(await pub.getBalance({ address: CONTAINER })));

// 1. Code layout: container (likely an ERC-1167 clone) → implementation
async function codeInfo(label, addr){
  const code = (await pub.getCode({ address: addr })) || '0x';
  say(label + ' ' + addr + ' code ' + ((code.length - 2) / 2) + ' bytes');
  const m = code.toLowerCase().match(/363d3d373d3d3d363d73([0-9a-f]{40})5af4/);
  if (m) { say('  ERC-1167 clone → implementation 0x' + m[1]); return codeInfo('  implementation', '0x' + m[1]); }
  const slot = await pub.getStorageAt({ address: addr, slot: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' }).catch(() => null);
  if (slot && BigInt(slot) !== 0n){ const impl = '0x' + slot.slice(-40); say('  ERC-1967 proxy → ' + impl); return codeInfo('  implementation', impl); }
  return code.toLowerCase();
}
const ccode = await codeInfo('container', CONTAINER);
const ocode = await codeInfo('opener', OPENER);

// 2. Look for fee getters/setters by name
const NAMES = ['fee()', 'FEE()', 'protocolFee()', 'PROTOCOL_FEE()', 'executeFee()', 'EXECUTE_FEE()', 'execFee()', 'callFee()', 'feeRecipient()', 'treasury()',
  'setFee(uint256)', 'setProtocolFee(uint256)', 'setExecuteFee(uint256)', 'owner()', 'opener()', 'token()', 'feeExempt(address)', 'isExempt(address)', 'setExempt(address,bool)'];
for (const [label, code, addr] of [['container', ccode, CONTAINER], ['opener', ocode, OPENER], ['processor', '', PROCESSOR]]){
  for (const n of NAMES){
    const sel = toFunctionSelector('function ' + n);
    const inCode = code && code.includes('63' + sel.slice(2));
    if (!inCode && label !== 'processor') continue;
    if (n.includes(',') || n.includes('(uint256)') || n.includes('(address)')){ if (inCode) say('  ' + label + ' has ' + n); continue; }
    try {
      const r = await pub.call({ to: addr, data: sel });
      if (r.data && r.data !== '0x') say('  ' + label + '.' + n + ' = ' + (r.data.length === 66 ? (r.data.startsWith('0x000000000000000000000000') && r.data.length === 66 && BigInt(r.data) > 2n ** 100n ? r.data : BigInt(r.data).toString()) : r.data.slice(0, 80)));
    } catch { /* not present */ }
  }
}

// 3. Simulate the rescue with pretend balances
const data = encodeFunctionData({ abi: relayAbi, functionName: 'withdraw', args: [me, bal] });
const tries = [
  ['as is', undefined],
  ['container holds 1 OKB', [{ address: CONTAINER, balance: 10n ** 18n }]],
  ['relay holds 1 OKB', [{ address: OLD_RELAY, balance: 10n ** 18n }]],
  ['both hold 1 OKB', [{ address: CONTAINER, balance: 10n ** 18n }, { address: OLD_RELAY, balance: 10n ** 18n }]]
];
say('\nSimulating relay.withdraw(you, all USDT0) from your wallet:');
for (const [label, stateOverride] of tries){
  const r = await pub.call({ account: me, to: OLD_RELAY, data, stateOverride })
    .then(() => 'WOULD SUCCEED')
    .catch((e) => { let c = e; while (c && !c.data) c = c.cause; return 'reverts ' + (c && c.data ? String(c.data.errorName || c.data).slice(0, 140) : (e.shortMessage || '').split('\n')[0]); });
  say('  ' + label.padEnd(24) + ' → ' + r);
}
say('\nPaste everything above to Claude.');
