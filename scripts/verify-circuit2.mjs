// Ask a live (or forked) TapeOut processor about EVERY possible input of strategy circuit #2
// (all 65,536) and compare each answer with the written rules. Read-only: eth_call only.
//   node scripts/verify-circuit2.mjs <rpc> <processor> <circuitId>
// Prints "CIRCUIT OK" or the first mismatches, and exits 1 on any mismatch.
const [rpc, processor, idArg] = process.argv.slice(2);
if (!rpc || !processor || !idArg) { console.error('usage: node scripts/verify-circuit2.mjs <rpc> <processor> <circuitId>'); process.exit(2); }
const id = BigInt(idArg);

// Same rules as circuits/circuit2.py spec()
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

const hex32 = (n) => n.toString(16).padStart(64, '0');
const data = (x) => '0x934d06ea' + hex32(id) + hex32(64n) + hex32(2n) + ((x & 0xff).toString(16).padStart(2, '0') + ((x >> 8) & 0xff).toString(16).padStart(2, '0')).padEnd(64, '0');

const sleep = (ms) => new Promise((s) => setTimeout(s, ms));
async function post(body) {
  try {
    const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    try { return JSON.parse(text); } catch { return { error: { message: 'HTTP ' + r.status + ' ' + text.slice(0, 80) } }; }
  } catch (e) { return { error: { message: String(e.message || e) } }; }
}
// Public RPCs limit batch size and rate. Ask in batches; if the RPC refuses a batch (non-list answer)
// or rate-limits single answers, wait, shrink the batch and ask again. Only a real answer counts.
let batch = Number(process.env.BATCH || 100);
const PARALLEL = Number(process.env.PARALLEL || 6);
const answers = new Map();
let pending = Array.from({ length: 65536 }, (_, x) => x);
let rounds = 0;
async function ask(xs, retry) {
  const res = await post(xs.map((x) => ({ jsonrpc: '2.0', id: x, method: 'eth_call', params: [{ to: processor, data: data(x) }, 'latest'] })));
  if (!Array.isArray(res)) { retry.push(...xs); return 'refused'; }
  const got = new Set();
  for (const r of res) {
    if (r && typeof r.result === 'string' && r.result.length >= 2 + 130) { answers.set(r.id, r.result); got.add(r.id); }
    else if (r && r.error && /revert|execution/i.test(String(r.error.message))) { answers.set(r.id, 'ERR ' + r.error.message); got.add(r.id); }
  }
  let missed = 0;
  for (const x of xs) if (!got.has(x)) { retry.push(x); missed++; }
  return missed ? 'throttled' : 'ok';
}
while (pending.length) {
  if (++rounds > 200) { console.log('RPC keeps refusing; try again later or with RPC=https://xlayerrpc.okx.com'); process.exit(1); }
  const retry = [];
  let refused = 0, throttled = 0;
  const chunks = [];
  for (let i = 0; i < pending.length; i += batch) chunks.push(pending.slice(i, i + batch));
  for (let i = 0; i < chunks.length; i += PARALLEL) {
    const out = await Promise.all(chunks.slice(i, i + PARALLEL).map((c) => ask(c, retry)));
    refused += out.filter((o) => o === 'refused').length;
    throttled += out.filter((o) => o === 'throttled').length;
    if (out.includes('refused') && batch > 1) { // batch too big for this RPC: shrink and resend the rest smaller
      batch = Math.max(1, Math.floor(batch / 2));
      for (const c of chunks.slice(i + PARALLEL)) retry.push(...c);
      break;
    }
    if (process.stdout.isTTY) process.stdout.write(`\r  asked ${answers.size} of 65536 (batch ${batch})   `);
  }
  pending = retry;
  if (pending.length) await sleep(refused || throttled > 2 ? 1500 : 300);
}
if (process.stdout.isTTY) process.stdout.write('\n');
let bad = 0, done = 0;
for (let x = 0; x < 65536; x++) {
  const res = answers.get(x);
  done++;
  if (res.startsWith('ERR')) { if (bad++ < 10) console.log(`input 0x${x.toString(16).padStart(4, '0')}: chip call failed (${res.slice(0, 100)})`); continue; }
  const len = parseInt(res.slice(2 + 64, 2 + 128), 16);
  const o = parseInt(res.slice(2 + 128, 2 + 130), 16);
  const [a, k] = spec(x);
  const ga = o & 1, gk = (o >> 1) & 3;
  if (len !== 1 || ga !== a || (a === 1 && gk !== k) || (a === 0 && gk !== 0)) {
    if (bad++ < 10) console.log(`input 0x${x.toString(16).padStart(4, '0')}: chip says allow=${ga} k=${gk} (len ${len}), rules say allow=${a} k=${k}`);
  }
}
console.log(`checked ${done} of 65536 inputs, mismatches: ${bad}`);
console.log(bad ? 'CIRCUIT MISMATCH' : 'CIRCUIT OK');
process.exit(bad ? 1 : 0);
