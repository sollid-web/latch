/** TapeOut policy netlist for Latch.
 *
 * A processor `eval(id, inputs)` is a pure bit function. This file is that
 * function: 7 inputs, 13 NAND gates, 0 latches, 1 output (allow).
 * Opcode 0x00 records match TAP-02 (NAND, then two uint24 indexes).
 *
 * allow = !paused ∧ keeper ∧ whitelisted ∧ actionOk ∧ txCap ∧ dailyOk ∧ funded
 */

export type Gate = { a: number; b: number };

export const INPUTS = [
  { name: "paused", hint: "1 means the agent is paused" },
  { name: "keeper", hint: "1 means the caller is the gas keeper" },
  { name: "whitelisted", hint: "1 means the target is the savings address" },
  { name: "actionOk", hint: "1 means the call is the sweep function" },
  { name: "txCap", hint: "1 means the amount is within the per-tx cap" },
  { name: "dailyOk", hint: "1 means today still has room under the daily cap" },
  { name: "funded", hint: "1 means the container covers amount plus fee" },
] as const;

/** Signal 7 is NOT(paused). Each later pair is AND(acc, next input). Signal 19 is allow. */
export const GATES: readonly Gate[] = [
  { a: 0, b: 0 },
  { a: 1, b: 7 },
  { a: 8, b: 8 },
  { a: 9, b: 2 },
  { a: 10, b: 10 },
  { a: 11, b: 3 },
  { a: 12, b: 12 },
  { a: 13, b: 4 },
  { a: 14, b: 14 },
  { a: 15, b: 5 },
  { a: 16, b: 16 },
  { a: 17, b: 6 },
  { a: 18, b: 18 },
];

export const N_IN = 7;
export const N_OUT = 1;
export const N_STATE = 0;

export function evalPolicy(bits: readonly boolean[]): { signals: boolean[]; allow: boolean } {
  if (bits.length !== N_IN) throw new Error("Latch policy expects 7 input bits");
  const signals = bits.slice();
  for (const gate of GATES) {
    const left = signals[gate.a];
    const right = signals[gate.b];
    if (left === undefined || right === undefined) throw new Error("netlist wire out of range");
    signals.push(!(left && right));
  }
  return { signals, allow: signals[signals.length - 1] === true };
}

/** TAP-02 NAND records: opcode 0x00, operand A u24, operand B u24, big-endian. */
export function netlistHex(): string {
  const bytes: number[] = [];
  for (const gate of GATES) {
    bytes.push(0x00);
    bytes.push((gate.a >> 16) & 0xff, (gate.a >> 8) & 0xff, gate.a & 0xff);
    bytes.push((gate.b >> 16) & 0xff, (gate.b >> 8) & 0xff, gate.b & 0xff);
  }
  return bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function bitsToByte(bits: readonly boolean[]): number {
  return bits.reduce((byte, bit, index) => byte | ((bit ? 1 : 0) << index), 0);
}

export function gateLabel(index: number, gate: Gate): string {
  const out = N_IN + index;
  if (index === 0) return `s${out} = NAND(s${gate.a}, s${gate.a}) = NOT paused`;
  if (index % 2 === 1) return `s${out} = NAND(s${gate.a}, s${gate.b})`;
  return `s${out} = NAND(s${gate.a}, s${gate.a}) = AND fold`;
}
