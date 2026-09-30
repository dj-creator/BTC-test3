import { create } from "zustand";

export type Sample = { t: number; px: number; origin?: "candle" };
export type FeedStatus = "connecting" | "live" | "delayed" | "reconnecting";

type LiveState = {
  price: number | null;
  tickAt: number | null;
  flash: "up" | "down" | null;
  status: FeedStatus;
  source: string;
  samples: Sample[];
  applyBatch: (batch: Sample[]) => void;
  seedHistory: (older: Sample[]) => void;
  setStatus: (status: FeedStatus) => void;
};

const KEEP_MS = 16 * 60_000;

export const useLive = create<LiveState>((set) => ({
  price: null,
  tickAt: null,
  flash: null,
  status: "connecting",
  source: "Coinbase BTC-USD",
  samples: [],
  applyBatch: (batch) => {
    if (!batch.length) return;
    batch = batch.filter((r) => Number.isFinite(r.t) && Number.isFinite(r.px) && r.px > 0).sort((a, b) => a.t - b.t);
    const last = batch[batch.length - 1];
    if (!last) return;
    set((state) => {
      if (state.tickAt != null && last.t < state.tickAt) return state;
      const cutoff = last.t - KEEP_MS;
      const kept = state.samples.filter((row) => row.t >= cutoff);
      const samples = kept.concat(batch.filter((r) => r.t >= (state.tickAt ?? 0))).sort((a, b) => a.t - b.t).slice(-12000);
      const flash =
        state.price == null || last.px === state.price ? null : last.px > state.price ? "up" : "down";
      return {
        price: last.px,
        tickAt: last.t,
        flash,
        samples,
        status: "live",
        source: "Coinbase BTC-USD",
      };
    });
  },
  seedHistory: (older) => {
    if (!older.length) return;
    set((state) => {
      const oldest = state.samples[0]?.t ?? Number.POSITIVE_INFINITY;
      const extra: Sample[] = older.filter((row) => row.t < oldest && row.px > 0).map((row) => ({ ...row, origin: "candle" as const }));
      if (!extra.length) return state;
      const cutoff = Date.now() - KEEP_MS;
      return { samples: extra.concat(state.samples).filter((row) => row.t >= cutoff).slice(-4000) };
    });
  },
  setStatus: (status) => set({ status }),
}));

export type FlowTrade = {
  id: string;
  t: number;
  px: number;
  btc: number;
  usd: number;
  taker: "buy" | "sell";
};

export type LiqPrint = {
  id: string;
  t: number;
  usd: number;
  side: "long-liq" | "short-liq";
};

type FlowState = {
  trades: FlowTrade[];
  liqs: LiqPrint[];
  liqStatus: "connecting" | "live" | "unavailable";
  addTrades: (rows: FlowTrade[]) => void;
  addLiq: (row: LiqPrint) => void;
  setLiqStatus: (status: FlowState["liqStatus"]) => void;
};

export const useFlow = create<FlowState>((set) => ({
  trades: [],
  liqs: [],
  liqStatus: "connecting",
  addTrades: (rows) => {
    if (!rows.length) return;
    set((state) => {
      const seen = new Set(state.trades.map((row) => row.id));
      const next = state.trades.concat(rows.filter((row) => !seen.has(row.id)));
      const cutoff = Date.now() - 60 * 60_000;
      return { trades: next.filter((row) => row.t >= cutoff).slice(-800) };
    });
  },
  addLiq: (row) =>
    set((state) => {
      if (state.liqs.some((item) => item.id === row.id)) return state;
      return {
        liqs: state.liqs.concat(row).filter((item) => item.t >= Date.now() - 60 * 60_000).slice(-80),
        liqStatus: "live",
      };
    }),
  setLiqStatus: (liqStatus) => set({ liqStatus }),
}));

export type BookView = {
  status: "connecting" | "live" | "unavailable";
  bidNear: number;
  askNear: number;
  imbalance: number | null;
  spread: number | null;
  updatedAt: number | null;
};

type BookState = BookView & { setBook: (next: BookView) => void };

export const useBook = create<BookState>((set) => ({
  status: "connecting",
  bidNear: 0,
  askNear: 0,
  imbalance: null,
  spread: null,
  updatedAt: null,
  setBook: (next) => set(next),
}));

const bids = new Map<number, number>();
const asks = new Map<number, number>();
let bookTimer: ReturnType<typeof setTimeout> | null = null;

function applyLevel(side: "buy" | "sell", price: number, size: number) {
  const book = side === "buy" ? bids : asks;
  if (size <= 0) book.delete(price);
  else book.set(price, size);
}

