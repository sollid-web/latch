import { netlistHex, N_IN, GATES } from "@/lib/latch/circuit";
import { tapeName, type LatchState } from "@/lib/latch/engine";

export function submissionText(state: LatchState): string {
  const processor = state.processor.trim() || "(paste processor contract after tape-out)";
  return [
    "Latch — autonomous OKB dip sweep on X Layer.",
    "",
    "Product: a savings agent for circuit holders and small treasuries. When OKB/USDT trades at or below a threshold, Latch sweeps a capped amount of USDT from a TapeOut circuit container to one whitelisted savings address.",
    "",
    "Users: X Layer treasuries and TapeOut circuit holders who want automation without putting a seed phrase on a server.",
    "How we reach them: X Layer and TapeOut builders, the hackathon Telegram, and a public DeWEB status page on the container.",
    "",
    "Revenue: 5 USDT or 100 BEM to arm the agent, plus 1% of every successful sweep. They keep paying because the rule is an immutable circuit and the daemon cannot move funds the circuit rejects.",
    "",
    "TapeOut: the policy is a NAND netlist (7 inputs, 1 allow bit, 13 gates, 0 latches). LatchRelay derives the bits itself — paused, keeper, whitelist, sweep selector, per-tx cap, daily cap, funded — then requires processor.eval to return allow before container.execute.",
    `Processor contract: ${processor}`,
    `Circuit ID: ${state.circuitId || "(pending)"}`,
    `Tape name: ${tapeName(state)}`,
    "Chain: X Layer, chain id 196, area code 2.",
    `Netlist bytes (${GATES.length} NAND records, nIn ${N_IN}): ${netlistHex()}`,
    "",
    "Container: ERC-6551 account of that circuit. Opening fee on X Layer is 0.08 OKB. The relay owns the circuit NFT so it can execute. The daemon key pays gas only.",
    "DeWEB: the public status page is the wallet-free view to publish on the container.",
  ].join("\n");
}

export const DEMO_SCRIPT = [
  {
    t: "0:00",
    say: "Treasuries want a savings sweep when OKB dumps. They will not hand a bot a private key.",
  },
  {
    t: "0:20",
    say: "Users are circuit holders and small X Layer treasuries. We charge 5 USDT to arm and 1% of each sweep.",
  },
  {
    t: "0:40",
    say: "Show the container balance, the tape name, and the processor field. Funds live in the container.",
  },
  {
    t: "1:00",
    say: "Open Circuit. Seven bits. Walk one NAND. Allow is signal 19. The relay does not trust the daemon’s bits.",
  },
  {
    t: "1:25",
    say: "Connect, arm, start. Inject a dip. The feed shows bits, allow, and 50 USDT leaving for savings.",
  },
  {
    t: "1:50",
    say: "Fire the rogue 500 USDT transfer. The circuit denies it: wrong function, unknown target, over both caps.",
  },
  {
    t: "2:15",
    say: "Pause the rule and dip again. paused=1, so eval returns 0. Unpause if you want a second clean sweep.",
  },
  {
    t: "2:35",
    say: "Close on the form text: processor contract, circuit ID, revenue, and the DeWEB status page.",
  },
];
