import { readWhales } from "./intel";
import { priceAgo, type BookView, type FlowTrade, type LiqPrint, type Sample } from "./live";

export type Lean = "yes" | "no" | "wait";

export type Pulse = {
  moves: { label: string; ms: number; delta: number | null }[];
  accel: "up" | "down" | "flat" | "reversal";
  accelText: string;
  buyPct: number | null;
  flowText: string;
  bookText: string;
  bookLean: "yes" | "no" | "wait";
  whaleText: string;
  regime: string;
  vol: "LOW" | "NORMAL" | "HIGH" | "EXTREME" | "UNKNOWN";
  reversal: "LOW" | "MEDIUM" | "HIGH" | "UNKNOWN";
  vwapSide: "above" | "below" | "unknown";
  alignment: { label: string; lean: Lean }[];
  yesCount: number;
};

function deltaAt(samples: Sample[], ms: number, price: number | null, now: number) {
  if (price == null) return null;
  const prior = priceAgo(samples, ms, now);
  if (!prior) return null;
  return price - prior.px;
}

export function readPulse(input: {
  price: number | null;
  samples: Sample[];
  trades: FlowTrade[];
  liqs: LiqPrint[];
  book: BookView;
  start: number | null;
  now?: number;
}): Pulse {
  const now = input.now ?? Date.now();
  const spans = [
    ["5 SEC", 5_000],
    ["30 SEC", 30_000],
    ["1 MIN", 60_000],
    ["3 MIN", 180_000],
    ["5 MIN", 300_000],
    ["15 MIN", 900_000],
  ] as const;
  const moves = spans.map(([label, ms]) => ({ label, ms, delta: deltaAt(input.samples, ms, input.price, now) }));
  const d30 = moves[1]?.delta ?? null;
  const d60 = moves[2]?.delta ?? null;
  const d180 = moves[3]?.delta ?? null;
  let accel: Pulse["accel"] = "flat";
  let accelText = "FLAT";
  if (d30 != null && d60 != null && d180 != null) {
    const flip = Math.sign(d30) !== 0 && Math.sign(d180) !== 0 && Math.sign(d30) !== Math.sign(d180);
    if (flip && Math.abs(d30) > 8) {
      accel = "reversal";
      accelText = "REVERSAL POSSIBLE";
    } else if (Math.abs(d60) < 6 && Math.abs(d180) < 12) {
      accel = "flat";
      accelText = "FLAT";
    } else if (Math.sign(d30) === Math.sign(d60) && Math.abs(d30) > Math.abs(d60 - d30) * 1.15) {
      accel = d60 > 0 ? "up" : "down";
      accelText = d60 > 0 ? "ACCELERATING UP" : "ACCELERATING DOWN";
    } else {
      accel = d60 > 0 ? "up" : "down";
      accelText = d60 > 0 ? "UP, SLOWING" : "DOWN, SLOWING";
    }
  }
  const recent = input.trades.filter((row) => row.t >= now - 60_000);
  const buy = recent.filter((row) => row.taker === "buy").reduce((a, b) => a + b.usd, 0);
  const sell = recent.filter((row) => row.taker === "sell").reduce((a, b) => a + b.usd, 0);
  const flowTotal = buy + sell;
  const buyPct = flowTotal > 5_000 && recent.length >= 8 ? buy / flowTotal : null;
  const flowText = buyPct == null ? "DATA UNAVAILABLE" : buyPct >= 0.56 ? "BUYERS IN CONTROL" : buyPct <= 0.44 ? "SELLERS IN CONTROL" : "BALANCED";
  const bookLean: Lean =
    input.book.status !== "live" || input.book.updatedAt == null || now - input.book.updatedAt > 5000 || input.book.imbalance == null ? "wait" : input.book.imbalance > 0.12 ? "yes" : input.book.imbalance < -0.12 ? "no" : "wait";
  const bookText =
    input.book.status !== "live" || input.book.imbalance == null
      ? "DATA UNAVAILABLE"
      : bookLean === "yes"
        ? "BUY PRESSURE"
        : bookLean === "no"
          ? "SELL PRESSURE"
          : "BALANCED";
  const whales = readWhales(input.trades, input.liqs, now);
  const whaleText = !whales.available ? "DATA UNAVAILABLE" : whales.label === "buyers" ? "BUY FLOW" : whales.label === "sellers" ? "SELL FLOW" : "QUIET";
  const d15 = moves[5]?.delta ?? null;
  const abs15 = d15 == null ? 0 : Math.abs(d15);
  const regime =
    d15 == null ? "UNKNOWN" : abs15 > 180 ? (d15 != null && d15 > 0 ? "TRENDING UP" : "TRENDING DOWN") : abs15 < 25 ? "QUIET" : abs15 < 70 ? "RANGE / CHOP" : "TRANSITION";
  const vol: Pulse["vol"] = d15 == null ? "UNKNOWN" : abs15 > 280 ? "EXTREME" : abs15 > 140 ? "HIGH" : abs15 < 20 ? "LOW" : "NORMAL";
  const priceUp = input.price != null && input.start != null ? input.price - input.start > 8 : d60 != null && d60 > 8;
  const priceDown = input.price != null && input.start != null ? input.price - input.start < -8 : d60 != null && d60 < -8;
  const disagree =
    (priceUp && ((buyPct != null && buyPct < 0.42) || bookLean === "no" || accel === "reversal")) ||
    (priceDown && ((buyPct != null && buyPct > 0.58) || bookLean === "yes" || accel === "reversal"));
  const reversal: Pulse["reversal"] = input.price == null ? "UNKNOWN" : disagree && vol === "HIGH" ? "HIGH" : disagree ? "MEDIUM" : "LOW";
  const vwapTrades = input.trades.filter((row) => row.t >= now - 15 * 60_000);
  const notion = vwapTrades.reduce((a, b) => a + b.btc, 0);
  const vwap = notion > 0 ? vwapTrades.reduce((a, b) => a + b.px * b.btc, 0) / notion : null;
  const vwapSide: Pulse["vwapSide"] =
    vwap == null || input.price == null ? "unknown" : input.price >= vwap ? "above" : "below";
  const priceLean: Lean = input.price == null || input.start == null ? "wait" : input.price - input.start > 8 ? "yes" : input.price - input.start < -8 ? "no" : "wait";
  const momLean: Lean = d60 == null ? "wait" : d60 > 8 ? "yes" : d60 < -8 ? "no" : "wait";
  const flowLean: Lean = buyPct == null ? "wait" : buyPct >= 0.56 ? "yes" : buyPct <= 0.44 ? "no" : "wait";
  const whaleLean: Lean = !whales.available ? "wait" : whales.score > 0.2 ? "yes" : whales.score < -0.2 ? "no" : "wait";
  const revLean: Lean = reversal === "LOW" ? priceLean : reversal === "UNKNOWN" ? "wait" : priceLean === "yes" ? "no" : priceLean === "no" ? "yes" : "wait";
  const alignment = [
    { label: "Price", lean: priceLean },
    { label: "Momentum", lean: momLean },
    { label: "Buyers", lean: flowLean },
    { label: "Order Book", lean: bookLean },
    { label: "Large Trades", lean: whaleLean },
    { label: "Reversal", lean: revLean },
  ];
  return {
    moves,
    accel,
    accelText,
    buyPct,
    flowText,
    bookText,
    bookLean,
    whaleText,
    regime,
    vol,
    reversal,
    vwapSide,
    alignment,
    yesCount: alignment.filter((row) => row.lean === "yes").length,
  };
}
