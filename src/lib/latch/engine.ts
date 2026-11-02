import { evalPolicy } from "@/lib/latch/circuit";

export const PREVIEW_WALLET = "0x4E2a91c0b184A77e0c1d4e0a9C0b184A77e091c0";
export const SAVINGS = "0x5a6E19c0b184A77e0c1d4e0a9C0b184A77e0A11c";
export const ROGUE_TARGET = "0xBaD0000000000000000000000000000000000Bad";
export const ACTIVATION_USDT = 5;
export const FEE_BPS = 100;
export const CHAIN_ID = 196;
export const AREA_CODE = 2;

export type LogKind = "system" | "trigger" | "rejected" | "executed";

export type LogEntry = {
  id: string;
  at: number;
  kind: LogKind;
  title: string;
  detail: string;
  bits?: string;
  allow?: boolean;
};

export type Proposal = {
  kind: "sweep" | "transfer";
  amount: number;
  target: string;
  keeper: boolean;
  title: string;
};

export type Receipt = {
  at: number;
  allow: boolean;
  source: string;
  amount: number;
  fee: number;
  bits: string;
  call: string;
  reasons: string[];
};

export type LatchState = {
  connected: boolean;
  armed: boolean;
  running: boolean;
  paused: boolean;
  processor: string;
  cpu: string;
  circuitId: string;
  usdt: number;
  swept: number;
  spentToday: number;
  dayKey: string;
  perTx: number;
  daily: number;
  sweepAmount: number;
  threshold: number;
  price: number;
  history: number[];
  savings: string;
  protocolEarned: number;
  ticks: number;
  logs: LogEntry[];
  lastBits: boolean[] | null;
  lastAllow: boolean | null;
  lastSignals: boolean[] | null;
  lastReceipt: Receipt | null;
};

export function defaultState(): LatchState {
  return {
    connected: false,
    armed: false,
    running: false,
    paused: false,
    processor: "",
    cpu: "0",
    circuitId: "7",
    usdt: 1000,
    swept: 0,
    spentToday: 0,
    dayKey: "",
    perTx: 50,
    daily: 150,
    sweepAmount: 50,
    threshold: 48,
    price: 56.4,
    history: [58, 57.2, 56.8, 57.5, 56.1, 56.4],
    savings: SAVINGS,
    protocolEarned: 0,
    ticks: 0,
    logs: [
      {
        id: "boot",
        at: 0,
        kind: "system",
        title: "Policy netlist loaded",
        detail: "13 NAND gates, 7 inputs, allow bit on signal 19. No key in the daemon.",
      },
    ],
    lastBits: null,
    lastAllow: null,
    lastSignals: null,
    lastReceipt: null,
  };
}

export type Action =
  | { type: "hydrate"; state: LatchState }
  | { type: "connect" }
  | { type: "disconnect" }
  | { type: "arm"; now: number }
  | { type: "fund"; amount: number; now: number }
  | { type: "start"; now: number }
  | { type: "stop"; now: number }
  | { type: "pause"; now: number }
  | { type: "resume"; now: number }
  | { type: "tick"; now: number; rand: number }
  | { type: "dip"; now: number }
  | { type: "rogue"; now: number }
  | { type: "reset"; now: number }
  | {
      type: "configure";
      patch: Partial<
        Pick<
          LatchState,
          "processor" | "cpu" | "circuitId" | "perTx" | "daily" | "sweepAmount" | "threshold" | "savings"
        >
      >;
    };

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function dayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

