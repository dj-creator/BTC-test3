import { completedCandles, MODEL_VERSION } from "./model.ts";
import type { Candle } from "./types";

export type ForecastRecord = {
  version: string;
  start: number;
  recordedAt: number;
  pUp: number;
  call: "YES" | "NO" | "WAIT";
  price: number;
  startPx: number;
  settledPx: number | null;
  result: "CORRECT" | "WRONG" | "WAIT" | null;
};

/** One fixed T+30–60s observation, frozen before the result. Late visits aren't backfilled. */
export function captureForecast(rows: ForecastRecord[], input: {
  now: number; start: number; pUp: number | null; price: number | null; startPx: number | null;
}): ForecastRecord[] {
  const { now, start, pUp, price, startPx } = input;
  const age = now - start * 1000;
  if (age < 30_000 || age >= 60_000 || rows.some((r) => r.start === start)) return rows;
  if (pUp == null || !Number.isFinite(pUp) || pUp < 0 || pUp > 1 || price == null || startPx == null || !Number.isFinite(price) || !Number.isFinite(startPx) || price <= 0 || startPx <= 0) return rows;
  const call: ForecastRecord["call"] = pUp >= 0.55 ? "YES" : pUp <= 0.45 ? "NO" : "WAIT";
  return [{ version: MODEL_VERSION, start, recordedAt: now, pUp, call, price, startPx, settledPx: null, result: null }, ...rows].slice(0, 1000);
}

/** Coinbase final candle close only; never represented as an official Kalshi settlement. */
export function settleForecasts(rows: ForecastRecord[], candles: Candle[], now: number) {
  const closes = new Map(completedCandles(candles, now).map((c) => [c.t, c.c]));
  let changed = false;
  const next = rows.map((row): ForecastRecord => {
    if (row.result != null || now < (row.start + 900) * 1000) return row;
    const close = closes.get(row.start + 840);
    if (close == null) return row;
    changed = true;
    const up = close > row.startPx; // Exact touch is not "above" for this spot-close target.
    const result = row.call === "WAIT" ? "WAIT" : (row.call === "YES") === up ? "CORRECT" : "WRONG";
    return { ...row, settledPx: close, result };
  });
  return changed ? next : rows;
}

export function evaluationSummary(records: ForecastRecord[]) {
  const rows = records.filter((r) => r.version === MODEL_VERSION && r.result != null && r.settledPx != null);
  const directional = rows.filter((r) => r.call !== "WAIT");
  const actual = (r: ForecastRecord) => r.settledPx! > r.startPx ? 1 : 0;
  const brier = rows.length ? rows.reduce((n, r) => n + (r.pUp - actual(r)) ** 2, 0) / rows.length : null;
  const logLoss = rows.length ? -rows.reduce((n, r) => {
    const p = Math.max(1e-6, Math.min(1 - 1e-6, r.pUp));
    return n + (actual(r) ? Math.log(p) : Math.log(1 - p));
  }, 0) / rows.length : null;
  return { count: rows.length, directional: directional.length,
    correct: directional.filter((r) => r.result === "CORRECT").length,
    waits: rows.length - directional.length, brier, logLoss,
    buckets: Array.from({ length: 5 }, (_, i) => {
      const bucket = rows.filter((r) => Math.min(4, Math.floor(r.pUp * 5)) === i);
      return { label: `${i * 20}–${(i + 1) * 20}%`, count: bucket.length,
        predicted: bucket.length ? bucket.reduce((n, r) => n + r.pUp, 0) / bucket.length : null,
        observed: bucket.length ? bucket.reduce((n, r) => n + actual(r), 0) / bucket.length : null };
    }) };
}

export function parseForecasts(raw: string | null): ForecastRecord[] {
  try {
    const rows: unknown = JSON.parse(raw ?? "[]");
    if (!Array.isArray(rows)) return [];
    const seen = new Set<number>();
    return rows.filter((r): r is ForecastRecord => {
      if (!r || r.version !== MODEL_VERSION || !Number.isFinite(r.start) || r.start % 900 !== 0 || seen.has(r.start)) return false;
      if (!Number.isFinite(r.recordedAt) || r.recordedAt < r.start * 1000 + 30_000 || r.recordedAt >= r.start * 1000 + 60_000) return false;
      if (![r.pUp, r.price, r.startPx].every(Number.isFinite) || r.pUp < 0 || r.pUp > 1 || r.price <= 0 || r.startPx <= 0) return false;
      const call = r.pUp >= 0.55 ? "YES" : r.pUp <= 0.45 ? "NO" : "WAIT";
      if (r.call !== call || ![null, "CORRECT", "WRONG", "WAIT"].includes(r.result)) return false;
      if (r.settledPx !== null && (!Number.isFinite(r.settledPx) || r.settledPx <= 0)) return false;
      if ((r.result === null) !== (r.settledPx === null)) return false;
      seen.add(r.start);
      return true;
    }).slice(0, 1000);
  } catch { return []; }
}
