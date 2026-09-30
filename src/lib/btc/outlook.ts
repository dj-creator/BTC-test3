import { buildModel, fifteenMinuteWindows } from "./model.ts";
import type { Candle, MarketQuote } from "./types";

export type Signal = "up" | "down" | "wait";

export type Outlook = {
  signal: Signal;
  confidence: number | null;
  zone: string;
  sentences: string[];
  paused: boolean;
};

function zoneFor(confidencePct: number) {
  if (confidencePct < 55) return "No clear edge";
  if (confidencePct < 60) return "Slight lean";
  if (confidencePct < 70) return "Moderate model lean";
  return "Large model lean";
}

export function describeOutlook(input: {
  pUp: number | null;
  momentum: number | null;
  spot: number | null;
  start: number | null;
  paused: boolean;
  reason?: string | null;
}): Outlook {
  if (input.paused || input.pUp == null) {
    return {
      signal: "wait",
      confidence: null,
      zone: "Estimate paused",
      paused: true,
      sentences: [
        input.reason ?? "Valid price, target, and continuous history are required.",
        "Wait until the picture is clearer.",
      ],
    };
  }
  const up = input.pUp >= 0.5;
  const confidence = up ? input.pUp : 1 - input.pUp;
  const pct = confidence * 100;
  const signal: Signal = pct < 55 ? "wait" : up ? "up" : "down";
  const zone = zoneFor(pct);
  const sentences: string[] = [];
  if (input.momentum != null && input.momentum > 0.0004) {
    sentences.push("Bitcoin has been moving upward over the last few minutes.");
  } else if (input.momentum != null && input.momentum < -0.0004) {
    sentences.push("Bitcoin has been moving downward over the last few minutes.");
  } else {
    sentences.push("Bitcoin has been mostly flat over the last few minutes.");
  }
  if (input.spot != null && input.start != null) {
    const gap = input.spot - input.start;
    if (gap > 8) sentences.push("It is currently above the price where this 15-minute window started.");
    else if (gap < -8) sentences.push("It is currently below the price where this 15-minute window started.");
    else sentences.push("It is very close to the price where this 15-minute window started.");
  }
  if (signal === "wait") sentences.push("The advantage is too small to call, so this is a wait.");
  else if (pct >= 70) sentences.push("The lean is strong, but it is still not a sure thing.");
  else if (pct >= 60) sentences.push("The model leans this way; its probabilities have not been calibrated.");
  else sentences.push("The advantage is small, so this is not a strong signal.");
  return { signal, confidence, zone, paused: false, sentences: sentences.slice(0, 3) };
}

function marketAt(startSec: number, strike: number, asks?: MarketQuote | null): MarketQuote {
  return {
    ticker: asks?.ticker ?? "COINBASE-15M",
    title: "BTC higher or lower in 15 minutes",
    status: "open",
    strike,
    strikeRule: "greater_or_equal",
    openTime: startSec * 1000,
    closeTime: (startSec + 900) * 1000,
    yesBid: asks?.yesBid ?? null,
    yesAsk: asks?.yesAsk ?? null,
    noBid: asks?.noBid ?? null,
    noAsk: asks?.noAsk ?? null,
    volume: asks?.volume ?? null,
    openInterest: asks?.openInterest ?? null,
  };
}

export function outlookNow(input: {
  candles: Candle[];
  spot: number | null;
  start: number | null;
  windowStart: number;
  asks: MarketQuote | null;
  now: number;
  spotAt?: number | null;
}) {
  const model = buildModel({
    candles: input.candles,
    spot: input.spot,
    market: input.start != null ? marketAt(input.windowStart, input.start, null) : null,
    now: input.now,
    spotAt: input.spotAt,
    target: "spot",
  });
  return {
    model,
    outlook: describeOutlook({
      pUp: model.pUp,
      momentum: model.momentum,
      spot: input.spot,
      start: input.start,
      paused: model.paused,
      reason: model.reason,
    }),
  };
}

export type ScoredWindow = {
  start: number;
  open: number;
  close: number;
  move: number;
  verdict: "CORRECT" | "WRONG" | "WAIT";
};

export function scorePastWindows(candles: Candle[]): ScoredWindow[] {
  const nowSec = Math.floor(Date.now() / 1000);
  const current = Math.floor(nowSec / 900) * 900;
  const rows = fifteenMinuteWindows(candles).filter((row) => row.start < current);
  const scored: ScoredWindow[] = [];
  for (const row of rows) {
    if (scored.length >= 8) break;
    const hist = candles.filter((c) => c.t < row.start);
    const model = buildModel({
      candles: hist,
      spot: row.open,
      market: marketAt(row.start, row.open, null),
      now: row.start * 1000,
      spotAt: row.start * 1000,
      target: "spot",
    });
    const outlook = describeOutlook({
      pUp: model.pUp,
      momentum: model.momentum,
      spot: row.open,
      start: row.open,
      paused: model.paused,
      reason: model.reason,
    });
    const finishedUp = row.close > row.open;
    let verdict: ScoredWindow["verdict"] = "WAIT";
    if (outlook.signal === "up") verdict = finishedUp ? "CORRECT" : "WRONG";
    if (outlook.signal === "down") verdict = finishedUp ? "WRONG" : "CORRECT";
    scored.push({ start: row.start, open: row.open, close: row.close, move: row.close - row.open, verdict });
  }
  return scored;
}

export function momentumWord(delta: number | null) {
  if (delta == null) return "NEUTRAL";
  if (delta >= 40) return "STRONG UP";
  if (delta >= 12) return "UP";
  if (delta <= -40) return "STRONG DOWN";
  if (delta <= -12) return "DOWN";
  return "NEUTRAL";
}
