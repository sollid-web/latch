// Tape out Latch strategy circuit #2 (101 NAND, 16 inputs, 3 outputs) on the existing Latch processor.
//
//   1. mint the NAND transistors still needed (TapeOut protocol fee: 0.01 BEM per mint call)
//   2. tapeout(netlist, 16, 3)          (TAPEOUT_FEE, 0.0013 OKB)
//   3. check on chain: netlist bytes identical, circuitInfo = (16, 3, 0, 101), spot evals match the rules
//
// Before spending anything it re-checks the netlist locally against the rules for all 65,536 inputs.
// Every transaction is simulated first. Progress is saved, so re-running continues where it stopped.
//
//   node tapeout2.mjs                → dry run (simulates; sends nothing)
//   SEND=1 node tapeout2.mjs         → really send
//   RPC_URL=http://127.0.0.1:8549 STATE=/tmp/x.json SEND=1 node tapeout2.mjs   → same, on a local fork
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, createWalletClient, http, parseAbi, formatEther, decodeEventLog, defineChain, decodeErrorResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
for (const line of (fs.existsSync(path.join(HERE, '.env')) ? fs.readFileSync(path.join(HERE, '.env'), 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const PROCESSOR = '0x3728a5dfE596F6bF7309cA911e61ecaC9b0b6813';
const BEM = '0x60e62efa9405d6873c5deabd4e6cc91c25363952';
const C2 = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'circuits', 'circuit2.json'), 'utf8'));
const NETLIST = C2.netlist.toLowerCase(), N_IN = 16, N_OUT = 3, GATES = BigInt(C2.gates);
const SEND = process.env.SEND === '1';
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const STATE_FILE = process.env.STATE || path.join(HERE, 'tapeout2-state.json');
const chain = defineChain({ id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 }, rpcUrls: { default: { http: [RPC_URL] } } });
const ABI = parseAbi([
  'function transistors() view returns (address)',
  'function protocolFee() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function mint(uint256 id, uint256 amount) payable',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function netlist(uint256 id) view returns (bytes)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function ownerOf(uint256) view returns (address)',
  'function approve(address spender, uint256 amount) returns (bool)'
]);
const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const ALLOWANCE_ERR = parseAbi(['error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)']);

function spec(x) {
  const safety = x & 0x7f, d = (x >> 7) & 7, v = (x >> 10) & 3, m = (x >> 12) & 3, r = (x >> 14) & 3;
  if (safety !== 0x7e || r !== 0) return [0, 0];
  const jumpy = v >= 2;
  if (m === 0) return [1, 1];
  if (m === 1) return d >= 1 ? [1, 1] : [0, 0];
  if (v === 3) return [0, 0];
  if (m === 3) { if (d < 2) return [0, 0]; if (jumpy) return [1, 1]; if (d >= 6) return [1, 3]; if (d >= 4) return [1, 2]; return [1, 1]; }
  return [1, jumpy ? 1 : d >= 5 ? 3 : d >= 3 ? 2 : 1];
}
function checkNetlistLocally() {
  const hex = NETLIST.slice(2); if (hex.length % 14) throw new Error('netlist length is not a multiple of 7 bytes');
  const gates = []; for (let i = 0; i < hex.length; i += 14) {
    if (hex.slice(i, i + 2) !== '00') throw new Error('non-NAND element in netlist');
    gates.push([parseInt(hex.slice(i + 2, i + 8), 16), parseInt(hex.slice(i + 8, i + 14), 16)]);
  }
  if (BigInt(gates.length) !== GATES) throw new Error('gate count mismatch');
  for (let x = 0; x < 65536; x++) {
    const s = [0, 1]; for (let i = 0; i < N_IN; i++) s.push((x >> i) & 1);
    for (const [a, b] of gates) { if (a >= s.length || b >= s.length) throw new Error('wire out of range'); s.push(1 - (s[a] & s[b])); }
    const o = s.slice(-N_OUT); const [ea, ek] = spec(x);
    if (o[0] !== ea || (o[1] | (o[2] << 1)) !== (ea ? ek : 0)) throw new Error('netlist disagrees with the rules at input 0x' + x.toString(16));
  }
  console.log('Netlist self-check: ' + gates.length + ' NAND, all 65,536 inputs match the rules ✓');
}

