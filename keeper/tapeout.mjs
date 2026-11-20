// Latch tape-out on X Layer mainnet, in one resumable command.
//
//   1. createCPU on the TapeOut factory  → your processor ("Latch")
//   2. mint 13 NAND transistors          → one per gate
//   3. tapeout the 13-gate policy netlist → circuit #N
//   4. open the circuit's container      → 0.08 OKB, the address that holds funds
//   5. check eval(0x7e) = allow and eval(0x7f) = deny on chain
//
// Every transaction is simulated against the live chain before it is sent.
// Progress is saved to tapeout-state.json, so if anything stops you can run
// the same command again and it continues where it left off.
//
//   node tapeout.mjs          → dry run: fees, balance, simulated first step
//   SEND=1 node tapeout.mjs   → really send
//
// Needs in .env (same folder): OWNER_PRIVATE_KEY, optional RPC_URL.
// Addresses: TapeKit SPEC Appendix B (github.com/TapeOutProtocol/TapeKit).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient, createWalletClient, http, parseAbi, formatEther,
  decodeEventLog, defineChain, decodeErrorResult
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv(path.join(HERE, '.env'));

const TAPEOUT = {
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  // createCPU pulls deployFee() of BEM (8 decimals) from the caller (Nov 2026).
  bem: '0x60e62efa9405d6873c5deabd4e6cc91c25363952',
  opener: '0x536add8f30f03b69f6fbf29d425a816a0dc50106'
};
const NAND = 0n;

// TAP-02 numbering: s0 = 0, s1 = 1, s2..s8 = the 7 policy inputs, s9.. = gates.
// Same list as src/lib/latch/circuit.ts. allow = !paused & keeper & ... & funded.
const GATES = [[2, 2], [3, 9], [10, 10], [11, 4], [12, 12], [13, 5], [14, 14], [15, 6], [16, 16], [17, 7], [18, 18], [19, 8], [20, 20]];
const N_IN = 7, N_OUT = 1;
const NETLIST = '0x' + GATES.map(([a, b]) => '00' + a.toString(16).padStart(6, '0') + b.toString(16).padStart(6, '0')).join('');

const ABI = parseAbi([
  'function deployFee() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address, address)',
  'event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)',
  'function mint(uint256 id, uint256 amount) payable',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
  'function ownerOf(uint256) view returns (address)',
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function FEE() view returns (uint256)',
  'function open(address circuits, uint256 tokenId) payable',
  'function accountOf(address circuits, uint256 tokenId) view returns (address)',
  'function isOpened(address circuits, uint256 tokenId) view returns (bool)',
  'function isCPU(address) view returns (bool)',
  'function cpuCount() view returns (uint256)',
  'function cpuAt(uint256) view returns (address)',
  'function transistors() view returns (address)',
  'function mintPrice() view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function decimals() view returns (uint8)'
]);

const ALLOWANCE_ERR = parseAbi(['error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)']);
const BEM_BALANCE = parseAbi(['function balanceOf(address) view returns (uint256)']);

// Processor settings to try, in order. The first one that simulates cleanly is used.
// Name uniqueness and a zero mint price are the usual reasons createCPU reverts.
const SUFFIX = process.env.CPU_SUFFIX || '';
// The newest processor on mainnet (Nov 2026) was created with 0 OKB, mint price 0,
// supply 10000, so those come first. value: null means "use deployFee()".
// Matches the newest successful mainnet createCPU: no OKB attached, mint price 0
// (MAX_MINT_PRICE is 0.000001 OKB), the BEM fee pulled via approve. Only the name varies.
const CPU_VARIANTS = [
  { name: 'Latch Policy' + SUFFIX, symbol: 'LATCHP' + SUFFIX, supply: 10000n, mintPrice: 0n, value: 0n },
  { name: 'Latch Sweep Relay' + SUFFIX, symbol: 'LTCHR' + SUFFIX, supply: 10000n, mintPrice: 0n, value: 0n },
  { name: 'Latch Savings Circuit' + SUFFIX, symbol: 'LTCHS' + SUFFIX, supply: 10000n, mintPrice: 0n, value: 0n }
];

