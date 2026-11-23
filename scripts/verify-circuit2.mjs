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

async function call(body) {
  for (let a = 0; a < 5; a++) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (r.ok) return await r.json();
    } catch { /* retry */ }
    await new Promise((s) => setTimeout(s, 500 * (a + 1)));
  }
  throw new Error('RPC not answering: ' + rpc);
}
// (The netlist bytes themselves are compared with circuits/circuit2.json by preflight-v2.sh via cast.)

const BATCH = Number(process.env.BATCH || 512);
let bad = 0, done = 0;
for (let start = 0; start < 65536; start += BATCH) {
  const body = [];
  for (let x = start; x < Math.min(65536, start + BATCH); x++) {
    body.push({ jsonrpc: '2.0', id: x, method: 'eth_call', params: [{ to: processor, data: data(x) }, 'latest'] });
  }
  const res = await call(body);
  for (const r of res) {
    const x = r.id;
    if (r.error || typeof r.result !== 'string' || r.result.length < 2 + 128 + 2) {
      if (bad++ < 10) console.log(`input 0x${x.toString(16).padStart(4, '0')}: no answer (${JSON.stringify(r.error || r.result).slice(0, 120)})`);
      continue;
    }
    const len = parseInt(r.result.slice(2 + 64, 2 + 128), 16);
    const o = parseInt(r.result.slice(2 + 128, 2 + 130), 16);
    const [a, k] = spec(x);
    const ga = o & 1, gk = (o >> 1) & 3;
    if (len !== 1 || ga !== a || (a === 1 && gk !== k) || (a === 0 && gk !== 0)) {
      if (bad++ < 10) console.log(`input 0x${x.toString(16).padStart(4, '0')}: chip says allow=${ga} k=${gk} (len ${len}), rules say allow=${a} k=${k}`);
    }
    done++;
  }
}
console.log(`checked ${done} of 65536 inputs, mismatches: ${bad}`);
console.log(bad ? 'CIRCUIT MISMATCH' : 'CIRCUIT OK');
process.exit(bad ? 1 : 0);