async function main() {
  checkNetlistLocally();
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set OWNER_PRIVATE_KEY=0x… in keeper/.env');
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain, transport: http(RPC_URL) });
  const wallet = createWalletClient({ chain, transport: http(RPC_URL), account });
  if ((await pub.getChainId()) !== 196) throw new Error('RPC is not X Layer (196)');
  const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const code = await pub.getCode({ address: account.address });
  if (code && code !== '0x') console.log('WARNING: your wallet has contract code (EIP-7702). NAND mint may refuse it (ERC1155InvalidReceiver).');
  const tr = await read(PROCESSOR, 'transistors');
  const [okb, bem, have, fee] = await Promise.all([pub.getBalance({ address: account.address }),
    pub.readContract({ address: BEM, abi: ERC20, functionName: 'balanceOf', args: [account.address] }),
    read(tr, 'balanceOf', [account.address, 0n]), read(PROCESSOR, 'TAPEOUT_FEE')]);
  let pfee = 0n; try { pfee = await read(tr, 'protocolFee'); } catch { /* */ }
  console.log('Owner wallet   ' + account.address);
  console.log('Processor      ' + PROCESSOR + ' · transistors ' + tr);
  console.log('Balances       ' + formatEther(okb) + ' OKB · ' + (Number(bem) / 1e8) + ' BEM · ' + have + ' NAND');
  console.log('Fees           mint ' + (Number(pfee) / 1e8) + ' BEM per call (if paid in BEM) · tapeout ' + formatEther(fee) + ' OKB');
  if (okb < fee + 2_000_000_000_000_000n) throw new Error('Not enough OKB: need about ' + formatEther(fee + 2_000_000_000_000_000n) + ' (fee + gas)');
  if (!SEND) console.log('\nDRY RUN — simulating only. Run with SEND=1 to send for real.\n');

  const allowanceAsk = (err) => {
    for (let c = err; c; c = c.cause) {
      const data = typeof c.data === 'string' ? c.data : (c.data && c.data.data);
      if (typeof data === 'string' && data.startsWith('0xfb8f41b2')) { const d = decodeErrorResult({ abi: ALLOWANCE_ERR, data }); return { spender: d.args[0], needed: d.args[2] }; }
      if (c.data && c.data.errorName === 'ERC20InsufficientAllowance') return { spender: c.data.args[0], needed: c.data.args[2] };
    }
    return null;
  };
  const sendTx = async (label, request) => {
    if (!SEND) return null;
    const hash = await wallet.writeContract(request);
    console.log('    sent  https://www.oklink.com/xlayer/tx/' + hash);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== 'success') throw new Error(label + ' reverted on chain: ' + hash);
    return r;
  };
  const sim = (address, functionName, args, value) => pub.simulateContract({ account, address, abi: ABI, functionName, args, value });
  async function send(label, address, functionName, args, value) {
    try {
      const { request } = await sim(address, functionName, args, value);
      console.log('  ✓ simulated  ' + label + (value ? ' (' + formatEther(value) + ' OKB)' : ''));
      return await sendTx(label, request);
    } catch (first) {
      if (String(first.message).includes('reverted on chain')) throw first;
      let ask = allowanceAsk(first);
      if (!ask && value) { try { await sim(address, functionName, args, 0n); } catch (e2) { ask = allowanceAsk(e2); } }
      if (!ask) throw new Error(label + ' would revert: ' + (first.shortMessage || first.message).split('\n')[0]);
      const bal = await pub.readContract({ address: BEM, abi: ERC20, functionName: 'balanceOf', args: [account.address] });
      console.log('  ' + label + ' is paid in BEM: ' + (Number(ask.needed) / 1e8) + ' BEM (you have ' + (Number(bal) / 1e8) + ')');
      if (bal < ask.needed) throw new Error('Not enough BEM for ' + label + ': need ' + (Number(ask.needed) / 1e8) + ' BEM on X Layer in ' + account.address);
      const { request: ap } = await sim(BEM, 'approve', [ask.spender, ask.needed], 0n);
      console.log('  ✓ simulated  approve exactly ' + (Number(ask.needed) / 1e8) + ' BEM');
      if (!SEND) { console.log('  (dry run: ' + label + ' is simulated for real only after that approval exists)'); return null; }
      await sendTx('approve BEM', ap);
      const { request } = await sim(address, functionName, args, 0n);
      console.log('  ✓ simulated  ' + label + ' (paid in BEM)');
      return await sendTx(label, request);
    }
  }

  if (!state.circuitId && have < GATES) {
    const amount = GATES - have;
    console.log('Step 1/3  mint ' + amount + ' NAND');
    const r = await send('mint ' + amount + ' NAND', tr, 'mint', [0n, amount], 0n);
    if (!r) { console.log('\nDry run stops here (tapeout needs the NAND first). When ready: SEND=1 node tapeout2.mjs'); return; }
    state.mintTx = r.transactionHash; save();
  }
  if (!state.circuitId) {
    console.log('Step 2/3  tape out circuit #2 (' + GATES + ' NAND)');
    const r = await send('tapeout', PROCESSOR, 'tapeout', [NETLIST, N_IN, N_OUT], fee);
    if (!r) { console.log('\nDry run OK. When ready: SEND=1 node tapeout2.mjs'); return; }
    const ev = r.logs.map((l) => { try { return decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { return null; } }).find((e) => e && e.eventName === 'TapedOut');
    if (!ev) throw new Error('no TapedOut event in ' + r.transactionHash);
    state.circuitId = ev.args.circuitId.toString(); state.tapeoutTx = r.transactionHash; save();
  }
  const id = BigInt(state.circuitId);
  console.log('Step 3/3  check circuit #' + id + ' on chain');
  const nl = (await read(PROCESSOR, 'netlist', [id])).toLowerCase();
  if (nl !== NETLIST) throw new Error('netlist on chain differs from circuits/circuit2.json — STOP and send this to Claude');
  const info = await read(PROCESSOR, 'circuitInfo', [id]);
  console.log('  circuitInfo  inputs ' + info[0] + ' · outputs ' + info[1] + ' · state ' + info[2] + ' · gates ' + info[3]);
  if (info[0] !== 16 || info[1] !== 3 || info[2] !== 0 || BigInt(info[3]) !== GATES) throw new Error('circuitInfo mismatch');
  for (const x of [0x7e | (5 << 7) | (2 << 12), 0x7e | (3 << 7) | (2 << 12), 0x7e | (1 << 12), 0x7f, 0x7e | (6 << 7) | (3 << 12), 0x7e | (1 << 14)]) {
    const o = parseInt((await read(PROCESSOR, 'eval', [id, '0x' + (x & 0xff).toString(16).padStart(2, '0') + (x >> 8).toString(16).padStart(2, '0')])).slice(2, 4), 16);
    const [a, k] = spec(x);
    if ((o & 1) !== a || (a && ((o >> 1) & 3) !== k)) throw new Error('eval mismatch at 0x' + x.toString(16));
  }
  console.log('  spot checks  ✓ (run scripts/verify-circuit2.mjs for all 65,536)');
  console.log('  circuit NFT owner ' + await read(PROCESSOR, 'ownerOf', [id]));
  console.log('\nCIRCUIT2_ID=' + id);
}
main().catch((e) => { console.error('\nSTOP: ' + (e.shortMessage || e.message)); process.exit(1); });