const SEND = process.env.SEND === '1';
const RPC_URL = process.env.RPC_URL || 'https://rpc.xlayer.tech';
const STATE_FILE = path.join(HERE, 'tapeout-state.json');
const STORY = 'Latch: a savings sweep that only moves when a 13-gate NAND policy says allow.';

const xlayer = defineChain({
  id: 196, name: 'X Layer', nativeCurrency: { name: 'OKB', symbol: 'OKB', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } }
});

main().catch((err) => {
  console.error('\nSTOPPED: ' + (err.shortMessage || err.message));
  console.error('Nothing after this point was sent. Fix the issue and run the same command again.');
  process.exit(1);
});

async function main(){
  checkNetlist();
  const key = process.env.OWNER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error('Set OWNER_PRIVATE_KEY=0x… (64 hex chars) in keeper/.env');
  const account = privateKeyToAccount(key);
  const pub = createPublicClient({ chain: xlayer, transport: http(RPC_URL) });
  const wallet = createWalletClient({ chain: xlayer, transport: http(RPC_URL), account });
  const chainId = await pub.getChainId();
  if (chainId !== 196) throw new Error('RPC is chain ' + chainId + ', expected 196 (X Layer mainnet)');

  const read = (address, functionName, args = []) => pub.readContract({ address, abi: ABI, functionName, args });
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  const [deployFee, openFee, balance, cpuCount] = await Promise.all([
    read(TAPEOUT.factory, 'deployFee'), read(TAPEOUT.opener, 'FEE'),
    pub.getBalance({ address: account.address }), read(TAPEOUT.factory, 'cpuCount')
  ]);
  // Mint fees live on each processor's transistor contract. Use processor #0 as a reference.
  let refProtocolFee = 660_000_000_000_000n;
  try {
    const ref = await read(TAPEOUT.factory, 'cpuAt', [0n]);
    refProtocolFee = await read(await read(ref, 'transistors'), 'protocolFee');
  } catch { /* keep the October figure */ }
  const mintFee = refProtocolFee + 10_000_000_000_000n * BigInt(GATES.length);
  const tapeoutGuess = 1_300_000_000_000_000n; // read for real once the processor exists
  const total = mintFee + tapeoutGuess + openFee;
  const [bemBal, bemAllow] = await Promise.all([
    pub.readContract({ address: TAPEOUT.bem, abi: parseAbi(['function balanceOf(address) view returns (uint256)']), functionName: 'balanceOf', args: [account.address] }),
    read(TAPEOUT.bem, 'allowance', [account.address, TAPEOUT.factory])
  ]);

  console.log('Owner wallet     ' + account.address);
  console.log('OKB balance      ' + formatEther(balance));
  console.log('BEM              balance ' + fmtBem(bemBal) + ' · approved to factory ' + fmtBem(bemAllow) + ' · createCPU fee ' + fmtBem(deployFee));
  console.log('Fees             createCPU ' + fmtBem(deployFee) + ' BEM · mint 13 NAND ≈ ' + formatEther(mintFee) +
    ' · tapeout ≈ ' + formatEther(tapeoutGuess) + ' · open ' + formatEther(openFee));
  console.log('Factory          ' + TAPEOUT.factory + ' · ' + cpuCount + ' processors so far');
  console.log('Total ≈          ' + formatEther(total) + ' OKB + gas (keep ~0.01 OKB extra)');
  console.log('Netlist          ' + NETLIST + ' (' + GATES.length + ' gates, allows only 0x7e)');
  if (!state.processor && bemBal < deployFee) throw new Error('Not enough BEM on X Layer: need ' + fmtBem(deployFee) + ' BEM (token ' + TAPEOUT.bem + ') in ' + account.address + ', have ' + fmtBem(bemBal) + '.');
  if (balance < openFee + 3_000_000_000_000_000n) throw new Error('Not enough OKB. Send at least ' + formatEther(total + 10_000_000_000_000_000n) + ' OKB to ' + account.address + ' on X Layer.');
  if (!SEND) console.log('\nDRY RUN — simulating only. Run with SEND=1 to send for real.\n');

  async function simulate(address, functionName, args, value){
    return pub.simulateContract({ account, address, abi: ABI, functionName, args, value });
  }
  // If a call reverts with ERC20InsufficientAllowance, return { spender, needed }.
  function allowanceAsk(err){
    let c = err;
    while (c){
      const data = typeof c.data === 'string' ? c.data : (c.data && c.data.data);
      if (typeof data === 'string' && data.startsWith('0xfb8f41b2')){
        const d = decodeErrorResult({ abi: ALLOWANCE_ERR, data });
        return { spender: d.args[0], needed: d.args[2] };
      }
      if (c.data && c.data.errorName === 'ERC20InsufficientAllowance') return { spender: c.data.args[0], needed: c.data.args[2] };
      c = c.cause;
    }
    return null;
  }
  async function sendTx(label, request){
    if (!SEND) return null;
    const hash = await wallet.writeContract(request);
    console.log('    sent       https://www.oklink.com/xlayer/tx/' + hash);
    const receipt = await pub.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(label + ' reverted on chain: ' + hash);
    return receipt;
  }
  // TapeOut fees moved from OKB to BEM in Nov 2026. Try the OKB value first; if the
  // chain says it wants a BEM allowance instead, approve exactly that and pay in BEM.
  async function send(label, address, functionName, args, value){
    let request;
    try {
      ({ request } = await simulate(address, functionName, args, value));
      console.log('  ✓ simulated  ' + label + (value ? '  (' + formatEther(value) + ' OKB)' : ''));
      return await sendTx(label, request);
    } catch (first) {
      if (first.message && first.message.includes('reverted on chain')) throw first;
      let ask = allowanceAsk(first);
      if (!ask && value){
        try { await simulate(address, functionName, args, 0n); } catch (second) { ask = allowanceAsk(second); }
      }
      if (!ask) throw new Error(label + ' would revert: ' + reason(first));
      const have = await pub.readContract({ address: TAPEOUT.bem, abi: BEM_BALANCE, functionName: 'balanceOf', args: [account.address] });
      console.log('  ' + label + ' is paid in BEM: ' + fmtBem(ask.needed) + ' BEM to ' + ask.spender + ' (you have ' + fmtBem(have) + ')');
      if (have < ask.needed) throw new Error('Not enough BEM for ' + label + ': need ' + fmtBem(ask.needed) + ', have ' + fmtBem(have));
      const { request: approveReq } = await simulate(TAPEOUT.bem, 'approve', [ask.spender, ask.needed], 0n);
      console.log('  ✓ simulated  approve ' + fmtBem(ask.needed) + ' BEM');
      if (!SEND){
        console.log('  (dry run: ' + label + ' can be simulated only after the approval exists)');
        return null;
      }
      await sendTx('approve BEM for ' + label, approveReq);
      try {
        ({ request } = await simulate(address, functionName, args, 0n));
      } catch (third) {
        throw new Error(label + ' would revert even after the BEM approval: ' + reason(third));
      }
      console.log('  ✓ simulated  ' + label + ' (paid in BEM)');
      return await sendTx(label, request);
    }
  }
  const findEvent = (receipt, name) => receipt.logs.map((l) => {
    try { return decodeEventLog({ abi: ABI, data: l.data, topics: l.topics }); } catch { return null; }
  }).find((e) => e && e.eventName === name);

  // 1. Processor
  if (!state.processor){
    console.log('Step 1/4  create your processor');
    if (bemAllow < deployFee){
      console.log('  approve ' + fmtBem(deployFee) + ' BEM to the TapeOut factory (exact amount, nothing more)');
      if (!SEND){
        await pub.simulateContract({ account, address: TAPEOUT.bem, abi: ABI, functionName: 'approve', args: [TAPEOUT.factory, deployFee] });
        console.log('  ✓ simulated  approve');
        console.log('\nDry run OK up to the approval. createCPU can only be simulated after the approval exists,');
        console.log('so the real run approves first, then simulates createCPU before sending it.');
        console.log('When ready:  SEND=1 node tapeout.mjs');
        return;
      }
      await send('approve BEM', TAPEOUT.bem, 'approve', [TAPEOUT.factory, deployFee], 0n);
    }
    let chosen = null;
    for (const v of CPU_VARIANTS){
      try {
        const value = v.value === null ? deployFee : v.value;
        await pub.simulateContract({ account, address: TAPEOUT.factory, abi: ABI, functionName: 'createCPU',
          args: [v.name, v.symbol, STORY, v.supply, v.mintPrice], value });
        chosen = { ...v, value };
        console.log('  ✓ simulates  name "' + v.name + '", symbol ' + v.symbol + ', supply ' + v.supply + ', mint price ' + formatEther(v.mintPrice) + ' OKB, sending ' + formatEther(value) + ' OKB');
        break;
      } catch (err) {
        console.log('  ✗ reverts    name "' + v.name + '", supply ' + v.supply + ', mint price ' + formatEther(v.mintPrice) + ', sending ' + (v.value === null ? 'deployFee' : formatEther(v.value) + ' OKB') + ' → ' + reason(err));
      }
    }
    if (!chosen) throw new Error('createCPU reverts for every setting tried. Paste this whole output to Claude.');
    if (!SEND) return dryRunEnd();
    const r = await send('createCPU', TAPEOUT.factory, 'createCPU',
      [chosen.name, chosen.symbol, STORY, chosen.supply, chosen.mintPrice], chosen.value);
    const ev = findEvent(r, 'CPUCreated');
    if (!ev) throw new Error('createCPU: no CPUCreated event in ' + r.transactionHash);
    // Do not trust event argument order: the processor is the one with TAPEOUT_FEE(),
    // and its transistors() is the mint contract.
    const pair = [ev.args.circuits, ev.args.transistors];
    let processor = null;
    for (const addr of pair){
      try { await read(addr, 'TAPEOUT_FEE'); processor = addr; break; } catch { /* not the processor */ }
    }
    if (!processor) throw new Error('createCPU: could not identify the processor in ' + r.transactionHash);
    state.processor = processor;
    state.transistors = await read(processor, 'transistors');
    state.cpuName = chosen.name;
    state.createTx = r.transactionHash;
    save();
    if (!(await read(TAPEOUT.factory, 'isCPU', [processor]))) throw new Error('factory.isCPU(processor) is false — stop and send me this output');
  }
  console.log('  processor    ' + state.processor);

  // 2. Transistors: one NAND per gate
  const need = BigInt(GATES.length);
  const have = await read(state.transistors, 'balanceOf', [account.address, NAND]);
  if (!state.circuitId && have < need){
    console.log('Step 2/4  mint ' + (need - have) + ' NAND transistors');
    const amount = need - have;
    // Nov 2026: mint price 0, a flat 0.01 BEM protocol fee per mint call, pulled by approval.
    const value = 0n;
    const r = await send('mint NAND × ' + amount, state.transistors, 'mint', [NAND, amount], value);
    if (!r) return dryRunEnd();
    state.mintTx = r.transactionHash;
    save();
  }

  // 3. Tape out
  if (!state.circuitId){
    console.log('Step 3/4  tape out the 13-gate policy');
    const fee = await read(state.processor, 'TAPEOUT_FEE');
    const r = await send('tapeout', state.processor, 'tapeout', [NETLIST, N_IN, N_OUT], fee);
    if (!r) return dryRunEnd();
    const ev = findEvent(r, 'TapedOut');
    if (!ev) throw new Error('tapeout: no TapedOut event in ' + r.transactionHash);
    state.circuitId = ev.args.circuitId.toString();
    state.tapeoutTx = r.transactionHash;
    save();
  }
  const id = BigInt(state.circuitId);
  console.log('  circuit      #' + state.circuitId);

  // 4. Container
  state.container = await read(TAPEOUT.opener, 'accountOf', [state.processor, id]);
  if (!(await read(TAPEOUT.opener, 'isOpened', [state.processor, id]))){
    console.log('Step 4/4  open the container');
    const r = await send('open container', TAPEOUT.opener, 'open', [state.processor, id], openFee);
    if (!r) return dryRunEnd();
    state.openTx = r.transactionHash;
  }
  save();
  console.log('  container    ' + state.container);

  // 5. Check the circuit on chain
  const allow = await read(state.processor, 'eval', [id, '0x7e']);
  const deny = await read(state.processor, 'eval', [id, '0x7f']);
  const ok = (parseInt(allow.slice(2, 4), 16) & 1) === 1 && (parseInt(deny.slice(2, 4), 16) & 1) === 0;
  console.log('\neval(0x7e) = ' + allow + ' · eval(0x7f) = ' + deny + (ok ? '  ✓ circuit is correct' : '  ✗ WRONG — stop and send me this output'));
  if (!ok) process.exit(1);
  const owner = await read(state.processor, 'ownerOf', [id]);
  console.log('Circuit NFT owner: ' + owner);
  console.log('Name: ' + state.circuitId + '.2.<processor number>.tape');
  console.log('\nSaved to keeper/tapeout-state.json. Next, from the repo root:\n');
  console.log('  PROCESSOR=' + state.processor + ' CIRCUIT_ID=' + state.circuitId + ' CONTAINER=' + state.container + ' \\');
  console.log('  OWNER_KEY=$OWNER_PRIVATE_KEY USDT=… SAVINGS=… TREASURY=… KEEPER=… ./scripts/golive.sh');
}

