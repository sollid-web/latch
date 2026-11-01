import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { BriefPanel } from "@/components/latch/brief";
import { CircuitPanel } from "@/components/latch/circuit-panel";
import { OperatePanel } from "@/components/latch/operate";
import { shortAddr } from "@/components/latch/format";
import { tapeName } from "@/lib/latch/engine";
import { dispatch, useLatch } from "@/lib/latch/store";

const TABS = ["Operate", "Circuit", "Brief"] as const;
type Tab = (typeof TABS)[number];

export function LatchApp() {
  const state = useLatch();
  const [tab, setTab] = useState<Tab>("Operate");

  return (
    <div className="min-h-screen bg-bg text-fg">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-5xl items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-lg font-medium tracking-widest text-amber">LATCH</span>
              <span className="truncate font-mono text-xs text-muted">{tapeName(state)}</span>
            </div>
            <p className="truncate text-xs text-muted">Permissioned dip trade · X Layer 196</p>
          </div>
          <Link
            to="/status"
            className="hidden rounded-lg border border-line px-3 py-2 text-sm text-muted sm:inline"
          >
            Status
          </Link>
          <button
            type="button"
            onClick={() => dispatch({ type: state.connected ? "disconnect" : "connect" })}
            className="rounded-lg bg-amber px-3 py-2 text-sm font-medium text-ink"
          >
            {state.connected ? shortAddr("0x4E2a91c0b184A77e0c1d4e0a9C0b184A77e091c0") : "Connect"}
          </button>
        </div>
        <nav className="mx-auto flex max-w-5xl px-4" aria-label="Sections">
          {TABS.map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={
                "min-h-11 flex-1 border-b-2 text-sm font-medium " +
                (tab === item ? "border-amber text-fg" : "border-transparent text-muted")
              }
            >
              {item}
            </button>
          ))}
        </nav>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-6">
        {tab === "Operate" ? <OperatePanel state={state} /> : null}
        {tab === "Circuit" ? <CircuitPanel state={state} /> : null}
        {tab === "Brief" ? <BriefPanel state={state} /> : null}
      </main>
    </div>
  );
}
