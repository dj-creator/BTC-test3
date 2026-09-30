import type { Candle, FeedChoice, Snapshot } from "./types";

function synthCandles(anchor: number, nowSec: number): Candle[] {
  const out: Candle[] = [];
  let px = anchor - 40;
  for (let i = 120; i >= 0; i -= 1) {
    const drift = Math.sin(i / 7) * 8 + (i % 5) - 2;
    const o = px;
    const c = px + drift * 0.15;
    out.push({
      t: nowSec - i * 60,
      o,
      c,
      h: Math.max(o, c) + 6,
      l: Math.min(o, c) - 6,
    });
    px = c;
  }
  return out;
}

export function applyFeedChoice(base: Snapshot, choice: FeedChoice, now: number): Snapshot {
  if (choice === "live") return base;
  const spot = base.spot ?? 83570;
  const candles = base.candles.length >= 60 ? base.candles : synthCandles(spot, Math.floor(now / 1000));
  const market = base.market ?? {
    ticker: "KXBTC15M-DEMO",
    title: "BTC price up in next 15 mins?",
    status: "open",
    strike: Math.round(spot * 100) / 100,
    strikeRule: "greater_or_equal" as const,
    closeTime: now + 9 * 60_000 + 40_000,
    openTime: now - 5 * 60_000,
    yesBid: 0.48,
    yesAsk: 0.49,
    noBid: 0.51,
    noAsk: 0.52,
    volume: 240000,
    openInterest: 180000,
  };
  const next: Snapshot = {
    ...base,
    fetchedAt: now,
    spot,
    spotAt: now,
    spotSource: "Coinbase BTC/USD",
    bookAt: now,
    kalshiOk: true,
    kalshiError: null,
    market: { ...market },
    candles,
  };
  if (!next.market) return next;
  if (choice === "healthy") return next;
  if (choice === "kalshi-down") {
    return { ...next, market: null, kalshiOk: false, kalshiError: "Kalshi market feed unavailable", bookAt: null };
  }
  if (choice === "no-strike") {
    return { ...next, market: { ...next.market, strike: null } };
  }
  if (choice === "settlement") {
    return { ...next, market: { ...next.market, closeTime: now + 40_000, openTime: now - 14 * 60_000 } };
  }
  if (choice === "exact-touch") {
    return { ...next, spot: next.market.strike, spotAt: now, market: { ...next.market, strikeRule: "greater_or_equal" } };
  }
  if (choice === "stale-book") {
    return { ...next, bookAt: now - 90_000 };
  }
  if (choice === "negative-edge") {
    return { ...next, market: { ...next.market, yesAsk: 0.92, yesBid: 0.9, noAsk: 0.1, noBid: 0.08 } };
  }
  return { ...next, spotAt: now - 45_000 };
}
