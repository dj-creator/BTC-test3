import { createServerFn } from "@tanstack/react-start";
import type { Candle, MarketQuote, SettledWindow, Snapshot, StrikeRule } from "./types";

type KalshiMarket = {
  ticker?: string;
  title?: string;
  status?: string;
  floor_strike?: number | null;
  strike_type?: string;
  close_time?: string;
  open_time?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  volume_fp?: string;
  open_interest_fp?: string;
};

let kalshiCache: { at: number; market: MarketQuote | null; error: string | null } | null = null;
let candleCache: { at: number; candles: Candle[] } | null = null;
let dayCache: { at: number; candles: Candle[] } | null = null;
let historyCache: { at: number; rows: SettledWindow[] } | null = null;

function dollars(v: string | undefined) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ruleOf(strikeType: string | undefined): StrikeRule {
  if (strikeType === "greater_or_equal") return "greater_or_equal";
  if (strikeType === "greater") return "greater";
  return "unknown";
}

async function fetchKalshi(): Promise<{ market: MarketQuote | null; error: string | null; at: number }> {
  const now = Date.now();
  if (kalshiCache && now - kalshiCache.at < 10_000) {
    return { market: kalshiCache.market, error: kalshiCache.error, at: kalshiCache.at };
  }
  try {
    const res = await fetch(
      "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=open&limit=5",
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`Kalshi ${res.status}`);
    const body = (await res.json()) as { markets?: KalshiMarket[] };
    const markets = body.markets ?? [];
    const open = markets
      .map((m) => ({ m, close: Date.parse(m.close_time ?? ""), openAt: Date.parse(m.open_time ?? "") }))
      .filter((x) => Number.isFinite(x.close) && x.openAt <= now && x.close > now)
      .sort((a, b) => a.close - b.close);
    const picked = open[0]?.m;
    if (!picked) {
      kalshiCache = { at: now, market: null, error: "No open 15-minute market" };
      return { market: null, error: kalshiCache.error, at: now };
    }
    const market: MarketQuote = {
      ticker: picked.ticker ?? "KXBTC15M",
      title: picked.title ?? "BTC price up in next 15 mins?",
      status: picked.status === "active" ? "open" : (picked.status ?? "open"),
      strike: typeof picked.floor_strike === "number" ? picked.floor_strike : null,
      strikeRule: ruleOf(picked.strike_type),
      closeTime: Date.parse(picked.close_time ?? ""),
      openTime: Date.parse(picked.open_time ?? ""),
      yesBid: dollars(picked.yes_bid_dollars),
      yesAsk: dollars(picked.yes_ask_dollars),
      noBid: dollars(picked.no_bid_dollars),
      noAsk: dollars(picked.no_ask_dollars),
      volume: dollars(picked.volume_fp),
      openInterest: dollars(picked.open_interest_fp),
    };
    kalshiCache = { at: now, market, error: null };
    return { market, error: null, at: now };
  } catch (err) {
    const error = err instanceof Error ? err.message : "Kalshi unavailable";
    kalshiCache = { at: now, market: null, error };
    return { market: null, error, at: now };
  }
}

