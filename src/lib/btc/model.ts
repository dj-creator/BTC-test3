import type { Candle, MarketQuote, ModelView } from "./types";

export const MODEL_VERSION = "spot-close-v2";
const FEE = 0.02; // Explicit assumption per contract, not a fetched Kalshi fee schedule.
const BUFFER = 0.01;

/** Only closed, valid, unique one-minute observations may enter a forecast. */
export function completedCandles(candles: Candle[], now = Date.now()) {
  const rows = new Map<number, Candle>();
  for (const c of candles) {
    if (c.t % 60 !== 0 || c.t + 60 > now / 1000) continue;
    if (![c.t, c.o, c.h, c.l, c.c].every(Number.isFinite) || Math.min(c.o, c.h, c.l, c.c) <= 0) continue;
    if (c.h < Math.max(c.o, c.c) || c.l > Math.min(c.o, c.c)) continue;
    rows.set(c.t, c);
  }
  return [...rows.values()].sort((a, b) => a.t - b.t);
}

function continuous(rows: Candle[], count: number) {
  return rows.length === count && rows.every((c, i) => i === 0 || c.t - rows[i - 1]!.t === 60);
}

export function realizedSigma(candles: Candle[]) {
  const rows = candles.slice(-61);
  if (!continuous(rows, 61)) return null;
  const returns = rows.slice(1).map((c, i) => Math.log(c.c / rows[i]!.c));
  const variance = (values: number[]) => {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  };
  const perMin = Math.sqrt(0.75 * variance(returns) + 0.25 * variance(returns.slice(-15)));
  if (!Number.isFinite(perMin) || perMin < 1e-8) return null;
  return { perMin, sigma15: perMin * Math.sqrt(15) };
}

export function momentum5(candles: Candle[]) {
  const rows = candles.slice(-6);
  if (!continuous(rows, 6)) return null;
  return Math.log(rows[5]!.c / rows[0]!.c);
}

type WindowRow = { open: number; close: number; start: number };
export function fifteenMinuteWindows(candles: Candle[], excludeStart?: number, now = Date.now()): WindowRow[] {
  const buckets = new Map<number, Candle[]>();
  for (const c of completedCandles(candles, now)) {
    const start = Math.floor(c.t / 900) * 900;
    const list = buckets.get(start) ?? [];
    list.push(c);
    buckets.set(start, list);
  }
  return [...buckets].filter(([start, rows]) => start !== excludeStart && continuous(rows, 15))
    .map(([start, rows]) => ({ start, open: rows[0]!.o, close: rows[14]!.c }))
    .sort((a, b) => b.start - a.start);
}

