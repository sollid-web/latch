/** TapeOut policy netlist for Latch.
 *
 * A processor `eval(id, inputs)` is a pure bit function. This file is that
 * function: 7 inputs, 13 NAND gates, 0 latches, 1 output (allow).
 * Opcode 0x00 records match TAP-02 (NAND, then two uint24 indexes).
 *
 * TAP-02 signal numbering (as the live X Layer processor evaluates it):
 *   signal 0 = constant 0, signal 1 = constant 1,
 *   signals 2..8 = the 7 inputs (bit i of the input byte is signal 2+i),
 *   signal 9+g = output of gate g. The output is the last signal.
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

/** Signal 9 is NOT(paused). Each later pair is AND(acc, next input). Signal 21 is allow. */
export const GATES: readonly Gate[] = [
  { a: 2, b: 2 },
  { a: 3, b: 9 },
  { a: 10, b: 10 },
  { a: 11, b: 4 },
  { a: 12, b: 12 },
  { a: 13, b: 5 },
  { a: 14, b: 14 },
  { a: 15, b: 6 },
  { a: 16, b: 16 },
  { a: 17, b: 7 },
  { a: 18, b: 18 },
  { a: 19, b: 8 },
  { a: 20, b: 20 },
];

export const N_IN = 7;
export const N_OUT = 1;
export const N_STATE = 0;

export function evalPolicy(bits: readonly boolean[]): { signals: boolean[]; allow: boolean } {
  if (bits.length !== N_IN) throw new Error("Latch policy expects 7 input bits");
  const signals = [false, true, ...bits];
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
