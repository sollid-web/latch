// Publish Latch on X Layer DeWEB: public-onchain/index.html stored in the ERC-6551 container of strategy
// circuit #2 (the chip itself is the website's home), named <circuit>.2.<processor index>.tape and served by
// TapeKit gateways at https://<circuit>-2-<processor index>.tapekit.org/.
//
//   1. open circuit #2's container (one-time TapeOut fee, read from the Opener)
//   2. putFile + appendChunk (24,000-byte chunks) into SiteRegistry (resumable)
//   3. setFallback("index.html"), bind the .tape name for MONTHS months (fee read from DomainBinding)
//   4. read every byte back and compare SHA-256
//
//   ONCHAIN=1 node scripts/build-web.mjs && node scripts/publish-deweb.mjs        → dry run: names, costs, nothing sent
//   SEND=1 node scripts/publish-deweb.mjs                                           → really publish (asks nothing; run the dry run first)
//   RPC_URL=http://127.0.0.1:8549 SEND=1 node scripts/publish-deweb.mjs             → same, on a local fork (rehearsal)
// Reads OWNER_PRIVATE_KEY from keeper/.env (must hold the circuit NFT). Env: MONTHS (default 12), CIRCUIT (default 2).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, formatEther, defineChain, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const line of (fs.existsSync(path.join(root, 'keeper/.env')) ? fs.readFileSync(path.join(root, 'keeper/.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const PROCESSOR = '0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813';
const CPU_FACTORY = '0x1f09DAeFA827f02CBb40967cc91b259763760761';
const OPENER = '0x536adD8F30f03b69f6fbF29d425A816A0dC50106';
const SITES = '0xd6EFb7adCc9c83dC4924Ad56f6a8E4e969b9ADB6';
const BINDING = '0x68809Fd2fb343aA57D0aeB7f33Defe477c9666f9';
const CHUNK = 24_000;
const FILE_PATH = 'index.html';
const SEND = process.env.SEND === '1';
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const CID = BigInt(process.env.CIRCUIT || 2);
const MONTHS = BigInt(process.env.MONTHS || 12);
const chain = defineChain({ id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });

const ABI = parseAbi([
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256) view returns (address)',
  'function ownerOf(uint256) view returns (address)',
  'function accountOf(address circuits, uint256 tokenId) view returns (address)',
  'function isOpened(address circuits, uint256 tokenId) view returns (bool)',
  'function open(address circuits, uint256 tokenId) payable returns (address)',
  'function FEE() view returns (uint256)',
  'function fileInfo(address container, string path) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)',
  'function readRange(address container, string path, uint256 offset, uint256 len) view returns (bytes)',
  'function fallbackPath(address container) view returns (string)',
  'function putFile(address container, string path, string contentType, bytes32 sha256Hash, bytes data)',
  'function appendChunk(address container, string path, uint256 expectIndex, bytes data)',
  'function setFallback(address container, string path)',
  'function monthlyFee() view returns (uint256)',
  'function isLive(string name, address container) view returns (bool)',
  'function isContainerLive(address container) view returns (bool)',
  'function bind(string name, address container, uint256 months) payable'
]);