// Standard normal CDF. A transparent diffusion baseline, not a calibrated probability.
export function normalCdf(z: number) {
  const x = Math.abs(z);
  const t = 1 / (1 + 0.2316419 * x);
  const tail = Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI) * t *
    (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/** Match features known at the same elapsed minute, never match on the eventual move. */
function analogs(candles: Candle[], start: number, elapsed: number, z: number, perMin: number) {
  const rows = fifteenMinuteWindows(candles, start, start * 1000).filter((w) => w.start + 900 <= start).slice(0, 50);
  let count = 0;
  let up = 0;
  for (const row of rows) {
    const at = row.start + elapsed * 60;
    const past = candles.filter((c) => c.t + 60 <= at);
    const vol = realizedSigma(past);
    const price = elapsed === 0 ? row.open : past[past.length - 1]?.c;
    if (!vol || price == null || (elapsed > 0 && past[past.length - 1]?.t !== at - 60)) continue;
    const ratio = vol.perMin / perMin;
    const priorZ = Math.log(price / row.open) / (vol.perMin * Math.sqrt(15 - elapsed));
    if (ratio < 0.5 || ratio > 2 || Math.abs(priorZ - z) > 0.5) continue;
    count += 1;
    if (row.close > row.open) up += 1;
  }
  return { count, rate: (up + 2) / (count + 4) };
}

export function buildModel(input: {
  candles: Candle[];
  spot: number | null;
  market: MarketQuote | null;
  now: number;
  forceNegative?: boolean;
  target?: "spot" | "kalshi";
  spotAt?: number | null;
  bookAt?: number | null;
}): ModelView {
  const { spot, market, now } = input;
  const candles = completedCandles(input.candles, now);
  const sigma = realizedSigma(candles);
  const mom = momentum5(candles);
  const strike = market?.strike;
  const tauMin = market ? (market.closeTime - now) / 60_000 : 0;
  const inSettle = tauMin > 0 && tauMin <= 1;
  const regime: ModelView["regime"] = inSettle ? "settlement-minute" :
    mom != null && sigma && Math.abs(mom) > sigma.sigma15 * 0.35 ? "trend" : "chop";
  const volLabel = !sigma ? "unknown vol" : sigma.sigma15 > 0.004 ? "elevated vol" : sigma.sigma15 < 0.0012 ? "quiet vol" : "normal vol";
  const base: ModelView = {
    paused: true, reason: null, pUp: null, yesAsk: market?.yesAsk ?? null, noAsk: market?.noAsk ?? null,
    modelMinusAsk: null, feeAware: null, afterBuffer: null, breakevenYes: null, matches: 0,
    volLabel, regime, call: "PAUSED", momentum: mom,
    sigmaDollar: sigma && spot ? spot * sigma.sigma15 : null, sigmaToStrike: null,
  };
  const age = input.spotAt == null ? null : now - input.spotAt;
  const reason = !Number.isFinite(now) ? "Invalid clock" :
    !market ? "No target: waiting for this window" :
    strike == null || !Number.isFinite(strike) || strike <= 0 ? "No strike / target" :
    spot == null || !Number.isFinite(spot) || spot <= 0 ? "No valid spot price" :
    age == null || age > 10_000 || age < -2_000 ? "Spot timestamp missing or stale (over 10 seconds)" :
    !Number.isFinite(tauMin) || tauMin <= 0 || now < market.openTime ? "Market is outside its active window" :
    !["open", "active"].includes(market.status) ? "Market is not open" :
    !sigma ? "Need 61 consecutive completed candles for 60 one-minute returns" :
    now / 1000 - (candles[candles.length - 1]!.t + 60) > 90 ? "Candle history is stale" :
    inSettle && input.target !== "spot" ? "Settlement minute: official BRTI prints unavailable" : null;
  if (reason || !sigma || !market || spot == null || strike == null) return { ...base, reason };

  const sigmaToStrike = Math.log(spot / strike) / (sigma.perMin * Math.sqrt(tauMin));
  const drift = 0.1 * (mom ?? 0) / 5 * Math.min(tauMin, 5);
  const diffusion = normalCdf((Math.log(spot / strike) + drift) / (sigma.perMin * Math.sqrt(tauMin)));
  const elapsed = Math.max(0, Math.min(14, Math.floor((now - market.openTime) / 60_000)));
  const matches = input.target === "spot" ? analogs(candles, market.openTime / 1000, elapsed, sigmaToStrike, sigma.perMin) : { count: 0, rate: 0.5 };
  const weight = matches.count >= 20 ? Math.min(0.25, matches.count / 200) : 0;
  const p = Math.max(0.02, Math.min(0.98, 0.5 + 0.85 * ((1 - weight) * diffusion + weight * matches.rate - 0.5)));
  const validAsk = (p: number | null) => p != null && Number.isFinite(p) && p > 0 && p < 1 ? p : null;
  const yesAsk = validAsk(input.forceNegative ? 0.9 : market.yesAsk);
  const noAsk = validAsk(market.noAsk);
  const bookFresh = input.bookAt != null && now - input.bookAt >= -2000 && now - input.bookAt <= 30_000;
  const comparable = input.target !== "spot" && bookFresh;
  const modelMinusAsk = comparable && yesAsk != null ? p - yesAsk : null;
  const feeAware = modelMinusAsk == null ? null : modelMinusAsk - FEE;
  const afterBuffer = feeAware == null ? null : feeAware - BUFFER;
  const noEdge = comparable && noAsk != null ? 1 - p - noAsk - FEE - BUFFER : null;
  const call: ModelView["call"] = afterBuffer != null && afterBuffer > 0 && afterBuffer >= (noEdge ?? -Infinity) ? "WATCH YES" :
    noEdge != null && noEdge > 0 ? "WATCH NO" : "NO TRADE";
  return { ...base, paused: false, pUp: p, sigmaToStrike, matches: matches.count, yesAsk, noAsk,
    modelMinusAsk, feeAware, afterBuffer, breakevenYes: comparable ? Math.max(0, p - FEE - BUFFER) : null, call,
    reason: input.target === "spot" ? "Spot-close proxy; no Kalshi fee edge is inferred" : !bookFresh ? "Stale or missing book timestamp" : call === "NO TRADE" ? "Missing asks or edge after assumed fees and buffer ≤ 0" : null };
}