function summarizeBook() {
  bookTimer = null;
  const bestBid = bids.size ? Math.max(...bids.keys()) : null;
  const bestAsk = asks.size ? Math.min(...asks.keys()) : null;
  if (bestBid == null || bestAsk == null) {
    useBook.getState().setBook({
      status: "unavailable",
      bidNear: 0,
      askNear: 0,
      imbalance: null,
      spread: null,
      updatedAt: Date.now(),
    });
    return;
  }
  const mid = (bestBid + bestAsk) / 2;
  const band = mid * 0.0015;
  let bidNear = 0;
  let askNear = 0;
  for (const [px, sz] of bids) {
    if (px >= mid - band) bidNear += px * sz;
  }
  for (const [px, sz] of asks) {
    if (px <= mid + band) askNear += px * sz;
  }
  const total = bidNear + askNear;
  useBook.getState().setBook({
    status: "live",
    bidNear,
    askNear,
    imbalance: total > 0 ? (bidNear - askNear) / total : null,
    spread: bestAsk - bestBid,
    updatedAt: Date.now(),
  });
}

function queueBook() {
  if (bookTimer == null) bookTimer = setTimeout(summarizeBook, 200);
}

function onBookMessage(msg: {
  type?: string;
  bids?: [string, string][];
  asks?: [string, string][];
  changes?: [string, string, string][];
}) {
  if (msg.type === "snapshot") {
    bids.clear();
    asks.clear();
    for (const row of msg.bids ?? []) applyLevel("buy", Number(row[0]), Number(row[1]));
    for (const row of msg.asks ?? []) applyLevel("sell", Number(row[0]), Number(row[1]));
    queueBook();
    return;
  }
  if (msg.type === "l2update") {
    for (const change of msg.changes ?? []) {
      const side = change[0] === "buy" ? "buy" : "sell";
      applyLevel(side, Number(change[1]), Number(change[2]));
    }
    queueBook();
  }
}
const tradePending: FlowTrade[] = [];
let tradeFlush: ReturnType<typeof setTimeout> | null = null;
const seenTradeIds = new Set<string>();

function flushTrades() {
  tradeFlush = null;
  if (!tradePending.length) return;
  useFlow.getState().addTrades(tradePending.splice(0, tradePending.length));
}

export function pushMatch(msg: { price?: string; size?: string; side?: string; time?: string; trade_id?: number }) {
  const px = Number(msg.price);
  const btc = Number(msg.size);
  if (!Number.isFinite(px) || !Number.isFinite(btc) || px <= 0 || btc <= 0) return;
  const t = msg.time ? Date.parse(msg.time) : Date.now();
  const id = String(msg.trade_id ?? `${t}:${px}:${btc}`);
  if (seenTradeIds.has(id)) return;
  seenTradeIds.add(id);
  if (seenTradeIds.size > 4000) {
    for (const key of [...seenTradeIds].slice(0, 1000)) seenTradeIds.delete(key);
  }
  const taker: "buy" | "sell" = msg.side === "sell" ? "buy" : "sell";
  tradePending.push({ id, t: Number.isFinite(t) ? t : Date.now(), px, btc, usd: px * btc, taker });
  if (tradeFlush == null) tradeFlush = setTimeout(flushTrades, 250);
}

let users = 0;
let socket: WebSocket | null = null;
let retry = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let staleTimer: ReturnType<typeof setInterval> | null = null;
const pending: Sample[] = [];
let liqSocket: WebSocket | null = null;
let liqRetry = 0;
let liqTimer: ReturnType<typeof setTimeout> | null = null;

function flush() {
  flushTimer = null;
  if (!pending.length) return;
  useLive.getState().applyBatch(pending.splice(0, pending.length));
}

function pushTick(px: number, t: number) {
  if (!Number.isFinite(px) || px <= 0) return;
  const last = pending[pending.length - 1];
  if (last && last.px === px && t - last.t < 40) return;
  pending.push({ px, t: Number.isFinite(t) ? t : Date.now() });
  if (flushTimer == null) flushTimer = setTimeout(flush, 100);
}

function clearReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function scheduleReconnect() {
  if (users <= 0) return;
  clearReconnect();
  const wait = Math.min(10_000, 400 * 2 ** retry);
  retry += 1;
  useLive.getState().setStatus("reconnecting");
  reconnectTimer = setTimeout(connect, wait);
}