async function fetchGranularity(seconds: number, keep: number, end?: number): Promise<Candle[]> {
  const res = await fetch(
    `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${seconds}${end == null ? "" : `&start=${new Date((end - seconds * keep) * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`}`,
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`Candles ${res.status}`);
  const rows = (await res.json()) as number[][];
  return rows
    .map((row) => ({
      t: row[0] ?? 0,
      l: row[1] ?? 0,
      h: row[2] ?? 0,
      o: row[3] ?? 0,
      c: row[4] ?? 0,
    }))
    .filter((c) => c.t > 0 && c.c > 0)
    .sort((a, b) => a.t - b.t)
    .slice(-keep);
}

async function fetchCandles(): Promise<Candle[]> {
  const now = Date.now();
  if (candleCache && now - candleCache.at < 30_000) return candleCache.candles;
  const recent = await fetchGranularity(60, 300);
  let older = candleCache?.candles ?? [];
  // Bootstrap enough prior windows for matching; reuse the overlap on subsequent polls.
  if (older.length === 0 && recent.length) {
    const end = recent[0]!.t;
    const pages = await Promise.allSettled([fetchGranularity(60, 300, end), fetchGranularity(60, 300, end - 18_000)]);
    older = pages.flatMap((page) => page.status === "fulfilled" ? page.value : []);
  }
  const merged = new Map([...older, ...recent].map((c) => [c.t, c]));
  const candles = [...merged.values()].sort((a, b) => a.t - b.t).slice(-900);
  candleCache = { at: now, candles };
  return candles;
}

async function fetchDayCandles(): Promise<Candle[]> {
  const now = Date.now();
  if (dayCache && now - dayCache.at < 60_000) return dayCache.candles;
  const candles = await fetchGranularity(300, 300);
  dayCache = { at: now, candles };
  return candles;
}

async function fetchHistory(): Promise<SettledWindow[]> {
  const now = Date.now();
  if (historyCache && now - historyCache.at < 30_000) return historyCache.rows;
  const res = await fetch(
    "https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=KXBTC15M&status=settled&limit=12",
    { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`Kalshi history ${res.status}`);
  const body = (await res.json()) as {
    markets?: {
      ticker?: string;
      result?: string;
      floor_strike?: number | null;
      expiration_value?: string;
      open_time?: string;
      close_time?: string;
      volume_fp?: string;
    }[];
  };
  const rows = (body.markets ?? [])
    .map((m): SettledWindow => {
      const result = m.result === "yes" || m.result === "no" ? m.result : "unknown";
      const settle = Number(m.expiration_value);
      const volume = Number(m.volume_fp);
      return {
        ticker: m.ticker ?? "",
        openTime: Date.parse(m.open_time ?? ""),
        closeTime: Date.parse(m.close_time ?? ""),
        strike: typeof m.floor_strike === "number" ? m.floor_strike : null,
        settle: Number.isFinite(settle) ? settle : null,
        result,
        volume: Number.isFinite(volume) ? volume : null,
      };
    })
    .filter((row) => row.result !== "unknown" && Number.isFinite(row.closeTime))
    .sort((a, b) => b.closeTime - a.closeTime)
    .slice(0, 10);
  historyCache = { at: now, rows };
  return rows;
}

async function fetchSpot(): Promise<number | null> {
  const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", {
    headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Spot ${res.status}`);
  const body = (await res.json()) as { data?: { amount?: string } };
  const n = Number(body.data?.amount);
  return Number.isFinite(n) ? n : null;
}

export const getSnapshot = createServerFn({ method: "GET" }).handler(async (): Promise<Snapshot> => {
  const fetchedAt = Date.now();
  const [spotResult, kalshi, candleResult, dayResult, history] = await Promise.all([
    fetchSpot().then(
      (spot) => ({ spot, error: null as string | null }),
      (err: unknown) => ({ spot: null, error: err instanceof Error ? err.message : "Spot unavailable" }),
    ),
    fetchKalshi(),
    fetchCandles().then(
      (candles) => ({ candles, error: null as string | null }),
      () => ({ candles: [] as Candle[], error: "Candles unavailable" }),
    ),
    fetchDayCandles().then(
      (candles) => candles,
      () => [] as Candle[],
    ),
    fetchHistory().then(
      (rows) => rows,
      () => [] as SettledWindow[],
    ),
  ]);
  return {
    fetchedAt,
    spot: spotResult.spot,
    spotAt: spotResult.spot == null ? null : fetchedAt,
    spotSource: "Coinbase BTC/USD",
    bookAt: kalshi.market ? kalshi.at : null,
    kalshiOk: kalshi.error == null && kalshi.market != null,
    kalshiError: kalshi.error ?? spotResult.error ?? candleResult.error,
    market: kalshi.market,
    candles: candleResult.candles,
    dayCandles: dayResult,
    history,
  };
});
