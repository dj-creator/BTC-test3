import type { FlowTrade, LiqPrint } from "./live";

export type WhaleEvent = {
  id: string;
  t: number;
  kind: "market-buy" | "market-sell" | "long-liq" | "short-liq";
  usd: number;
  note: string;
};

export type WhaleRead = {
  available: boolean;
  buyUsd: number;
  sellUsd: number;
  netUsd: number;
  score: number;
  label: "buyers" | "sellers" | "quiet" | "unusual";
  events: WhaleEvent[];
  sentence: string;
};

function percentile(sorted: number[], p: number) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx] ?? 0;
}

export function readWhales(trades: FlowTrade[], liqs: LiqPrint[], now = Date.now()): WhaleRead {
  const recent = trades.filter((row) => row.t >= now - 15 * 60_000);
  if (recent.length < 20 && liqs.length === 0) {
    return {
      available: false,
      buyUsd: 0,
      sellUsd: 0,
      netUsd: 0,
      score: 0,
      label: "quiet",
      events: [],
      sentence: "MARKET WHALE DATA UNAVAILABLE — not enough Coinbase prints yet.",
    };
  }
  const notionals = recent.map((row) => row.usd).sort((a, b) => a - b);
  const p95 = percentile(notionals, 0.95);
  const floor = Math.max(75_000, p95 * 3);
  const large = recent.filter((row) => row.usd >= floor);
  const buyUsd = large.filter((row) => row.taker === "buy").reduce((a, b) => a + b.usd, 0);
  const sellUsd = large.filter((row) => row.taker === "sell").reduce((a, b) => a + b.usd, 0);
  const windowLiqs = liqs.filter((row) => row.t >= now - 15 * 60_000 && row.usd >= Math.max(250_000, floor));
  const liqSell = windowLiqs.filter((row) => row.side === "long-liq").reduce((a, b) => a + b.usd, 0);
  const liqBuy = windowLiqs.filter((row) => row.side === "short-liq").reduce((a, b) => a + b.usd, 0);
  const net = buyUsd + liqBuy - (sellUsd + liqSell);
  const scale = Math.max(floor * 4, 1);
  const score = Math.max(-1, Math.min(1, Math.tanh(net / scale)));
  const events: WhaleEvent[] = [
    ...large.slice(-6).map((row) => ({
      id: row.id,
      t: row.t,
      kind: row.taker === "buy" ? ("market-buy" as const) : ("market-sell" as const),
      usd: row.usd,
      note: row.taker === "buy" ? "Aggressive Coinbase buy" : "Aggressive Coinbase sell",
    })),
    ...windowLiqs.slice(-4).map((row) => ({
      id: row.id,
      t: row.t,
      kind: row.side,
      usd: row.usd,
      note: row.side === "long-liq" ? "Forced long liquidation" : "Forced short liquidation",
    })),
  ]
    .sort((a, b) => b.t - a.t)
    .slice(0, 5);
  const abs = Math.abs(score);
  const label: WhaleRead["label"] =
    events.length === 0 ? "quiet" : abs < 0.25 ? "unusual" : score > 0 ? "buyers" : "sellers";
  const sentence =
    events.length === 0
      ? "No unusually large Coinbase trades in the last 15 minutes."
      : score > 0.2
        ? "Large Coinbase buys are bigger than large sells right now."
        : score < -0.2
          ? "Large Coinbase sells are bigger than large buys right now."
          : "Large prints showed up, but buy and sell size are close.";
  return { available: true, buyUsd, sellUsd, netUsd: net, score, label, events, sentence };
}

export function whaleAdjust(score: number, exceptional: boolean) {
  const cap = exceptional ? 0.05 : 0.03;
  return Math.max(-cap, Math.min(cap, score * 0.03));
}

export type XEvent = {
  id: string;
  t: number | null;
  kind: string;
  direction: "bullish" | "bearish" | "unknown";
  size: string | null;
  source: string;
  confidence: "low" | "medium" | "high";
  confirmed: false;
  note: string;
};

export type XPulse = {
  ok: boolean;
  checkedAt: number | null;
  error: string | null;
  tone: "positive" | "negative" | "quiet" | "event" | "unavailable";
  score: number;
  summary: string;
  events: XEvent[];
};

export const EMPTY_X: XPulse = {
  ok: false,
  checkedAt: null,
  error: null,
  tone: "unavailable",
  score: 0,
  summary: "DATA UNAVAILABLE",
  events: [],
};

const KEY = "btc-window-journal-v1";

export type JournalRow = {
  start: number;
  open: number;
  close: number;
  high: number;
  low: number;
  priceP: number | null;
  xAdj: number;
  whaleAdj: number;
  finalP: number | null;
  signal: "up" | "down" | "wait";
  verdict: "CORRECT" | "WRONG" | "WAIT";
};

export function loadJournal(): JournalRow[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    const rows = raw ? (JSON.parse(raw) as JournalRow[]) : [];
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

export function saveJournal(rows: JournalRow[]) {
  localStorage.setItem(KEY, JSON.stringify(rows.slice(0, 40)));
}
