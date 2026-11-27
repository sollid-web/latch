#!/usr/bin/env node
// Read-only health check of everything Latch runs on X Layer mainnet and the web. Sends nothing, costs nothing.
//   node scripts/check-mainnet.mjs
// Prints OK / FAIL per item and a summary. Paste the output to Claude if anything fails.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createPublicClient, http, parseAbi, getAddress } from 'viem';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = JSON.parse(fs.readFileSync(process.env.CONFIG || path.join(root, 'deployments/web-config.json'), 'utf8')); // CONFIG=… for a local test chain
const SITE = 'https://okblatch.xyz';
const chain = { id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: C.rpc } } };
const pub = createPublicClient({ chain, transport: http(C.rpc[0], { retryCount: 3, timeout: 20_000 }) });

const F = parseAbi(['function vaultCount() view returns (uint256)', 'function vaults(uint256) view returns (address)', 'function isVault(address) view returns (bool)', 'function hostedKeeper() view returns (address)', 'function processor() view returns (address)', 'function circuitId() view returns (uint256)', 'function pool() view returns (address)']);
const V2 = parseAbi(['function owner() view returns (address)', 'function keeper() view returns (address)', 'function tokenIn() view returns (address)', 'function paused() view returns (bool)', 'function preview(address) view returns (uint16 inputs, uint8 k, uint256 amount, uint256 fee, uint256 minOut, uint256 avgPrice)']);
const DEP = parseAbi(['function classicFactory() view returns (address)', 'function factory2() view returns (address)', 'function classicToken() view returns (address)', 'function deposit(address,address,uint256)']);
const POOL = parseAbi(['function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)', 'function observe(uint32[]) view returns (int56[],uint160[])']);
const PROC = parseAbi(['function eval(uint256 id, bytes inputs) view returns (bytes)']);

