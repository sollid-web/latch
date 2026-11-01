/**
 * Latch daemon skeleton.
 *
 * The process holds a gas-only key. It cannot withdraw container funds.
 * Every tick is a call to LatchRelay.tick, which rebuilds the policy bits
 * and asks the TapeOut processor to eval the circuit.
 *
 *   LATCH_RPC=https://rpc.xlayer.tech \
 *   LATCH_RELAY=0xYourRelay \
 *   LATCH_KEEPER_KEY=0x… \
 *   LATCH_THRESHOLD=48 \
 *   node daemon/latch-daemon.mjs
 *
 * Do not commit the keeper key. If the process dies, start it again —
 * the relay's daily accounting is on-chain, so a restart cannot double-spend
 * past the cap.
 */

const rpc = process.env.LATCH_RPC ?? "https://rpc.xlayer.tech";
const relay = process.env.LATCH_RELAY;
const threshold = Number(process.env.LATCH_THRESHOLD ?? "48");
const sweep = process.env.LATCH_SWEEP_WEI ?? "50000000000000000000";

if (!relay) {
  console.log("Latch daemon idle. Set LATCH_RELAY to the deployed LatchRelay on X Layer (chain 196).");
  console.log(`Would poll ${rpc} and submit tick(${sweep}) when OKB <= ${threshold}.`);
  process.exit(0);
}

console.log(
  JSON.stringify({
    ok: true,
    chainId: 196,
    rpc,
    relay,
    threshold,
    sweep,
    note: "Wire an eth_call preview, then send tick only when the oracle is at or under the threshold.",
  }),
);
