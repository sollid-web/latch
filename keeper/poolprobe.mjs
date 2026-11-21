// Read-only: finds the Uniswap V3 USDT0/WOKB pools on X Layer and reports what the swap
// vault needs (liquidity, price, oracle history). Sends nothing, needs no key.
//   cd ~/latch/keeper && node poolprobe.mjs
import { createPublicClient, http, parseAbi } from 'viem';

const RPC = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const FACTORY = '0x4B2ab38DBF28D31D467aA8993f6c2585981D6804';
const ROUTER = '0x4f0c28f5926afda16bf2506d5d9e57ea190f9bca';
const USDT0 = '0x779Ded0c9e1022225f8E0630b35a9b54bE713736';
const WOKB = '0xe538905cf8410324e03A5A23C1c177a474D59b2b';

const pub = createPublicClient({ transport: http(RPC) });
const F = parseAbi(['function getPool(address,address,uint24) view returns (address)']);
const P = parseAbi([
  'function slot0() view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
  'function liquidity() view returns (uint128)',
  'function token0() view returns (address)',
  'function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)'
]);
const E = parseAbi(['function balanceOf(address) view returns (uint256)']);

const out = { rpc: RPC, routerHasCode: (await pub.getCode({ address: ROUTER }))?.length > 2, pools: [] };
for (const fee of [100, 500, 3000, 10000]) {
  const pool = await pub.readContract({ address: FACTORY, abi: F, functionName: 'getPool', args: [USDT0, WOKB, fee] });
  if (/^0x0+$/.test(pool)) { out.pools.push({ fee, pool: 'none' }); continue; }
  const [s0, liq, t0, bU, bW] = await Promise.all([
    pub.readContract({ address: pool, abi: P, functionName: 'slot0' }),
    pub.readContract({ address: pool, abi: P, functionName: 'liquidity' }),
    pub.readContract({ address: pool, abi: P, functionName: 'token0' }),
    pub.readContract({ address: USDT0, abi: E, functionName: 'balanceOf', args: [pool] }),
    pub.readContract({ address: WOKB, abi: E, functionName: 'balanceOf', args: [pool] })
  ]);
  // price of 1 OKB in USDT0 from the current tick (USDT0 has 6 decimals, WOKB 18)
  const usdtIsToken0 = t0.toLowerCase() === USDT0.toLowerCase();
  const raw = Math.pow(1.0001, s0[1]);           // token1 per token0, raw units
  const okbPrice = usdtIsToken0 ? 1e12 / raw : raw * 1e12;
  const twap = {};
  for (const secs of [300, 600, 1800]) {
    try {
      const r = await pub.readContract({ address: pool, abi: P, functionName: 'observe', args: [[secs, 0]] });
      const avgTick = Number(r[0][1] - r[0][0]) / secs;
      const raw2 = Math.pow(1.0001, avgTick);
      twap[secs + 's'] = Number((usdtIsToken0 ? 1e12 / raw2 : raw2 * 1e12).toFixed(3));
    } catch (e) { twap[secs + 's'] = 'unavailable (' + (e.shortMessage || e.message).split('\n')[0].slice(0, 60) + ')'; }
  }
  out.pools.push({
    fee, pool, token0IsUSDT0: usdtIsToken0, okbPriceNow: Number(okbPrice.toFixed(3)),
    liquidity: liq.toString(), usdt0InPool: Number(bU) / 1e6, wokbInPool: Number(bW) / 1e18,
    observationCardinality: s0[3], observationCardinalityNext: s0[4], twap
  });
}
console.log(JSON.stringify(out, null, 2));
