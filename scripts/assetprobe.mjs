// Read-only: which assets could Latch safely trade against USDT0 on X Layer's Uniswap V3?
// For each candidate token and fee tier: pool address, USDT0 held by the pool (depth), price-history slots
// (Latch needs a 30-minute average), and whether a 30-minute average can be read right now. Sends nothing.
//   node scripts/assetprobe.mjs
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';

const RPC = process.env.RPC || 'https://rpc.xlayer.tech';
const pub = createPublicClient({ transport: http(RPC, { timeout: 30_000 }) });
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const UNI = '0x4B2ab38DBF28D31D467aA8993f6c2585981D6804';
const CANDIDATES = [
  ['WOKB (today)', '0xe538905cf8410324e03A5A23C1c177a474D59b2b'],
  ['xETH (OKX)', '0xe7b000003a45145decf8a28fc755ad5ec5ea025a'],
  ['xBTC (OKX)', '0xb7c00000bcdeef966b20b3d884b98e64d2b06b4f'],
  ['WETH (bridged)', '0x5a77f1443d16ee5761d310e38b62f77f726bc71c'],
  ['WBTC (bridged)', '0xEA034fb02eB1808C2cc3adbC15f447B93CbE08e1'],
  ...(process.env.EXTRA ? process.env.EXTRA.split(',').map((a) => ['extra', a.trim()]) : [])
];
const F = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const P = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16 cardinality,uint16,uint8,bool)', 'function liquidity() view returns (uint128)', 'function observe(uint32[]) view returns (int56[],uint160[])']);
const E = parseAbi(['function balanceOf(address) view returns (uint256)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
const ZERO = '0x0000000000000000000000000000000000000000';

for (const [label, token] of CANDIDATES) {
  let sym = '?', dec = 18;
  try { [sym, dec] = await Promise.all([pub.readContract({ address: token, abi: E, functionName: 'symbol' }), pub.readContract({ address: token, abi: E, functionName: 'decimals' })]); } catch { console.log(`${label}: not a token at ${token}`); continue; }
  for (const fee of [100, 500, 3000, 10000]) {
    const pool = await pub.readContract({ address: UNI, abi: F, functionName: 'getPool', args: [USDT0, token, fee] }).catch(() => ZERO);
    if (pool === ZERO) continue;
    const [usd, tok, s0] = await Promise.all([
      pub.readContract({ address: USDT0, abi: E, functionName: 'balanceOf', args: [pool] }),
      pub.readContract({ address: token, abi: E, functionName: 'balanceOf', args: [pool] }),
      pub.readContract({ address: pool, abi: P, functionName: 'slot0' })
    ]);
    const twap = await pub.readContract({ address: pool, abi: P, functionName: 'observe', args: [[1800, 0]] }).then(() => 'yes').catch(() => 'NO');
    console.log(`${label.padEnd(16)} ${sym.padEnd(6)} fee ${String(fee / 10000).padEnd(5)}%  pool ${pool}  USDT0 ${Number(formatUnits(usd, 6)).toLocaleString('en-US', { maximumFractionDigits: 0 }).padStart(10)}  ${sym} ${Number(formatUnits(tok, dec)).toLocaleString('en-US', { maximumFractionDigits: 4 })}  history slots ${s0[3]}  30-min average: ${twap}`);
  }
}
console.log('\nRule of thumb for Latch: at least ~50,000 USDT0 in the pool, 30-min average "yes", and history slots well above 30.');
