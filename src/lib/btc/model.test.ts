import { test } from "node:test";
import assert from "node:assert/strict";
import { buildModel, completedCandles, fifteenMinuteWindows, normalCdf, realizedSigma } from "./model.ts";
import { captureForecast, settleForecasts, evaluationSummary, parseForecasts } from "./evaluation.ts";
import type { Candle, MarketQuote } from "./types.ts";

const start = 1_800_000_000;
const candles: Candle[] = Array.from({ length: 180 }, (_, i) => {
  const o = 100_000 + Math.sin(i / 3) * 60;
  const c = 100_000 + Math.sin((i + 1) / 3) * 60;
  return { t: start - (180 - i) * 60, o, c, h: Math.max(o, c) + 5, l: Math.min(o, c) - 5 };
});
const market: MarketQuote = { ticker: "TEST", title: "Test", status: "open", strike: 100000,
  strikeRule: "greater", openTime: start * 1000, closeTime: (start + 900) * 1000,
  yesBid: 0.49, yesAsk: 0.51, noBid: 0.49, noAsk: 0.51, volume: null, openInterest: null };
const now = start * 1000 + 30_000;
const input = { candles, market, now, spotAt: now, bookAt: now, spot: 100000, target: "spot" as const };

test("CDF is symmetric, monotonic and centered", () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1) + normalCdf(1) - 1) < 1e-6);
  assert.ok(normalCdf(2) > normalCdf(1));
});
test("completed history rejects future, open, malformed and duplicate candles", () => {
  const polluted = [...candles, candles[0]!, { ...candles[0]!, t: start, c: 1e9 }, { ...candles[0]!, t: start + 60 }, { ...candles[0]!, t: start - 20000, c: NaN }];
  assert.deepEqual(completedCandles(polluted, now), candles);
  assert.equal(buildModel({ ...input, candles: polluted }).pUp, buildModel(input).pUp);
});
test("continuous completed returns are required, partial windows excluded", () => {
  assert.ok(realizedSigma(candles));
  assert.equal(realizedSigma(candles.filter((_, i) => i !== 165)), null);
  assert.equal(fifteenMinuteWindows(candles.slice(1), undefined, now).length, 11);
  assert.equal(buildModel({ ...input, candles: candles.slice(0, 60) }).paused, true);
});
test("spot, target, stale history and expired windows pause with reasons", () => {
  for (const change of [{ spot: NaN }, { spotAt: now - 10001 }, { spotAt: null },
    { market: { ...market, strike: null } }, { market: { ...market, closeTime: now } },
    { market: { ...market, status: "closed" } }, { candles: candles.slice(0, -3) }]) {
    const result = buildModel({ ...input, ...change });
    assert.equal(result.paused, true, JSON.stringify(change));
    assert.ok(result.reason);
    assert.equal(result.pUp, null);
  }
});
test("higher price increases probability, tiny samples don't imply empirical calibration", () => {
  const low = buildModel({ ...input, spot: 99900 });
  const high = buildModel({ ...input, spot: 100100 });
  assert.ok(low.pUp! < 0.5);
  assert.ok(high.pUp! > 0.5);
  assert.ok(high.matches < 20);
  assert.equal(high.feeAware, null);
  assert.equal(high.call, "NO TRADE");
});
test("stale book and nonpositive edges never produce WATCH", () => {
  const result = buildModel({ ...input, target: "kalshi", bookAt: now - 30001, spot: 100100 });
  assert.equal(result.call, "NO TRADE");
  assert.equal(result.feeAware, null);
  const expensive = buildModel({ ...input, target: "kalshi", market: { ...market, yesAsk: 0.99, noAsk: 0.99 } });
  assert.equal(expensive.call, "NO TRADE");
});
test("final minute pauses official forecast without BRTI, spot target remains explicit", () => {
  const time = market.closeTime - 30000;
  const fresh = [...candles, ...Array.from({ length: 14 }, (_, i) => ({ ...candles[i]!, t: start + i * 60 }))];
  const last = { ...input, candles: fresh, now: time, spotAt: time };
  assert.equal(buildModel({ ...last, target: "kalshi" }).paused, true);
  assert.equal(buildModel(last).paused, false);
  assert.equal(buildModel(last).regime, "settlement-minute");
});
test("recording freezes once at T+30–60s, skips late visits", () => {
  const data = { now, start, pUp: 0.6, price: 100010, startPx: 100000 };
  assert.equal(captureForecast([], { ...data, now: now - 1 }).length, 0);
  assert.equal(captureForecast([], { ...data, now: start * 1000 + 60000 }).length, 0);
  const rows = captureForecast([], data);
  assert.equal(captureForecast(rows, { ...data, pUp: 0.9 }), rows);
  assert.equal(rows[0]!.pUp, 0.6);
});
test("settling requires final completed minute; exact touch is not above", () => {
  const rows = captureForecast([], { now, start, pUp: 0.6, price: 100010, startPx: 100000 });
  const final = { t: start + 840, o: 100000, c: 100000, h: 100001, l: 99999 };
  assert.equal(settleForecasts(rows, [final], (start + 899) * 1000), rows);
  assert.equal(settleForecasts(rows, [], (start + 900) * 1000), rows);
  const scored = settleForecasts(rows, [final], (start + 900) * 1000);
  assert.equal(scored[0]!.result, "WRONG");
  assert.equal(evaluationSummary(scored).brier, 0.36);
});
test("WAIT is included in probability scoring, old versions and corrupt storage excluded", () => {
  const rows = captureForecast([], { now, start, pUp: 0.5, price: 100000, startPx: 100000 });
  const scored = settleForecasts(rows, [{ t: start + 840, o: 100000, c: 100001, h: 100002, l: 99999 }], (start + 900) * 1000);
  const stats = evaluationSummary(scored);
  assert.equal(stats.count, 1);
  assert.equal(stats.directional, 0);
  assert.equal(stats.brier, 0.25);
  assert.equal(stats.buckets.reduce((n, b) => n + b.count, 0), 1);
  assert.deepEqual(parseForecasts(JSON.stringify(scored)), scored);
  assert.deepEqual(parseForecasts('{broken'), []);
  assert.deepEqual(parseForecasts(JSON.stringify([{ ...rows[0], version: "v1" }])), []);
});