async function main() {
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set OWNER_PRIVATE_KEY=0x… in keeper/.env');
  const me = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 60_000 }) });
  const wallet = createWalletClient({ chain, transport: http(RPC_URL, { timeout: 60_000 }), account: me });
  if ((await pub.getChainId()) !== 196) throw new Error('RPC is not X Layer (196)');
  const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });

  const filePath = path.join(root, 'public-onchain/index.html');
  if (!fs.existsSync(filePath)) throw new Error('Build first: ONCHAIN=1 node scripts/build-web.mjs');
  const file = fs.readFileSync(filePath);
  if (/127\.0\.0\.1|localhost:/.test(file.toString())) throw new Error('This build contains a local test address: rebuild with ONCHAIN=1 node scripts/build-web.mjs');
  const sha = '0x' + crypto.createHash('sha256').update(file).digest('hex');
  const chunks = [];
  for (let i = 0; i < file.length; i += CHUNK) chunks.push(file.subarray(i, i + CHUNK));

  // Which processor number is ours (the .tape name uses it)
  const n = Number(await read(CPU_FACTORY, 'cpuCount'));
  let cpuIndex = -1;
  for (let lo = n - 1; lo >= 0 && cpuIndex < 0; lo -= 50) {
    const idx = Array.from({ length: Math.min(50, lo + 1) }, (_, i) => lo - i);
    const addrs = await Promise.all(idx.map((i) => read(CPU_FACTORY, 'cpuAt', [BigInt(i)])));
    const hit = addrs.findIndex((a) => a.toLowerCase() === PROCESSOR.toLowerCase());
    if (hit >= 0) cpuIndex = idx[hit];
  }
  if (cpuIndex < 0) throw new Error('Latch processor not found in the TapeOut factory');
  const NAME = `${CID}.2.${cpuIndex}.tape`;
  const URL = `https://${CID}-2-${cpuIndex}.tapekit.org/`;

  const [holder, container, opened, openFee, monthly, gasPrice, bal] = await Promise.all([
    read(PROCESSOR, 'ownerOf', [CID]), read(OPENER, 'accountOf', [PROCESSOR, CID]), read(OPENER, 'isOpened', [PROCESSOR, CID]),
    read(OPENER, 'FEE'), read(BINDING, 'monthlyFee'), pub.getGasPrice(), pub.getBalance({ address: me.address })
  ]);
  if (holder.toLowerCase() !== me.address.toLowerCase()) throw new Error(`circuit #${CID} is held by ${holder}, not your owner wallet ${me.address}`);
  // viem returns multi-value results as a list: [size, contentType, sha256Hash, updatedAt, chunkCount]
  const fileInfo = async () => { const r = await read(SITES, 'fileInfo', [container, FILE_PATH]); return { size: Number(r[0]), sha256Hash: r[2], chunkCount: Number(r[4]) }; };
  const have = await fileInfo().catch(() => null);
  const live = await read(BINDING, 'isLive', [NAME, container]).catch(() => false);
  // storage cost estimate: ~ 22k gas per 32 bytes written + overhead
  const gasEst = BigInt(file.length) * 720n + BigInt(chunks.length) * 120_000n;
  const cost = (opened ? 0n : openFee) + (live ? 0n : monthly * MONTHS) + gasEst * gasPrice;
  console.log(`Site        ${file.length.toLocaleString()} bytes in ${chunks.length} chunks · sha256 ${sha}`);
  console.log(`Name        ${NAME}  →  ${URL}`);
  console.log(`Container   ${container} (circuit #${CID}'s ERC-6551 account) · opened: ${opened}`);
  console.log(`Fees        open ${formatEther(openFee)} OKB (once) · name ${formatEther(monthly)} OKB/month × ${MONTHS} = ${formatEther(monthly * MONTHS)} OKB · gas price ${Number(gasPrice) / 1e9} gwei`);
  console.log(`Estimate    about ${formatEther(cost)} OKB in total still to spend · your balance ${formatEther(bal)} OKB`);
  if (have && have.sha256Hash === sha) console.log(`Progress    this exact file is already stored (${have.chunkCount}/${chunks.length} chunks)`);
  if (bal < cost) throw new Error(`Not enough OKB: need about ${formatEther(cost)} OKB (fewer months: MONTHS=6)`);
  if (!SEND) { console.log('\nDRY RUN — nothing sent. When ready: SEND=1 node scripts/publish-deweb.mjs'); return; }

  const send = async (label, functionName, address, args, value = 0n) => {
    const { request } = await pub.simulateContract({ account: me, address, abi: ABI, functionName, args, value });
    const gas = await pub.estimateContractGas({ account: me, address, abi: ABI, functionName, args, value });
    const hash = await wallet.writeContract({ ...request, gas: gas + gas / 4n });
    const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (r.status !== 'success') throw new Error(`${label} reverted: ${hash}`);
    console.log(`  ✓ ${label}  ${hash}  (gas ${r.gasUsed})`);
  };
  if (!opened) await send('open container', 'open', OPENER, [PROCESSOR, CID], openFee);
  let start = 1;
  if (have && have.sha256Hash === sha && have.chunkCount >= 1 && have.chunkCount <= chunks.length) start = have.chunkCount;
  else await send(`putFile 1/${chunks.length}`, 'putFile', SITES, [container, FILE_PATH, 'text/html; charset=utf-8', sha, toHex(chunks[0])]);
  for (let i = start; i < chunks.length; i++) await send(`appendChunk ${i + 1}/${chunks.length}`, 'appendChunk', SITES, [container, FILE_PATH, BigInt(i), toHex(chunks[i])]);
  if ((await read(SITES, 'fallbackPath', [container])) !== FILE_PATH) await send('setFallback', 'setFallback', SITES, [container, FILE_PATH]);
  if (!(await read(BINDING, 'isLive', [NAME, container]))) await send(`bind ${NAME} for ${MONTHS} months`, 'bind', BINDING, [NAME, container, MONTHS], monthly * MONTHS);

  // Read every byte back
  const info = await fileInfo();
  const parts = [];
  for (let off = 0; off < info.size; off += 60_000) parts.push(Buffer.from((await read(SITES, 'readRange', [container, FILE_PATH, BigInt(off), 60_000n])).slice(2), 'hex'));
  const back = Buffer.concat(parts);
  const backSha = '0x' + crypto.createHash('sha256').update(back).digest('hex');
  const ok = backSha === sha && back.length === file.length;
  console.log(`Read back   ${back.length.toLocaleString()} bytes, sha256 ${ok ? 'matches ✓' : 'MISMATCH ' + backSha}`);
  console.log(`Live        ${await read(BINDING, 'isContainerLive', [container])}`);
  console.log(`Spent       ${formatEther(bal - (await pub.getBalance({ address: me.address })))} OKB`);
  if (!ok) process.exit(1);
  if (RPC_URL === 'https://rpc.xlayer.tech' || process.env.WRITE_CONFIG === '1') {
    const p = path.join(root, 'deployments/web-config.json');
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    cfg.deweb = { name: NAME, url: URL, container, sha256: sha };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
    console.log('wrote deployments/web-config.json (the normal site will link to the on-chain copy)');
  }
  console.log(`\nDONE  ${URL}  ·  tape://${NAME}/`);
}
main().catch((e) => { console.error('\nSTOP: ' + (e.shortMessage || e.message)); process.exit(1); });
