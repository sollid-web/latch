// Strategy circuit #2 (101 NAND gates, live on the Latch TapeOut processor), run in the browser with the
// exact netlist that was taped out, plus the plain-English words for what it sees and decides.
import circuit from '../circuits/circuit2.json';

export const GATE_COUNT = circuit.gates;

/** Evaluate the real TAP-02 netlist: signals 0 = 0, 1 = 1, 2..17 = inputs (LSB first), then one per gate. */
export function evalChip(x) {
  const s = [0, 1];
  for (let i = 0; i < 16; i++) s.push((x >> i) & 1);
  for (const [a, b] of circuit.tap02) s.push(1 - (s[a] & s[b]));
  const [allow, k0, k1] = s.slice(-3);
  return { allow: allow === 1, k: allow ? k0 | (k1 << 1) : 0, gates: s.slice(18) };
}

export const SAFE = 0x7e;
export const pack = ({ safety = SAFE, depth = 0, vol = 0, mode = 0 }) => (safety & 0x7f) | (depth << 7) | (vol << 10) | (mode << 12);
export const unpack = (x) => ({ safety: x & 0x7f, depth: (x >> 7) & 7, vol: (x >> 10) & 3, mode: (x >> 12) & 3 });

/** Strategy names, by direction (0 = Buy, 1 = Take Profit). */
export const MODES = [
  [
    { name: 'Steady', line: 'The same amount every time, whatever the price.', short: 'Steady buying (DCA)' },
    { name: 'Dips only', line: 'Buys only when OKB is below your reference price.', short: 'Buys only on dips' },
    { name: 'Smart', line: 'Buys every time, and 2× or 3× more on bigger dips. Drops to 1× when the market is jumpy.', short: 'More on bigger dips' },
    { name: 'Ladder', line: 'Waits for a 5% dip, then 1×; 2× from 15% down; 3× from 30% down.', short: 'Ladder on deeper dips' }
  ],
  [
    { name: 'Steady', line: 'Sells the same amount every time, as long as the price is at or above your floor.', short: 'Steady selling' },
    { name: 'Rises only', line: 'Sells only when OKB is above your reference price.', short: 'Sells only on rises' },
    { name: 'Smart', line: 'Sells every time, and 2× or 3× more on bigger rises. Drops to 1× when the market is jumpy.', short: 'More on bigger rises' },
    { name: 'Ladder', line: 'Waits for a 5% rise, then 1×; 2× from 15% up; 3× from 30% up.', short: 'Ladder on higher prices' }
  ]
];
export const DEPTHS = ['at or past the reference', 'under 5%', '5–10%', '10–15%', '15–20%', '20–30%', '30–40%', '40% or more'];
export const depthWord = (d, dir) => d === 0 ? (dir === 0 ? 'not below the reference' : 'not above the reference') : `${DEPTHS[d]} ${dir === 0 ? 'below' : 'above'} the reference`;
export const VOLS = ['calm', 'a little busy', 'jumpy', 'very jumpy'];
export const SAFETY = [
  ['Paused by the owner', 0, true],
  ['Sent by the vault’s own agent', 1],
  ['Output only to the owner’s wallet', 2],
  ['Price inside the owner’s limit, market stable', 3],
  ['Trade size inside the per-trade limit', 4],
  ['Inside today’s limit and spacing', 5],
  ['Vault holds enough for trade + fee', 6]
];

/** The size the chip picks for each move bucket (0 = no trade), all safety checks passing. */
export const curve = (mode, vol) => DEPTHS.map((_, d) => evalChip(pack({ depth: d, vol, mode })).k);

/** Same buckets as the vault (LatchVault._depth): how far `price` moved in the owner's favour vs `ref`. */
export function depthOf(price, ref, dir) {
  if (!ref || !price) return 0;
  const move = dir === 0 ? (ref - price) / ref : (price - ref) / ref;
  if (move <= 0) return 0;
  const bps = move * 10000;
  return bps < 500 ? 1 : bps < 1000 ? 2 : bps < 1500 ? 3 : bps < 2000 ? 4 : bps < 3000 ? 5 : bps < 4000 ? 6 : 7;
}