function sameAddress(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function log(state: LatchState, entry: Omit<LogEntry, "id" | "at"> & { at: number }): LatchState {
  const next: LogEntry = { ...entry, id: `${entry.at}-${state.logs.length}-${state.ticks}` };
  return { ...state, logs: [next, ...state.logs].slice(0, 40) };
}

export function tapeName(state: Pick<LatchState, "circuitId" | "cpu">): string {
  const id = state.circuitId.trim() || "?";
  const cpu = state.cpu.trim() || "0";
  return `#${id}@${AREA_CODE}.${cpu}`;
}

export function policyBits(state: LatchState, proposal: Proposal): { bits: boolean[]; reasons: string[] } {
  const fee = round2((proposal.amount * FEE_BPS) / 10_000);
  const whitelisted = sameAddress(proposal.target, state.savings);
  const actionOk = proposal.kind === "sweep";
  const txCap = proposal.amount > 0 && proposal.amount <= state.perTx;
  const dailyOk = round2(state.spentToday + proposal.amount) <= state.daily;
  const funded = state.usdt >= round2(proposal.amount + fee);
  const bits = [state.paused, proposal.keeper, whitelisted, actionOk, txCap, dailyOk, funded];
  const reasons: string[] = [];
  if (state.paused) reasons.push("agent is paused");
  if (!proposal.keeper) reasons.push("caller is not the keeper");
  if (!whitelisted) reasons.push("target is not the savings whitelist");
  if (!actionOk) reasons.push("function is not the sweep");
  if (!txCap) reasons.push(`amount is over the ${state.perTx} USDT per-tx cap`);
  if (!dailyOk) reasons.push(`daily cap of ${state.daily} USDT would break`);
  if (!funded) reasons.push("container cannot cover the sweep plus the 1% fee");
  return { bits, reasons };
}

function applyProposal(state: LatchState, proposal: Proposal, now: number): LatchState {
  const rolled = state.dayKey === dayKey(now) ? state : { ...state, dayKey: dayKey(now), spentToday: 0 };
  const { bits, reasons } = policyBits(rolled, proposal);
  const { signals, allow } = evalPolicy(bits);
  const bitText = bits.map((bit) => (bit ? "1" : "0")).join("");
  const fee = round2((proposal.amount * FEE_BPS) / 10_000);

  // Human-readable ABI call description for the receipt card.
  const callStr = proposal.kind === "sweep"
    ? `LatchRelay.tick(${proposal.amount.toFixed(2)})`
    : `transfer(${proposal.target}, ${proposal.amount.toFixed(2)})`;

  const receipt: Receipt = {
    at: now,
    allow,
    source: proposal.title,
    amount: proposal.amount,
    fee,
    bits: bitText,
    call: callStr,
    reasons,
  };

  const withEval: LatchState = {
    ...rolled,
    lastBits: bits,
    lastAllow: allow,
    lastSignals: signals,
    lastReceipt: receipt,
  };

  if (!allow) {
    return log(withEval, {
      at: now,
      kind: "rejected",
      title: `${proposal.title} rejected`,
      detail: reasons.join(" · ") || "circuit returned 0",
      bits: bitText,
      allow: false,
    });
  }

  const next: LatchState = {
    ...withEval,
    usdt: round2(withEval.usdt - proposal.amount - fee),
    swept: round2(withEval.swept + proposal.amount),
    spentToday: round2(withEval.spentToday + proposal.amount),
    protocolEarned: round2(withEval.protocolEarned + fee),
  };
  return log(next, {
    at: now,
    kind: "executed",
    title: `${proposal.title} executed`,
    detail: `Container sent ${proposal.amount.toFixed(2)} USDT to savings. Fee ${fee.toFixed(2)} USDT.`,
    bits: bitText,
    allow: true,
  });
}

function driftPrice(price: number, rand: number): number {
  const pulled = price + (56 - price) * 0.08 + (rand - 0.5) * 1.6;
  const shocked = rand < 0.14 ? Math.min(pulled, 39 + rand * 10) : pulled;
  return round2(Math.min(78, Math.max(32, shocked)));
}

export function reduce(state: LatchState, action: Action): LatchState {
  switch (action.type) {
    case "hydrate":
      return action.state;
    case "connect":
      if (state.connected) return state;
      return log(
        { ...state, connected: true },
        {
          at: Date.now(),
          kind: "system",
          title: "Preview session",
          detail: "This wallet signs nothing. On X Layer the keeper only pays gas.",
        },
      );
    case "disconnect":
      return { ...state, connected: false, running: false };
    case "configure": {
      const next = { ...state, ...action.patch };
      if (action.patch.perTx !== undefined && Number.isFinite(action.patch.perTx)) {
        next.perTx = Math.max(1, action.patch.perTx);
      }
      if (action.patch.daily !== undefined && Number.isFinite(action.patch.daily)) {
        next.daily = Math.max(1, action.patch.daily);
      }
      if (action.patch.sweepAmount !== undefined && Number.isFinite(action.patch.sweepAmount)) {
        next.sweepAmount = Math.max(1, action.patch.sweepAmount);
      }
      if (action.patch.threshold !== undefined && Number.isFinite(action.patch.threshold)) {
        next.threshold = Math.max(1, action.patch.threshold);
      }
      return next;
    }
    case "fund":
      return log(
        { ...state, usdt: round2(state.usdt + action.amount) },
        {
          at: action.now,
          kind: "system",
          title: "Container funded",
          detail: `+${action.amount.toFixed(2)} USDT in the preview container.`,
        },
      );
    case "arm": {
      if (state.armed) return state;
      if (!state.connected) {
        return log(state, {
          at: action.now,
          kind: "system",
          title: "Connect first",
          detail: "Arming charges the container 5 USDT. Open a preview session so the charge has an owner.",
        });
      }
      if (state.usdt < ACTIVATION_USDT) {
        return log(state, {
          at: action.now,
          kind: "rejected",
          title: "Cannot arm",
          detail: "Activation is 5 USDT. Fund the container first.",
        });
      }
      return log(
        {
          ...state,
          armed: true,
          usdt: round2(state.usdt - ACTIVATION_USDT),
          protocolEarned: round2(state.protocolEarned + ACTIVATION_USDT),
        },
        {
          at: action.now,
          kind: "system",
          title: "Agent armed",
          detail: "5 USDT activation booked. You can start the daemon.",
        },
      );
    }
    case "start": {
      if (state.running) return state;
      if (!state.connected) {
        return log(state, {
          at: action.now,
          kind: "system",
          title: "Connect first",
          detail: "The daemon will not run without a session.",
        });
      }
      if (!state.armed) {
        return log(state, {
          at: action.now,
          kind: "system",
          title: "Arm the agent",
          detail: "Activation is 5 USDT (or 100 BEM on mainnet) before the daemon may tick.",
        });
      }
      return log(
        { ...state, running: true },
        {
          at: action.now,
          kind: "system",
          title: "Daemon started",
          detail: "Watching OKB. A dip at or under the threshold proposes a sweep. Restart-safe.",
        },
      );
    }
    case "stop":
      if (!state.running) return state;
      return log(
        { ...state, running: false },
        { at: action.now, kind: "system", title: "Daemon stopped", detail: "No new sweeps until you start it again." },
      );
    case "pause":
      if (state.paused) return state;
      return log(
        { ...state, paused: true },
        {
          at: action.now,
          kind: "system",
          title: "Circuit input paused = 1",
          detail: "The next proposal fails eval even if the price is through the floor.",
        },
      );
    case "resume":
      if (!state.paused) return state;
      return log(
        { ...state, paused: false },
        { at: action.now, kind: "system", title: "Pause cleared", detail: "paused input is 0 again." },
      );
    case "dip": {
      const marked = { ...state, price: 41, history: [...state.history, 41].slice(-28) };
      if (!state.running || !state.armed) {
        return log(marked, {
          at: action.now,
          kind: "trigger",
          title: "OKB marked at 41",
          detail: state.armed ? "Daemon is stopped, so nothing executed." : "Agent is not armed.",
        });
      }
      return applyProposal(
        marked,
        {
          kind: "sweep",
          amount: state.sweepAmount,
          target: state.savings,
          keeper: true,
          title: "Dip sweep",
        },
        action.now,
      );
    }
    case "rogue":
      return applyProposal(
        state,
        {
          kind: "transfer",
          amount: 500,
          target: ROGUE_TARGET,
          keeper: false,
          title: "Rogue transfer",
        },
        action.now,
      );
    case "reset":
      return log(
        {
          ...defaultState(),
          connected: state.connected,
          processor: state.processor,
          cpu: state.cpu,
          circuitId: state.circuitId,
          swept: 0,
          lastReceipt: null,
        },
        {
          at: action.now,
          kind: "system",
          title: "Demo reset",
          detail: "Balances, pause, and the feed were cleared. Circuit link kept.",
        },
      );
    case "tick": {
      if (!state.running) return state;
      const key = dayKey(action.now);
      let next = state.dayKey === key ? state : { ...state, dayKey: key, spentToday: 0 };
      const price = driftPrice(next.price, action.rand);
      next = {
        ...next,
        price,
        history: [...next.history, price].slice(-28),
        ticks: next.ticks + 1,
      };
      if (price > next.threshold) {
        if (next.ticks % 3 !== 0) return next;
        return log(next, {
          at: action.now,
          kind: "trigger",
          title: "Holding",
          detail: `OKB ${price.toFixed(2)} is above ${next.threshold.toFixed(2)}. No proposal.`,
        });
      }
      return applyProposal(
        next,
        {
          kind: "sweep",
          amount: next.sweepAmount,
          target: next.savings,
          keeper: true,
          title: "Dip sweep",
        },
        action.now,
      );
    }
    default:
      return state;
  }
}
