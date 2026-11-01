import { useEffect, useSyncExternalStore } from "react";
import { defaultState, reduce, type Action, type LatchState } from "@/lib/latch/engine";

const KEY = "latch.v1";
const SERVER: LatchState = defaultState();

let state: LatchState = SERVER;
const listeners = new Set<() => void>();
let timer: number | null = null;
let hydrated = false;

function emit() {
  for (const listener of listeners) listener();
}

function persist() {
  if (typeof window === "undefined") return;
  const { lastSignals: _ignored, ...stored } = state;
  window.localStorage.setItem(KEY, JSON.stringify(stored));
}

export function getState(): LatchState {
  return state;
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function stopTicker() {
  if (timer == null || typeof window === "undefined") return;
  window.clearInterval(timer);
  timer = null;
}

function ensureTicker() {
  if (typeof window === "undefined" || timer != null || !state.running) return;
  timer = window.setInterval(() => {
    dispatch({ type: "tick", now: Date.now(), rand: Math.random() });
  }, 4000);
}

export function dispatch(action: Action) {
  state = reduce(state, action);
  persist();
  emit();
  if (state.running) ensureTicker();
  else stopTicker();
}

export function hydrateLatch() {
  if (hydrated || typeof window === "undefined") return;
  hydrated = true;
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LatchState>;
      const next: LatchState = {
        ...defaultState(),
        ...parsed,
        lastSignals: null,
        logs: parsed.logs?.length ? parsed.logs : defaultState().logs,
      };
      if (next.running) {
        next.logs = [
          {
            id: `resume-${Date.now()}`,
            at: Date.now(),
            kind: "system" as const,
            title: "Daemon resumed",
            detail: "The listener came back after a reload and kept the last balances.",
          },
          ...next.logs,
        ].slice(0, 40);
      }
      state = next;
    }
  } catch {
    state = defaultState();
  }
  persist();
  emit();
  if (state.running) ensureTicker();
}

export function useLatch(): LatchState {
  const snapshot = useSyncExternalStore(subscribe, getState, () => SERVER);
  useEffect(() => {
    hydrateLatch();
  }, []);
  return snapshot;
}
