import { create } from "zustand";
import { useLive } from "./live";

export type RadarSide = "up" | "down" | "flat";
export type RadarBias = "STRONG UP" | "UP" | "MIXED" | "DOWN" | "STRONG DOWN";
export type RadarStance = "CONFIRMING BTC" | "DISAGREEING WITH BTC" | "MIXED";

export type RadarCoin = {
  symbol: "BTC" | "ETH" | "SOL" | "XRP" | "BNB";
  side: RadarSide;
  s30: number | null;
  m1: number | null;
  m5: number | null;
};

export type RadarReading = {
  at: number;
  ready: boolean;
  bias: RadarBias;
  stance: RadarStance;
  upCount: number;
  coins: RadarCoin[];
};

const ALTS = ["ETH-USD", "SOL-USD", "XRP-USD", "BNB-USD"] as const;
const KEEP_MS = 6 * 60_000;
const FLAT = 0.00015;

type Sample = { t: number; px: number };

const series = new Map<string, Sample[]>();

function pushSample(symbol: string, px: number, t = Date.now()) {
  if (!Number.isFinite(px) || px <= 0) return;
  const rows = series.get(symbol) ?? [];
  const last = rows[rows.length - 1];
  if (last && t - last.t < 2_000 && Math.abs(px - last.px) / last.px < 0.00001) return;
  rows.push({ t, px });
  const cutoff = t - KEEP_MS;
  while (rows.length > 2 && rows[0]!.t < cutoff) rows.shift();
  series.set(symbol, rows);
}

function ago(symbol: string, ms: number, now: number) {
  const rows = series.get(symbol);
  if (!rows?.length) return null;
  const target = now - ms;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (row && row.t <= target) return row.px;
  }
  return null;
}

function ret(symbol: string, ms: number, now: number) {
  const rows = series.get(symbol);
  const last = rows?.[rows.length - 1];
  const prior = ago(symbol, ms, now);
  if (!last || prior == null || now - last.t > 20_000) return null;
  return (last.px - prior) / prior;
}

function sideOf(m1: number | null, s30: number | null): RadarSide {
  const v = m1 ?? s30;
  if (v == null) return "flat";
  if (v > FLAT) return "up";
  if (v < -FLAT) return "down";
  return "flat";
}

export function readRadar(now = Date.now()): RadarReading {
  const btc = useLive.getState().price;
  if (btc != null) pushSample("BTC", btc, now);
  const symbols = ["BTC", "ETH", "SOL", "XRP", "BNB"] as const;
  const coins: RadarCoin[] = symbols.map((symbol) => {
    const s30 = ret(symbol, 30_000, now);
    const m1 = ret(symbol, 60_000, now);
    const m5 = ret(symbol, 300_000, now);
    return { symbol, side: sideOf(m1, s30), s30, m1, m5 };
  });
  const known = coins.filter((c) => c.m1 != null || c.s30 != null);
  const ups = known.filter((c) => c.side === "up").length;
  const downs = known.filter((c) => c.side === "down").length;
  const bias: RadarBias =
    known.length < 3
      ? "MIXED"
      : ups >= 4
        ? "STRONG UP"
        : downs >= 4
          ? "STRONG DOWN"
          : ups >= 3 && ups > downs
            ? "UP"
            : downs >= 3 && downs > ups
              ? "DOWN"
              : "MIXED";
  const btcSide = coins[0]?.side ?? "flat";
  const others = known.filter((c) => c.symbol !== "BTC" && c.side !== "flat");
  const withBtc = others.filter((c) => c.side === btcSide).length;
  const against = others.length - withBtc;
  const stance: RadarStance =
    btcSide === "flat" || others.length < 2
      ? "MIXED"
      : withBtc >= 3 && withBtc > against
        ? "CONFIRMING BTC"
        : against >= 3 && against > withBtc
          ? "DISAGREEING WITH BTC"
          : "MIXED";
  return { at: now, ready: known.length >= 3, bias, stance, upCount: ups, coins };
}

type RadarState = { reading: RadarReading; tick: (now?: number) => void };
export const useRadar = create<RadarState>((set) => ({
  reading: readRadar(),
  tick: (now) => set({ reading: readRadar(now) }),
}));

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
let socket: WebSocket | null = null;

export function startRadar() {
  if (started || typeof window === "undefined") return;
  started = true;
  timer = setInterval(() => useRadar.getState().tick(), 2_000);
  const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  socket = ws;
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "subscribe", product_ids: [...ALTS], channels: ["ticker"] }));
  };
  ws.onmessage = (event) => {
    let msg: { type?: string; product_id?: string; price?: string };
    try {
      msg = JSON.parse(String(event.data)) as { type?: string; product_id?: string; price?: string };
    } catch {
      return;
    }
    if (msg.type !== "ticker" || !msg.product_id || !msg.price) return;
    const symbol = msg.product_id.slice(0, -4);
    pushSample(symbol, Number(msg.price));
  };
  ws.onclose = () => {
    socket = null;
    started = false;
    if (timer) clearInterval(timer);
    timer = null;
    window.setTimeout(startRadar, 3_000);
  };
}
