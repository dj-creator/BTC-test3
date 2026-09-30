import { test } from "node:test";
import assert from "node:assert/strict";
import { priceAgo, useLive } from "./live.ts";

test("minute candles are never treated as second-resolution price history", () => {
  const samples = [{ t: 99000, px: 100, origin: "candle" as const }];
  assert.equal(priceAgo(samples, 1000, 100000), null);
  assert.equal(priceAgo(samples, 60000, 159000)?.px, 100);
});
test("sparse observations beyond tolerance do not fabricate interval moves", () => {
  assert.equal(priceAgo([{ t: 1000, px: 100 }], 5000, 20000), null);
  assert.equal(priceAgo([{ t: 14500, px: 100 }], 5000, 20000)?.px, 100);
});
test("out-of-order batches cannot rewind the live price", () => {
  useLive.setState({ price: null, tickAt: null, samples: [] });
  useLive.getState().applyBatch([{ t: 2000, px: 102 }, { t: 1000, px: 101 }]);
  assert.equal(useLive.getState().price, 102);
  useLive.getState().applyBatch([{ t: 1500, px: 999 }]);
  assert.equal(useLive.getState().price, 102);
  useLive.getState().applyBatch([{ t: 3000, px: NaN }]);
  assert.equal(useLive.getState().price, 102);
});
