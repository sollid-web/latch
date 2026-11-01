export function shortAddr(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 12) return trimmed || "—";
  return `${trimmed.slice(0, 6)}…${trimmed.slice(-4)}`;
}

export function money(value: number): string {
  return value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function clock(at: number): string {
  if (!at) return "—";
  return new Date(at).toLocaleTimeString("en-GB", { hour12: false });
}