function connectLiq() {
  if (users <= 0) return;
  if (liqSocket && (liqSocket.readyState === WebSocket.OPEN || liqSocket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket("wss://fstream.binance.com/ws/btcusdt@forceOrder");
  liqSocket = ws;
  ws.onopen = () => {
    liqRetry = 0;
    useFlow.getState().setLiqStatus("live");
  };
  ws.onmessage = (event) => {
    let body: { o?: { S?: string; q?: string; p?: string; T?: number; ap?: string } };
    try {
      body = JSON.parse(String(event.data)) as typeof body;
    } catch {
      return;
    }
    const order = body.o;
    if (!order) return;
    const qty = Number(order.q);
    const px = Number(order.ap ?? order.p);
    if (!Number.isFinite(qty) || !Number.isFinite(px)) return;
    const usd = qty * px;
    if (usd < 50_000) return;
    useFlow.getState().addLiq({
      id: `${order.T ?? Date.now()}:${order.S}:${qty}`,
      t: order.T ?? Date.now(),
      usd,
      side: order.S === "SELL" ? "long-liq" : "short-liq",
    });
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (liqSocket === ws) liqSocket = null;
    if (users <= 0) return;
    useFlow.getState().setLiqStatus("unavailable");
    liqRetry += 1;
    liqTimer = setTimeout(connectLiq, Math.min(15_000, 500 * 2 ** liqRetry));
  };
}

function connect() {
  if (users <= 0) return;
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
  const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
  socket = ws;
  ws.onopen = () => {
    retry = 0;
    ws.send(
      JSON.stringify({
        type: "subscribe",
        product_ids: ["BTC-USD"],
        channels: ["matches", "ticker", "level2"],
      }),
    );
  };
  ws.onmessage = (event) => {
    let msg: {
      type?: string;
      price?: string;
      size?: string;
      side?: string;
      time?: string;
      trade_id?: number;
      bids?: [string, string][];
      asks?: [string, string][];
      changes?: [string, string, string][];
    };
    try {
      msg = JSON.parse(String(event.data)) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === "snapshot" || msg.type === "l2update") onBookMessage(msg);
    if (msg.type === "match") pushMatch(msg);
    if (msg.type !== "match" && msg.type !== "ticker" && msg.type !== "last_match") return;
    const px = Number(msg.price);
    const t = msg.time ? Date.parse(msg.time) : Date.now();
    pushTick(px, t);
  };
  ws.onerror = () => ws.close();
  ws.onclose = () => {
    if (socket === ws) socket = null;
    bids.clear();
    asks.clear();
    if (bookTimer) clearTimeout(bookTimer);
    bookTimer = null;
    useBook.getState().setBook({ status: "unavailable", bidNear: 0, askNear: 0, imbalance: null, spread: null, updatedAt: null });
    if (users > 0) scheduleReconnect();
  };
}

async function pollSpot() {
  const tickAt = useLive.getState().tickAt;
  if (tickAt && Date.now() - tickAt < 2_000) return;
  try {
    const res = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot", { cache: "no-store" });
    if (!res.ok) return;
    const body = (await res.json()) as { data?: { amount?: string } };
    const px = Number(body.data?.amount);
    pushTick(px, Date.now());
    useLive.getState().setStatus("live");
  } catch {
    if (!useLive.getState().tickAt) useLive.getState().setStatus("reconnecting");
  }
}

function watchStale() {
  const tickAt = useLive.getState().tickAt;
  const status = useLive.getState().status;
  if (tickAt && Date.now() - tickAt > 5_000 && status === "live") {
    useLive.getState().setStatus("delayed");
  }
}

export function startCoinbaseFeed() {
  users += 1;
  if (users === 1) {
    connect();
    connectLiq();
    pollTimer = setInterval(() => void pollSpot(), 1500);
    staleTimer = setInterval(watchStale, 1000);
    void pollSpot();
  }
  return () => {
    users -= 1;
    if (users > 0) return;
    users = 0;
    clearReconnect();
    if (pollTimer) clearInterval(pollTimer);
    if (staleTimer) clearInterval(staleTimer);
    if (flushTimer) clearTimeout(flushTimer);
    if (bookTimer) clearTimeout(bookTimer);
    bookTimer = null;
    bids.clear();
    asks.clear();
    pollTimer = null;
    staleTimer = null;
    flushTimer = null;
    if (liqTimer) clearTimeout(liqTimer);
    liqTimer = null;
    socket?.close();
    socket = null;
    liqSocket?.close();
    liqSocket = null;
  };
}

export function priceAgo(samples: Sample[], ms: number, now = Date.now()) {
  const target = now - ms;
  let prior: Sample | null = null;
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const row = samples[i];
    if (row && row.t <= target) {
      prior = row;
      break;
    }
  }
  // Candle seeding is minute resolution; do not fabricate second-resolution moves.
  const tolerance = ms < 60_000 ? 2000 : 65_000;
  return prior && !(ms < 60_000 && prior.origin === "candle") && target - prior.t <= tolerance ? prior : null;
}