function fmtBem(x){ return x === null || x === undefined ? '?' : (Number(x) / 1e8).toString(); }

function reason(err){
  const parts = [];
  let e = err;
  while (e){
    if (e.data && e.data.errorName) parts.push(e.data.errorName + (e.data.args ? '(' + e.data.args.map(String).join(', ') + ')' : ''));
    if (typeof e.data === 'string' && e.data.length > 2) parts.push('data ' + e.data.slice(0, 74));
    if (e.reason) parts.push(e.reason);
    if (e.signature) parts.push('error ' + e.signature);
    e = e.cause;
  }
  const raw = String(err.details || err.shortMessage || err.message || err).split('\n')[0];
  const sig = String(err.message || '').match(/signature:?\s*(0x[0-9a-fA-F]{8})/);
  if (sig) parts.push('selector ' + sig[1]);
  const uniq = [...new Set(parts)].filter((x) => !raw.includes(x.replace(/^(error|selector) /, '')));
  return (uniq.length ? uniq.join(' · ') + ' · ' : '') + raw;
}

function dryRunEnd(){
  console.log('\nDry run OK. The first step simulates cleanly against X Layer mainnet.');
  console.log('Steps 2–4 need the processor from step 1, so they are simulated during the real run, each just before it is sent.');
  console.log('When ready:  SEND=1 node tapeout.mjs');
}

// Local evaluation with TAP-02 semantics: refuse to spend OKB on a wrong netlist.
function checkNetlist(){
  const allows = [];
  for (let b = 0; b < 128; b++){
    const s = [0, 1];
    for (let i = 0; i < N_IN; i++) s.push((b >> i) & 1);
    for (const [x, y] of GATES){
      if (x >= s.length || y >= s.length) throw new Error('netlist wire out of range');
      s.push(1 - (s[x] & s[y]));
    }
    if (s[s.length - 1] === 1) allows.push(b);
  }
  if (allows.length !== 1 || allows[0] !== 0x7e) throw new Error('netlist self-check failed: allows ' + allows.join(','));
}

function loadEnv(file){
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)){
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
