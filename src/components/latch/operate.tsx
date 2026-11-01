import { Activity, Pause, Play, Shield } from "lucide-react";
import { clock, money, shortAddr } from "@/components/latch/format";
import { INPUTS, evalPolicy } from "@/lib/latch/circuit";
import { ACTIVATION_USDT, policyBits, tapeName, type LatchState } from "@/lib/latch/engine";
import { dispatch } from "@/lib/latch/store";

const PASS_IF_ONE = [false, true, true, true, true, true, true];

export function OperatePanel({ state }: { state: LatchState }) {
  const now = () => Date.now();
  const max = Math.max(...state.history, 1);
  const listening = state.running && !state.paused;

  return (
    <div className="flex flex-col gap-6">
      <section className="grid gap-3 sm:grid-cols-3">
        <Stat label="Container USDT" value={money(state.usdt)} note={tapeName(state)} />
        <Stat label="Sent to savings" value={money(state.swept)} note={`Cap ${money(state.spentToday)} / ${money(state.daily)} today`} />
        <Stat
          label="Daemon"
          value={state.running ? (state.paused ? "Paused" : "Live") : state.armed ? "Armed" : "Off"}
          note={listening ? "Trades without a click" : `Arming fee ${ACTIVATION_USDT} USDT`}
        />
      </section>

      <section className="grid gap-4 lg:grid-cols-5">
        <div className="rounded-lg border border-line bg-surface p-4 lg:col-span-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs tracking-wide text-muted uppercase">OKB / USDT</p>
              <p className="mt-1 font-mono text-4xl text-fg">{state.price.toFixed(2)}</p>
              <p className="mt-1 text-sm text-muted">
                {listening
                  ? `Listening. A print at ${state.threshold.toFixed(2)} or lower fills itself.`
                  : `Trade when price is ${state.threshold.toFixed(2)} or lower. Start the listener to let it run.`}
              </p>
            </div>
            <Activity className={"mt-1 size-5 " + (listening ? "text-amber" : "text-muted")} aria-hidden="true" />
          </div>
          <div className="mt-4 flex h-16 items-end gap-1" aria-hidden="true">
            {state.history.map((point, index) => (
              <div
                key={`${point}-${index}`}
                className={"flex-1 rounded-sm " + (point <= state.threshold ? "bg-bad" : "bg-amber")}
                style={{ height: `${Math.max(12, (point / max) * 100)}%` }}
              />
            ))}
          </div>
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => dispatch({ type: "dip", now: now() })}
              className="min-h-11 rounded-lg bg-amber px-3 text-sm font-medium text-ink"
            >
              Inject dip
            </button>
            <button
              type="button"
              onClick={() => dispatch({ type: "rogue", now: now() })}
              className="min-h-11 rounded-lg border border-line bg-raised px-3 text-sm text-fg"
            >
              Rogue 500 USDT
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4 lg:col-span-2">
          <div className="flex items-center gap-2">
            <Shield className="size-4 text-amber" aria-hidden="true" />
            <h2 className="text-sm font-medium">Permissioned body</h2>
          </div>
          <p className="text-sm text-muted">
            LatchRelay is the only contract that can trade. It moves funds only when the circuit returns allow. The daemon pays gas and nothing else.
          </p>
          <p className="font-mono text-xs text-muted">
            Processor {state.processor.trim() ? shortAddr(state.processor) : "not linked yet"}
            <br />
            Circuit #{state.circuitId || "?"} · savings {shortAddr(state.savings)}
          </p>
          <p className="font-mono text-xs text-amber">Protocol booked {money(state.protocolEarned)} USDT</p>
          <div className="mt-auto grid grid-cols-2 gap-2">
            <button type="button" onClick={() => dispatch({ type: "fund", amount: 250, now: now() })} className="min-h-11 rounded-lg border border-line bg-raised text-sm text-fg">Fund 250</button>
            <button type="button" disabled={state.armed} onClick={() => dispatch({ type: "arm", now: now() })} className="min-h-11 rounded-lg border border-line bg-raised text-sm text-fg disabled:opacity-50">{state.armed ? "Armed" : "Arm · 5 USDT"}</button>
            <button type="button" onClick={() => dispatch({ type: state.running ? "stop" : "start", now: now() })} className="min-h-11 rounded-lg bg-amber text-sm font-medium text-ink"><span className="inline-flex items-center justify-center gap-2">{state.running ? <Pause className="size-4" /> : <Play className="size-4" />}{state.running ? "Stop" : "Start"}</span></button>
            <button type="button" onClick={() => dispatch({ type: state.paused ? "resume" : "pause", now: now() })} className="min-h-11 rounded-lg border border-line bg-raised text-sm text-fg">{state.paused ? "Unpause" : "Pause rule"}</button>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <PermissionCard state={state} />
        <ReceiptCard state={state} />
      </section>

      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium">Activity</h2>
          <span className="font-mono text-xs text-muted">{state.logs.length} events</span>
        </div>
        <ul className="divide-y divide-line">
          {state.logs.map((entry) => (
            <li key={entry.id} className="px-4 py-3">
              <div className="flex items-baseline justify-between gap-3">
                <p className={"text-sm font-medium " + (entry.kind === "executed" ? "text-amber" : entry.kind === "rejected" ? "text-bad" : "text-fg")}>{entry.title}</p>
                <time className="shrink-0 font-mono text-xs text-muted">{clock(entry.at)}</time>
              </div>
              <p className="mt-1 text-sm text-muted">{entry.detail}</p>
              {entry.bits ? <p className="mt-1 font-mono text-xs text-muted">bits {entry.bits} → {entry.allow ? "allow" : "deny"}</p> : null}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function PermissionCard({ state }: { state: LatchState }) {
  const next = { kind: "sweep" as const, amount: state.sweepAmount, target: state.savings, keeper: true, title: "Next trade" };
  const { bits } = policyBits(state, next);
  const { allow } = evalPolicy(bits);
  return (
    <div className="rounded-lg border border-line bg-surface">
      <div className="flex items-center justify-between border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium">Live permission</h2>
        <span className={"font-mono text-xs " + (allow ? "text-amber" : "text-bad")}>{allow ? "ALLOW" : "DENY"}</span>
      </div>
      <ul className="divide-y divide-line">
        {INPUTS.map((input, index) => {
          const pass = bits[index] === PASS_IF_ONE[index];
          return (
            <li key={input.name} className="flex items-center justify-between gap-3 px-4 py-2.5">
              <span className="text-sm text-fg">{input.name}</span>
              <span className={"font-mono text-xs " + (pass ? "text-amber" : "text-bad")}>{pass ? "pass" : "block"}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function ReceiptCard({ state }: { state: LatchState }) {
  const receipt = state.lastReceipt;
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <h2 className="text-sm font-medium">Last execution</h2>
      {receipt ? (
        <div className="mt-3 flex flex-col gap-2">
          <p className={"font-mono text-sm " + (receipt.allow ? "text-amber" : "text-bad")}>{receipt.allow ? "Filled" : "Reverted"} · {receipt.source}</p>
          <p className="text-sm text-muted">{receipt.allow ? `${money(receipt.amount)} USDT left the container. Fee ${money(receipt.fee)}.` : receipt.reasons.join(" · ") || "Circuit returned 0."}</p>
          <p className="break-all font-mono text-xs text-muted">{receipt.call}</p>
          <p className="font-mono text-xs text-muted">bits {receipt.bits} · {clock(receipt.at)}</p>
          <p className="text-xs text-muted">Preview receipt. LatchRelay sends this on X Layer only after you deploy.</p>
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">Nothing has been proposed. Arm, start, and wait. If OKB trades through the floor, the listener calls tick on its own. Inject dip is only for the camera.</p>
      )}
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-4 py-3">
      <p className="text-xs tracking-wide text-muted uppercase">{label}</p>
      <p className="mt-1 font-mono text-xl text-fg">{value}</p>
      <p className="mt-1 truncate text-xs text-muted">{note}</p>
    </div>
  );
}