const rows = []; let bad = 0;
const ok = (name, pass, detail = '') => { rows.push(`${pass ? 'OK  ' : 'FAIL'}  ${name}${detail ? '  · ' + detail : ''}`); if (!pass) bad++; console.log(rows.at(-1)); };
const step = async (name, fn) => { try { await fn(); } catch (e) { ok(name, false, String(e.shortMessage || e.message || e).slice(0, 160)); } };
const get = async (url, type = 'text') => { const r = await fetch(url, { headers: { 'cache-control': 'no-cache' } }); if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`); return type === 'json' ? r.json() : r.text(); };
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

console.log('Latch mainnet check · ' + new Date().toISOString() + '\n');

await step('X Layer RPC answers, chain 196', async () => { ok('X Layer RPC answers, chain 196', (await pub.getChainId()) === 196); });

await step('Contracts exist', async () => {
  for (const [n, a] of [['classic factory', C.factory], ['factory2', C.factory2], ['deposit helper', C.depositor], ['TapeOut processor', C.processor], ['Uniswap pool', C.pool], ['DeWEB container', C.deweb?.container]]) {
    const code = a ? await pub.getCode({ address: a }) : null;
    ok(`${n} has code`, !!code && code !== '0x', a);
  }
});

await step('Pool price', async () => {
  const s0 = await pub.readContract({ address: C.pool, abi: POOL, functionName: 'slot0' });
  const obs = await pub.readContract({ address: C.pool, abi: POOL, functionName: 'observe', args: [[1800, 0]] });
  ok('Uniswap pool: live price and 30-minute average readable', s0 && obs[0].length === 2, `tick ${s0[1]}`);
});

await step('Circuit #2', async () => {
  const input = 0x7e | (5 << 7) | (2 << 12); // all safety facts, 20–30% dip, calm, Smart
  const out = await pub.readContract({ address: C.processor, abi: PROC, functionName: 'eval', args: [BigInt(C.circuit2Id), '0x' + (input & 0xff).toString(16).padStart(2, '0') + (input >> 8).toString(16).padStart(2, '0')] });
  const o = parseInt(out.slice(2, 4), 16);
  ok('circuit #2 answers on chain (20–30% dip, calm, Smart → buy 3×)', (o & 1) === 1 && ((o >> 1) & 3) === 3, `eval → ${out}`);
});

let vaults = [];
await step('Factories', async () => {
  const n2 = Number(await pub.readContract({ address: C.factory2, abi: F, functionName: 'vaultCount' }));
  const n1 = Number(await pub.readContract({ address: C.factory, abi: F, functionName: 'vaultCount' }));
  ok('factories list their vaults', n1 + n2 > 0, `classic ${n1}, v2 ${n2}`);
  for (let i = 0; i < n2; i++) vaults.push(await pub.readContract({ address: C.factory2, abi: F, functionName: 'vaults', args: [BigInt(i)] }));
  const pin = await pub.readContract({ address: C.factory2, abi: F, functionName: 'circuitId' });
  ok('factory2 is pinned to circuit #' + C.circuit2Id, Number(pin) === Number(C.circuit2Id));
});

await step('Deposit helper', async () => {
  const [c1, c2, t] = await Promise.all(['classicFactory', 'factory2', 'classicToken'].map((f) => pub.readContract({ address: C.depositor, abi: DEP, functionName: f })));
  ok('deposit helper points at both factories and USDT0', same(c1, C.factory) && same(c2, C.factory2) && same(t, C.usdt));
  let refused = false; try { await pub.simulateContract({ account: '0x000000000000000000000000000000000000dEaD', address: C.depositor, abi: DEP, functionName: 'deposit', args: [C.usdt, '0x000000000000000000000000000000000000dEaD', 1n] }); } catch { refused = true; }
  ok('deposit helper refuses an address that is not a Latch vault', refused);
});

await step('Vaults', async () => {
  for (const v of vaults.slice(0, 10)) {
    const [owner, keeper, paused] = await Promise.all(['owner', 'keeper', 'paused'].map((f) => pub.readContract({ address: v, abi: V2, functionName: f })));
    const p = await pub.readContract({ address: v, abi: V2, functionName: 'preview', args: [keeper] });
    ok(`vault ${v.slice(0, 8)}… readable (owner ${owner.slice(0, 6)}…, ${paused ? 'paused' : 'on'})`, true, `chip input 0x${Number(p[0]).toString(16)}, k ${p[1]}`);
  }
});

await step('Website', async () => {
  const html = await get(SITE + '/');
  ok('website loads', html.length > 100_000, `${Math.round(html.length / 1024)} KiB`);
  ok('website is the latest build (Demo and Agents pages, deposit helper)', /pageDemo|Try the whole journey/.test(html) && /How agents use Latch|Agents/.test(html) && html.toLowerCase().includes(C.depositor.toLowerCase()), 'run npm run deploy if this fails');
  ok('website points at the live factory2', html.toLowerCase().includes(C.factory2.toLowerCase()));
});

await step('Agent', async () => {
  const st = await get(C.keeperUrl + '/', 'json');
  ok("Latch's agent answers (read-only dry run)", !!st && st.action !== 'error', `action ${st.action}${st.why ? ': ' + st.why : ''}`);
  ok("Latch's agent serves the live factory2", JSON.stringify(st).toLowerCase().includes(C.factory2.toLowerCase()));
  if (st.market) ok('exchanges and the Uniswap pool agree on the OKB price', st.market.safe === true, st.market.safe ? `exchanges ${Number(st.market.cex).toFixed(2)}, pool ${Number(st.market.pool).toFixed(2)}` : st.market.reason);
});

await step('Trade history', async () => {
  const t = await get(C.keeperUrl + '/trades', 'json');
  ok('trade history endpoint answers', Array.isArray(t.trades), `${t.trades?.length ?? 0} trades, scanned to block ${t.scannedTo ?? '…'}`);
  ok('trade history has caught up with the chain', t.complete === true, t.complete ? '' : 'still catching up: check again in an hour');
});

await step('DeWEB', async () => {
  const shell = await get(C.deweb.url); // TapeKit's gateway page, which then loads the site from chain in the browser
  ok('DeWEB gateway answers at ' + C.deweb.url, shell.length > 500, `${Math.round(shell.length / 1024)} KiB loader`);
  const SITES = '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6';
  const info = await pub.readContract({ address: SITES, abi: parseAbi(['function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)']), functionName: 'fileInfo', args: [C.deweb.container, 'index.html'] });
  execFileSync(process.execPath, [path.join(root, 'scripts/build-web.mjs')], { env: { ...process.env, ONCHAIN: '1' }, stdio: 'ignore' });
  const local = '0x' + crypto.createHash('sha256').update(fs.readFileSync(path.join(root, 'public-onchain/index.html'))).digest('hex');
  ok('on-chain copy is stored on X Layer', Number(info[0]) > 100_000, `${Math.round(Number(info[0]) / 1024)} KiB, updated ${new Date(Number(info[3]) * 1000).toISOString().slice(0, 16)}`);
  ok('on-chain copy matches the current build', info[2].toLowerCase() === local, info[2].toLowerCase() === local ? '' : 're-upload: ONCHAIN=1 node scripts/build-web.mjs && SEND=1 node scripts/publish-deweb.mjs');
});

await step('Verified source', async () => {
  for (const [n, a] of [['factory2', C.factory2], ['classic factory', C.factory], ['deposit helper', C.depositor]]) {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/196/${a}`).then((x) => x.json()).catch(() => null);
    const st = r?.match || r?.runtimeMatch || r?.creationMatch;
    ok(`${n} verified on Sourcify`, !!st, st ? st.replace('exact_match', 'exact match') : 'not found: run ./scripts/verify-contracts.sh');
  }
});

console.log(`\n${bad ? bad + ' FAILED: paste this whole output to Claude' : 'ALL OK'}`);
process.exit(bad ? 1 : 0);
