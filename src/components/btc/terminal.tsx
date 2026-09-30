import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { startCoinbaseFeed, useBook, useFlow, useLive, priceAgo, type BookView, type FlowTrade, type LiqPrint } from "@/lib/btc/live";
import { outlookNow } from "@/lib/btc/outlook";
import { readPulse, type Lean } from "@/lib/btc/pulse";
import { readWhales } from "@/lib/btc/intel";
import { getSnapshot } from "@/lib/btc/snapshot";
import { startRadar, useRadar, type RadarReading } from "@/lib/btc/radar";
import type { Candle, SettledWindow, Snapshot } from "@/lib/btc/types";
import { PriceChart } from "./chart";

import { captureForecast, settleForecasts, evaluationSummary, parseForecasts, type ForecastRecord } from "@/lib/btc/evaluation";

const STORE = "btc-window-frozen-v2";

type Frozen = ForecastRecord;

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function signed(n: number | null) {
  if (n == null || Number.isNaN(n)) return "—";
  const abs = Math.abs(n).toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(n) < 0.005) return "$0.00";
  return `${n > 0 ? "+" : "−"}${abs}`;
}

function compact(n: number) {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

function windowStartSec(now = Date.now()) {
  return Math.floor(now / 1000 / 900) * 900;
}

function startPrice(candles: Candle[], start: number) {
  const exact = candles.find((c) => c.t === start);
  if (exact) return exact.o;
  const inside = candles.find((c) => c.t >= start && c.t < start + 60);
  return inside?.o ?? null;
}

function withLiveCandle(candles: Candle[], px: number | null, nowSec: number) {
  const from = windowStartSec(nowSec * 1000);
  let pool = candles.filter((c) => c.t >= from && c.t < from + 900);
  if (pool.length < 2) pool = candles.filter((c) => c.t >= from - 900).slice(-16);
  if (pool.length < 2) pool = candles.slice(-16);
  if (px == null || pool.length === 0) return pool;
  const bucket = Math.floor(nowSec / 60) * 60;
  const last = pool[pool.length - 1];
  if (!last) return pool;
  if (last.t === bucket) {
    const next = pool.slice();
    next[next.length - 1] = { ...last, c: px, h: Math.max(last.h, px), l: Math.min(last.l, px) };
    return next;
  }
  if (bucket > last.t) return [...pool, { t: bucket, o: last.c, h: Math.max(last.c, px), l: Math.min(last.c, px), c: px }];
  return pool;
}

function leanMark(lean: Lean) {
  if (lean === "yes") return "▲ YES";
  if (lean === "no") return "▼ NO";
  return "— WAIT";
}

function leanClass(lean: Lean | "warn") {
  if (lean === "yes") return "text-up";
  if (lean === "no") return "text-down";
  if (lean === "warn") return "text-warn";
  return "text-muted";
}

function loadFrozen(): Frozen[] {
  try {
    return parseForecasts(localStorage.getItem(STORE));
  } catch {
    return [];
  }
}

function saveFrozen(rows: Frozen[]) {
  try { localStorage.setItem(STORE, JSON.stringify(rows)); return true; }
  catch { return false; }
}

export function Terminal({ initial }: { initial: Snapshot }) {
  const query = useQuery({
    queryKey: ["btc-snapshot"],
    queryFn: () => getSnapshot(),
    initialData: initial,
    refetchInterval: 10_000,
  });
  const [spot, setSpot] = useState<number | null>(initial.spot);
  const [spotAt, setSpotAt] = useState<number | null>(initial.spotAt);
  const [storageOk, setStorageOk] = useState(true);
  const [flow, setFlow] = useState<{ trades: FlowTrade[]; liqs: LiqPrint[]; book: BookView }>({
    trades: [],
    liqs: [],
    book: { status: "connecting", bidNear: 0, askNear: 0, imbalance: null, spread: null, updatedAt: null },
  });
  const [win, setWin] = useState(() => windowStartSec(initial.fetchedAt));
  const [now, setNow] = useState<number | null>(null);
  const [frozen, setFrozen] = useState<Frozen[]>([]);
  const [core, setCore] = useState(false);
  const [marketDetails, setMarketDetails] = useState(false);
  const [tvInterval, setTvInterval] = useState("off");
  const [kalshiPath, setKalshiPath] = useState<{ t: number; yes: number }[]>([]);
  const candles = query.data.candles;
  const dayCandles = query.data.dayCandles ?? [];
  const start = startPrice(candles, win);
  const currentMarket = query.data.market;
  const marketMatches = currentMarket != null && currentMarket.openTime <= (now ?? initial.fetchedAt) && currentMarket.closeTime > (now ?? initial.fetchedAt) && Math.abs(currentMarket.closeTime / 1000 - win - 900) < 1;
  const bookFresh = query.data.bookAt != null && (now ?? initial.fetchedAt) - query.data.bookAt >= -2000 && (now ?? initial.fetchedAt) - query.data.bookAt <= 30_000;

  useEffect(() => startCoinbaseFeed(), []);
  useEffect(() => startRadar(), []);
  useEffect(() => setFrozen(loadFrozen()), []);
  useEffect(() => {
    if (!candles.length) return;
    useLive.getState().seedHistory(candles.filter((c) => (c.t + 60) * 1000 <= Date.now()).slice(-20).map((c) => ({ t: c.t * 1000 + 59_000, px: c.c })));
  }, [candles]);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => {
      const live = useLive.getState();
      const book = useBook.getState();
      const useStream = (live.tickAt ?? 0) >= (query.data.spotAt ?? 0);
      setSpot(useStream ? live.price : query.data.spot);
      setSpotAt(useStream ? live.tickAt : query.data.spotAt);
      setFlow({
        trades: useFlow.getState().trades,
        liqs: useFlow.getState().liqs,
        book: {
          status: book.status,
          bidNear: book.bidNear,
          askNear: book.askNear,
          imbalance: book.imbalance,
          spread: book.spread,
          updatedAt: book.updatedAt,
        },
      });
      setNow(Date.now());
      const next = windowStartSec();
      setWin((prev) => (prev === next ? prev : next));
    }, 1000);
    return () => window.clearInterval(id);
  }, [query.data.spot, query.data.spotAt]);

  useEffect(() => {
    if (query.data.spotAt != null && (useLive.getState().tickAt ?? 0) < query.data.spotAt) {
      setSpot(query.data.spot);
      setSpotAt(query.data.spotAt);
    }
  }, [query.data.spot, query.data.spotAt]);

  const clock = now ?? 0;
  const view = useMemo(
    () =>
      outlookNow({
        candles,
        spot: spot,
        start,
        windowStart: win,
        asks: null,
        spotAt,
        now: clock || Date.now(),
      }),
    [candles, spot, spotAt, start, win, clock],
  );
  const pulse = useMemo(
    () => readPulse({ price: spot, samples: useLive.getState().samples, trades: flow.trades, liqs: flow.liqs, book: flow.book, start, now: clock || Date.now() }),
    [spot, flow, start, clock],
  );
  const whales = useMemo(() => readWhales(flow.trades, flow.liqs, clock || Date.now()), [flow, clock]);

  useEffect(() => {
    if (now == null) return;
    setFrozen((prev) => settleForecasts(captureForecast(prev, {
      now, start: win, pUp: view.model.paused ? null : view.model.pUp, price: spot, startPx: start,
    }), candles, now));
  }, [now, spot, start, view.model.paused, view.model.pUp, win, candles]);

  useEffect(() => { if (frozen.length) setStorageOk(saveFrozen(frozen)); }, [frozen]);

  const signal = view.outlook.signal;
  const lean: Lean = signal === "up" ? "yes" : signal === "down" ? "no" : "wait";
  const pct = view.outlook.confidence == null ? null : Math.round(view.outlook.confidence * 100);
  const move = spot != null && start != null ? spot - start : null;
  const left = now == null ? null : Math.max(0, (win + 900) * 1000 - now);
  const windowCandles = withLiveCandle(candles, spot, Math.floor((now ?? Date.now()) / 1000));
  const market = marketMatches && bookFresh ? currentMarket : null;
  const kalshiYes =
    market?.yesBid != null && market.yesAsk != null && market.yesBid > 0 && market.yesAsk > 0
      ? (market.yesBid + market.yesAsk) / 2
      : market?.yesAsk != null && market.yesAsk > 0
        ? market.yesAsk
        : null;
  const kalshiNo = kalshiYes == null ? null : 1 - kalshiYes;

  useEffect(() => {
    if (kalshiYes == null) { setKalshiPath([]); return; }
    setKalshiPath((prev) => {
      const last = prev[prev.length - 1];
      const t = Date.now();
      if (last && Math.abs(last.yes - kalshiYes) < 0.004 && t - last.t < 20_000) return prev;
      return [...prev, { t, yes: kalshiYes }].filter((row) => row.t >= t - 15 * 60_000).slice(-40);
    });
  }, [kalshiYes]);

  const doing = plainDoing(pulse.regime, pulse.vol);
  const ago5 = kalshiPath.find((row) => row.t <= Date.now() - 5 * 60_000)?.yes ?? kalshiPath[0]?.yes ?? null;
  const kalshiDelta = kalshiYes != null && ago5 != null ? kalshiYes - ago5 : null;
  const botYes = lean === "yes";
  const kalshiUp = kalshiYes != null && kalshiYes >= 0.5;
  const agree = kalshiYes == null || lean === "wait" ? null : botYes === kalshiUp;
  const secs = left == null ? null : left / 1000;
  const sigma = view.model.paused ? null : view.model.sigmaDollar;
  const typical = sigma != null && secs != null ? sigma * Math.sqrt(Math.max(secs, 1) / 900) : null;
  const room = move == null ? null : Math.abs(move);
  const fallingTowardLine = move != null && pulse.moves.find((row) => row.ms === 30_000)?.delta != null && Math.sign(move) !== 0 && Math.sign(pulse.moves.find((row) => row.ms === 30_000)?.delta ?? 0) !== Math.sign(move);
  let flipLevel: "LOW" | "POSSIBLE" | "HIGH" | "UNKNOWN" = "UNKNOWN";
  if (room != null && typical != null && secs != null) {
    const tight = room < Math.max(typical * 1.3, 12);
    const safe = room > Math.max(typical * 2.2, 25);
    flipLevel = tight && fallingTowardLine ? "HIGH" : tight || (fallingTowardLine && secs < 180) ? "POSSIBLE" : safe ? "LOW" : "POSSIBLE";
  }
  const flip = {
    level: flipLevel,
    zone: start != null && typical != null ? ([start - typical, start + typical] as [number, number]) : null,
    typical,
  };
  const whyLine =
    move == null || secs == null
      ? "Waiting for the live price and the start of this window."
      : `BTC is ${money(Math.abs(move))} ${move >= 0 ? "above" : "below"} the start line with ${Math.round(secs)} seconds left. ${
          typical == null
            ? "A usual move for that much time is not ready yet."
            : `The model estimates a one-standard-deviation move of ${money(typical)} in that time, so ${room != null && typical && room > typical ? "there is more room than a usual move." : "the start line is still within reach."}`
        }`;

  return (
    <main className="min-h-screen bg-bg text-fg">
      <div className="mx-auto flex max-w-6xl flex-col gap-3 px-3 py-3 sm:px-5">
        <Guide />
        <LiveTape />

        <section className="grid gap-3 lg:grid-cols-10">
          <article className="relative overflow-hidden border border-line bg-surface p-2 lg:col-span-7">
            <p className="px-1 text-[11px] tracking-[0.18em] text-muted">LIVE WINDOW</p>
            <p className="px-1 font-mono text-xs text-muted">Coinbase window open {money(start)} · room {signed(move)}</p>
            <PriceChart candles={windowCandles} start={start} current={spot} band={flip.zone} shadeFrom={secs != null && secs <= 60 ? win + 840 : null} tall />
            <p className="mt-2 px-1 text-xs text-muted">Coinbase spot-close forecast. Kalshi settles from the final 60-second BRTI average; Coinbase can disagree. {marketMatches && currentMarket.strike != null ? `Official target ${money(currentMarket.strike)} · ${currentMarket.strikeRule === "greater_or_equal" ? "at or above" : currentMarket.strikeRule === "greater" ? "strictly above" : "check market rules"}.` : "Official target unavailable."}</p>
            <button type="button" className="mt-2 px-1 text-xs tracking-widest text-accent" onClick={() => setTvInterval(tvInterval === "off" ? "1" : "off")}>
              {tvInterval === "off" ? "SHOW TRADINGVIEW" : "HIDE TRADINGVIEW"}
            </button>
            {tvInterval !== "off" ? (
              <iframe
                title="TradingView BTC"
                className="mt-2 h-[420px] w-full"
                src={`https://s.tradingview.com/widgetembed/?symbol=COINBASE%3ABTCUSD&interval=${tvInterval === "today" ? "5" : tvInterval}&theme=dark&style=1&hideideas=1`}
              />
            ) : null}
          </article>
          <article className={`border bg-surface/80 p-4 lg:col-span-3 ${lean === "yes" ? "border-up/40" : lean === "no" ? "border-down/40" : "border-line"}`}>
            <p className="text-[11px] tracking-[0.18em] text-muted">PREDICTION</p>
            <p className="mt-2 text-sm">Will BTC finish above the start line?</p>
            <p className={`mt-3 text-center font-mono text-5xl ${leanClass(lean)}`}>{lean === "yes" ? "YES" : lean === "no" ? "NO" : "WAIT"}</p>
            <p className="text-center text-xs tracking-widest text-muted">ESTIMATED CHANCE</p>
            <p className="text-center font-mono text-3xl">{pct == null ? "—" : `${pct}%`}</p>
            <p className="mt-2 text-center text-xs text-warn">EXPERIMENTAL · UNCALIBRATED</p>
            <p className="mt-1 text-center text-[11px] leading-snug text-muted">This estimates Coinbase finishing above its window open. Accuracy is measured from frozen predictions; no automatic learning is claimed.</p>
            <TimerRing leftMs={left} />
            {view.model.paused ? <p role="status" className="mt-2 text-sm text-warn">Estimate paused: {view.model.reason}</p> : null}
            {secs != null && secs <= 60 ? <p className="mt-2 border border-warn p-2 text-sm text-warn">SETTLEMENT MINUTE · Spot forecast only. Official BRTI running average unavailable.</p> : <p className="mt-2 text-center text-xs text-muted">Settlement minute in {secs == null ? "—" : `${Math.max(0, Math.ceil(secs - 60))}s`}</p>}
            <p className="mt-2 text-xs text-muted">{view.model.matches} comparable completed windows · {view.model.volLabel}</p>
            <p className={`mt-3 text-center font-mono text-sm ${move != null && move > 0.005 ? "text-up" : move != null && move < -0.005 ? "text-down" : "text-muted"}`}>
              {move == null
                ? "Waiting for the start line"
                : Math.abs(move) < 0.005
                  ? "$0.00 ON THE LINE"
                  : `${signed(move)} ${move > 0 ? "ABOVE" : "BELOW"} THE LINE`}
            </p>
            <p className="mt-2 text-xs tracking-widest text-muted">WHY?</p>
            <p className="text-sm leading-snug">{whyLine}</p>
          </article>
        </section>

        <FastMoves />
        <MarketRadar />

        <PriorMarkets rows={query.data.history ?? []} move={move} />

        <article className="border border-line bg-surface p-4">
          <p className="text-[11px] tracking-[0.18em] text-muted">FLIP DANGER</p>
          <p className="text-[11px] text-muted">Conditional Reversal / Flip Risk</p>
          <p className={`mt-2 font-mono text-3xl ${flip.level === "HIGH" || flip.level === "POSSIBLE" ? "text-warn" : "text-muted"}`}>
            {flip.level === "UNKNOWN" ? "NOT ENOUGH YET" : flip.level}
          </p>
          <p className="mt-1 text-sm text-muted">This is not a percent. We have not calibrated flip chances yet.</p>
          <p className="mt-2 text-sm">
            {flip.level === "HIGH"
              ? "BTC is close to the start line and moving toward it. The call could change before the timer ends."
              : flip.level === "POSSIBLE"
                ? "A strong move could still cross the start line before time runs out."
                : flip.level === "LOW"
                  ? "BTC has more room than it usually moves in the time left."
                  : "Need a live price, a start line, and a usual-move estimate."}
          </p>
          <p className="mt-2 font-mono text-xs text-muted">
            <span className="block">NORMAL MOVE LEFT</span>
            <span className="block text-[11px]">Expected Remaining Volatility</span>
            {flip.typical == null ? "—" : `±${money(flip.typical)}`}
          </p>
        </article>

        <article className="border border-line bg-surface p-3">
          <p className="text-[11px] tracking-[0.18em] text-muted">SPOT MODEL / KALSHI CONTEXT</p>
          <p className="text-[11px] text-muted">Prediction Market Direction · Kalshi Implied Probability & Market Microstructure</p>
          {kalshiYes == null ? (
            <p className="mt-2 text-sm text-warn">Kalshi is temporarily unavailable. The bot call above still works.</p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs text-muted">OUR BOT</p>
                <p className={`font-mono text-2xl ${leanClass(lean)}`}>{lean === "yes" ? "YES" : lean === "no" ? "NO" : "WAIT"} {pct == null ? "" : `${pct}%`}</p>
              </div>
              <div>
                <p className="text-xs text-muted">KALSHI</p>
                <p className={`font-mono text-lg ${kalshiUp ? "text-up" : "text-down"}`}>YES {cents(kalshiYes)} / {Math.round(kalshiYes * 100)}%</p>
                <p className={`font-mono text-lg ${!kalshiUp ? "text-down" : "text-up"}`}>NO {cents(kalshiNo)} / {Math.round((kalshiNo ?? 0) * 100)}%</p>
                <p className="text-sm">{kalshiUp ? "Market lean: UP" : "Market lean: DOWN"}</p>
              </div>
            </div>
          )}
          {agree == null ? null : (
            <p className={`mt-3 text-sm ${agree ? "text-up" : "text-warn"}`}>
              {agree ? "Same directional lean, different settlement targets." : "Different leans. Spot close and BRTI settlement are different targets."}
            </p>
          )}
          {kalshiDelta != null ? (
            <p className={`mt-1 font-mono text-xs ${kalshiDelta > 0 ? "text-up" : kalshiDelta < 0 ? "text-down" : "text-muted"}`}>
              YES moved {kalshiDelta > 0 ? "+" : ""}{Math.round(kalshiDelta * 100)}¢ over the saved samples.
            </p>
          ) : null}
          <KalshiSpark points={kalshiPath} />
          <button type="button" className="mt-2 text-xs tracking-widest text-accent" onClick={() => setMarketDetails((v) => !v)}>
            {marketDetails ? "HIDE MARKET DETAILS" : "MARKET DETAILS"}
          </button>
          {marketDetails && market ? (
            <p className="mt-2 font-mono text-xs text-muted">
              Best buyer {cents(market.yesBid)} · Best seller {cents(market.yesAsk)} · Spread{" "}
              {market.yesBid != null && market.yesAsk != null ? `${Math.round((market.yesAsk - market.yesBid) * 100)}¢` : "—"}
            </p>
          ) : null}
        </article>

        <article className="border border-line bg-surface p-3">
          <p className="text-[11px] tracking-[0.18em] text-muted">WHAT IS HAPPENING RIGHT NOW?</p>
          <ul className="mt-2 space-y-1 text-sm">
            <MoveLine label="Past 30 Seconds" delta={pulse.moves.find((row) => row.ms === 30_000)?.delta ?? null} />
            <MoveLine label="Past 1 Minute" delta={pulse.moves.find((row) => row.ms === 60_000)?.delta ?? null} />
            <MoveLine label="Past 5 Minutes" delta={pulse.moves.find((row) => row.ms === 300_000)?.delta ?? null} />
            <li className={move != null && move > 0.005 ? "text-up" : move != null && move < -0.005 ? "text-down" : "text-muted"}>
              {move == null ? "Start line not ready." : Math.abs(move) < 0.005 ? "It is on the start line." : move > 0 ? `It is ${money(move)} above the start line.` : `It is ${money(Math.abs(move))} below the start line.`}
            </li>
            <li className={flip.level === "HIGH" || flip.level === "POSSIBLE" ? "text-warn" : "text-muted"}>
              {flip.level === "HIGH" || flip.level === "POSSIBLE" ? "The result could flip if the current push continues." : "A flip does not look close right now."}
            </li>
            <li className="text-muted">{whales.events.length ? "A few trades were much larger than normal." : "No unusually large trades just happened."}</li>
          </ul>
          <p className="mt-3 text-sm">SYSTEM READ — {lean === "wait" ? "Signals are mixed. Waiting is safer than pretending we know." : flip.level === "HIGH" ? "The current side is in danger of flipping." : "The call can still change before the timer ends."}</p>
        </article>

        <section className="grid gap-3 lg:grid-cols-2">
          <article className="border border-line bg-surface p-3">
            <p className="text-[11px] tracking-[0.18em] text-muted">WHAT BTC IS DOING <Hint text="A plain label for the last stretch of price action. Fast movement is not automatically good or bad." /></p>
            <p className={`mt-2 font-mono text-lg ${leanClass(doing.lean)}`}>{doing.title}</p>
            <p className="text-sm text-muted">{doing.why}</p>
            <p className="mt-3 text-sm">
              <span className="block">FLIP DANGER</span>
              <span className="block text-[11px] text-muted">Conditional Reversal / Flip Risk</span>
              <span className={pulse.reversal === "LOW" ? "text-muted" : "text-warn"}>{pulse.reversal === "UNKNOWN" ? "not enough yet" : pulse.reversal.toLowerCase()}</span>
            </p>
            <p className="text-sm text-muted">Price movement: {pulse.vol === "UNKNOWN" ? "not enough yet" : pulse.vol === "LOW" ? "quieter than usual" : pulse.vol === "HIGH" || pulse.vol === "EXTREME" ? "faster than usual" : "about normal"}</p>
          </article>
          <article className="border border-line bg-surface p-3">
            <p className="text-[11px] tracking-[0.18em] text-muted">SIGNALS <Hint text="These lights explain the picture. They are not added up to make the percentage." /></p>
            <ul className="mt-2 space-y-1 text-sm">
              {pulse.alignment.map((row) => {
                const named = plainSignal(row.label);
                return (
                  <li key={row.label} className="flex items-start justify-between gap-3">
                    <span>
                      <span className="block">{named.name}</span>
                      {named.term ? <span className="block text-[11px] leading-tight text-muted">{named.term}</span> : null}
                    </span>
                    <span className={leanClass(row.lean)}>{row.lean === "yes" ? "↑ UP" : row.lean === "no" ? "↓ DOWN" : "→ QUIET"}</span>
                  </li>
                );
              })}
            </ul>
          </article>
        </section>

        <article className="border border-line bg-surface p-3">
          <p className="text-[11px] tracking-[0.18em] text-muted">BIG MONEY DIRECTION</p>
          <p className="text-[11px] text-muted">Large-Trade / Whale Flow</p>
          {whales.events.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Quiet. No unusually large trades detected recently.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm">
              {whales.events.map((event) => (
                <li key={event.id} className="flex justify-between font-mono text-xs">
                  <span className={event.kind === "market-buy" || event.kind === "short-liq" ? "text-up" : "text-down"}>{event.note}</span>
                  <span>{compact(event.usd)}</span>
                </li>
              ))}
            </ul>
          )}
        </article>

        <article className="border border-line bg-surface p-3">
          <p className="text-[11px] tracking-[0.18em] text-muted">TODAY</p>
          <DayStats candles={dayCandles} price={spot} windowStart={win} />
          <PriceChart candles={dayCandles.slice(-48)} start={null} current={spot} shadeFrom={win} />
        </article>

        <Recent frozen={frozen} />
        {!storageOk ? <p role="status" className="text-sm text-warn">Browser storage is unavailable. Predictions remain in memory only.</p> : null}
        <p className="text-xs text-muted">Spot age {spotAt == null || now == null ? "unknown" : `${Math.max(0, Math.floor((now - spotAt) / 1000))}s`} · Kalshi book age {query.data.bookAt == null || now == null ? "unknown" : `${Math.max(0, Math.floor((now - query.data.bookAt) / 1000))}s`} · Last snapshot {new Date(query.data.fetchedAt).toISOString()}</p>

        <button type="button" className="border border-line px-3 py-2 text-left text-xs tracking-widest" onClick={() => setCore((v) => !v)}>
          {core ? "HIDE ADVANCED DETAILS" : "ADVANCED DETAILS"}
        </button>
        {core ? (
          <div className="space-y-3">
            <article className="border border-line bg-surface p-3 font-mono text-xs text-muted">
              <p>VWAP side: {pulse.vwapSide}</p>
              <p>Order book: {pulse.bookText} {flow.book.spread == null ? "" : `spread ${money(flow.book.spread)}`}</p>
              <p>Near bid {compact(flow.book.bidNear)} · near ask {compact(flow.book.askNear)}</p>
              <p>Momentum: {pulse.accelText}</p>
              <p>Internal regime: {pulse.regime} · vol {pulse.vol} · reversal {pulse.reversal}</p>
              <p>Window high {money(windowCandles.reduce((m, c) => Math.max(m, c.h), 0) || null)} · low {money(windowCandles.reduce((m, c) => Math.min(m, c.l), Number.POSITIVE_INFINITY) || null)}</p>
              <p>Polymarket is hidden. It is not verified against this 15-minute window, so a missing price is not shown as 0%.</p>
            </article>
            <ModelCore frozen={frozen} />
          </div>
        ) : null}
        <footer className="flex flex-wrap justify-between gap-3 py-4 text-xs text-muted"><span>No orders are placed. Fees and slippage are not optional.</span><a className="text-accent" href="https://kalshi.com/markets/kxbtc15m" target="_blank" rel="noreferrer">View on Kalshi</a></footer>
      </div>
    </main>
  );
}

function PriorMarkets({ rows, move }: { rows: SettledWindow[]; move: number | null }) {
  const yes = rows.filter((row) => row.result === "yes").length;
  const no = rows.filter((row) => row.result === "no").length;
  let streak = 0;
  const first = rows[0]?.result;
  if (first === "yes" || first === "no") {
    for (const row of rows) {
      if (row.result !== first) break;
      streak += 1;
    }
  }
  const deltas = rows
    .map((row) => (row.settle != null && row.strike != null ? row.settle - row.strike : null))
    .filter((n): n is number => n != null);
  const avg = deltas.length ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null;
  const absAvg = deltas.length ? deltas.reduce((a, b) => a + Math.abs(b), 0) / deltas.length : null;
  const bias: Lean | "wait" = yes >= no + 2 ? "yes" : no >= yes + 2 ? "no" : "wait";
  const last = rows[0];
  const lastSide = last?.result === "yes" ? "yes" : last?.result === "no" ? "no" : null;
  const liveSide = move == null || Math.abs(move) < 8 ? null : move > 0 ? "yes" : "no";
  const follow =
    lastSide == null || liveSide == null ? "Not enough yet to say if this window is following the last one." : liveSide === lastSide ? "This window is still on the same side as the last settled market." : "This window has flipped versus the last settled market.";
  return (
    <section className="border border-line bg-surface p-3">
      <p className="text-[11px] tracking-[0.18em] text-muted">LAST 10 SETTLED 15-MINUTE MARKETS</p>
      <p className="mt-1 text-sm text-muted">Kalshi windows that already closed. YES means BTC finished at or above that window’s start line.</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-warn">Settled markets are unavailable right now.</p>
      ) : (
        <>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            <div className="border border-line bg-surface-2 px-3 py-2">
              <p className="text-[11px] tracking-widest text-muted">LAST 10</p>
              <p className="font-mono text-lg">
                <span className="text-up">{yes} YES</span>
                <span className="text-muted"> · </span>
                <span className="text-down">{no} NO</span>
              </p>
            </div>
            <div className="border border-line bg-surface-2 px-3 py-2">
              <p className="text-[11px] tracking-widest text-muted">STREAK</p>
              <p className={`font-mono text-lg ${first === "yes" ? "text-up" : first === "no" ? "text-down" : "text-muted"}`}>
                {streak > 1 ? `${streak} ${first === "yes" ? "UP" : "DOWN"}` : "NO STREAK"}
              </p>
            </div>
            <div className="border border-line bg-surface-2 px-3 py-2">
              <p className="text-[11px] tracking-widest text-muted">AVERAGE FINISH</p>
              <p className={`font-mono text-lg ${avg != null && avg > 0 ? "text-up" : avg != null && avg < 0 ? "text-down" : "text-muted"}`}>{signed(avg)}</p>
            </div>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            <li className="flex justify-between gap-3">
              <span>Ten-window bias</span>
              <span className={leanClass(bias)}>{bias === "yes" ? "UP" : bias === "no" ? "DOWN" : "MIXED"}</span>
            </li>
            <li className="flex justify-between gap-3">
              <span>How decisive</span>
              <span className={absAvg != null && absAvg < 25 ? "text-warn" : "text-muted"}>
                {absAvg == null ? "—" : absAvg < 25 ? "TIGHT / CHOPPY" : `TYPICAL ${money(absAvg)}`}
              </span>
            </li>
            <li className="text-muted">{follow}</li>
            {streak >= 3 ? (
              <li className="text-warn">Three or more windows closed the same way. Streaks break. Do not treat this as a lock.</li>
            ) : null}
          </ul>
          <ul className="mt-3 divide-y divide-line">
            {rows.map((row) => {
              const delta = row.settle != null && row.strike != null ? row.settle - row.strike : null;
              const when = Number.isFinite(row.closeTime)
                ? new Date(row.closeTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                : "—";
              return (
                <li key={row.ticker || row.closeTime} className="flex items-center justify-between gap-3 py-2 font-mono text-xs">
                  <span className="text-muted">{when}</span>
                  <span className={row.result === "yes" ? "text-up" : "text-down"}>{row.result === "yes" ? "YES" : "NO"}</span>
                  <span className="hidden text-muted sm:inline">{money(row.strike)} → {money(row.settle)}</span>
                  <span className={delta != null && delta > 0 ? "text-up" : delta != null && delta < 0 ? "text-down" : "text-muted"}>{signed(delta)}</span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

function cents(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return `${Math.round(n * 100)}¢`;
}

function plainDoing(regime: string, vol: string) {
  if (regime === "UNKNOWN" || vol === "UNKNOWN") return { title: "COLLECTING HISTORY", lean: "wait" as const, why: "Not enough recent prices to describe this interval." };
  if (vol === "HIGH" || vol === "EXTREME") return { title: "MOVING FAST", lean: "warn" as const, why: "BTC is moving more than usual." };
  if (regime.includes("UP")) return { title: "MOVING UP", lean: "yes" as const, why: "BTC has been climbing." };
  if (regime.includes("DOWN")) return { title: "MOVING DOWN", lean: "no" as const, why: "BTC has been falling." };
  if (regime.includes("QUIET")) return { title: "VERY QUIET", lean: "wait" as const, why: "BTC is barely moving." };
  if (regime.includes("RANGE") || regime.includes("CHOP")) return { title: "MOVING SIDEWAYS", lean: "wait" as const, why: "BTC is not picking a clear direction." };
  return { title: "CHANGING / MIXED", lean: "warn" as const, why: "BTC is changing direction and the signals do not fully agree yet." };
}

function MarketRadar() {
  const reading = useRadar((s) => s.reading);
  const tone =
    reading.bias === "STRONG UP" || reading.bias === "UP"
      ? "text-up"
      : reading.bias === "STRONG DOWN" || reading.bias === "DOWN"
        ? "text-down"
        : "text-muted";
  const known = reading.coins.filter((c) => c.m1 != null || c.s30 != null).length;
  return (
    <section className="border border-line bg-surface px-3 py-2">
      <p className="text-[11px] tracking-[0.18em] text-muted">CRYPTO MARKET RADAR</p>
      <p className="text-[11px] text-muted">Cross-Asset Market Breadth</p>
      <p className={`mt-1 font-mono text-lg ${tone}`}>{reading.ready ? reading.bias : "WAITING"}</p>
      <p className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-sm">
        {reading.coins.map((coin) => (
          <span key={coin.symbol} className={coin.side === "up" ? "text-up" : coin.side === "down" ? "text-down" : "text-muted"}>
            {coin.symbol} {coin.side === "up" ? "↑" : coin.side === "down" ? "↓" : "→"}
          </span>
        ))}
      </p>
      <p className="mt-1 text-xs text-muted">
        {reading.ready ? `${reading.upCount} of ${known} major markets moving up` : "Collecting 30-second, 1-minute, and 5-minute moves."} · {reading.stance}
      </p>
    </section>
  );
}

function MoveLine({ label, delta }: { label: string; delta: number | null }) {
  const flat = delta != null && Math.abs(delta) < 0.5;
  const tone = delta == null || flat ? "text-muted" : delta > 0 ? "text-up" : "text-down";
  return (
    <li className={`flex justify-between gap-3 font-mono ${tone}`}>
      <span>{label}</span>
      <span>{delta == null ? "—" : signed(delta)}</span>
    </li>
  );
}

function plainSignal(label: string): { name: string; term: string | null } {
  if (label === "Price") return { name: "Price direction", term: null };
  if (label === "Momentum") return { name: "SPEEDING UP / SLOWING DOWN", term: "Multi-Horizon Momentum & Acceleration" };
  if (label === "Buyers") return { name: "BUYERS VS SELLERS", term: "Aggressive Order-Flow Imbalance" };
  if (label === "Order Book") return { name: "WAITING ORDERS", term: "Order-Book Imbalance" };
  if (label === "Large Trades") return { name: "BIG MONEY DIRECTION", term: "Large-Trade / Whale Flow" };
  if (label === "Reversal") return { name: "FLIP DANGER", term: "Conditional Reversal / Flip Risk" };
  return { name: label, term: null };
}

function Hint({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative inline-block align-middle">
      <button type="button" className="ml-1 text-xs text-accent" onClick={() => setOpen((v) => !v)}>
        ?
      </button>
      {open ? <span className="absolute left-0 z-10 mt-1 w-64 border border-line bg-surface-2 p-2 text-xs font-sans normal-case tracking-normal text-muted">{text}</span> : null}
    </span>
  );
}

function Guide() {
  return (
    <section className="border border-line bg-surface px-3 py-2 text-sm">
      <p className="text-[11px] tracking-[0.18em] text-muted">QUICK GUIDE</p>
      <p><span className="text-up">Green</span> means up / YES. <span className="text-down">Red</span> means down / NO. <span className="text-warn">Yellow</span> means mixed. <span className="text-muted">Gray</span> means quiet or not enough.</p>
      <p className="text-muted">YES = finish above the start price. NO = finish at or below it. WAIT = no clear model lean.</p>
    </section>
  );
}

function LiveTape() {
  const price = useLive((s) => s.price);
  const flash = useLive((s) => s.flash);
  const samples = useLive((s) => s.samples);
  const tickAt = useLive((s) => s.tickAt);
  const status = useLive((s) => s.status);
  const trades = useFlow((s) => s.trades);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, []);
  const age = tickAt ? Math.max(0, (now - tickAt) / 1000) : null;
  const stale = status !== "live" || (age != null && age > 5);
  const recent = trades.reduce((sum, trade) => (trade.t >= now - 20_000 ? sum + trade.usd : sum), 0);
  const prior = trades.reduce((sum, trade) => (trade.t >= now - 40_000 && trade.t < now - 20_000 ? sum + trade.usd : sum), 0);
  const volDir = prior <= 0 && recent <= 0 ? "flat" : recent > prior * 1.08 ? "up" : recent < prior * 0.92 ? "down" : "flat";
  const volDelta = prior > 0 ? ((recent - prior) / prior) * 100 : null;
  const bits = [
    ["1s", 1_000],
    ["5s", 5_000],
    ["15s", 15_000],
    ["30s", 30_000],
    ["1m", 60_000],
  ] as const;
  return (
    <header className="border border-line bg-surface px-3 py-3">
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] tracking-[0.22em] text-muted">BTC // LIVE</p>
          <p className={`mt-1 font-mono text-4xl tabular-nums sm:text-5xl ${flash === "up" ? "tick-up text-up" : flash === "down" ? "tick-down text-down" : ""}`}>{money(price)}</p>
        </div>
        <div className="flex items-end gap-3">
          <div className="flex items-center gap-2 border border-line bg-surface-2 px-2 py-1.5">
            <span className="vol-stage">
              <span className={`vol-arrow ${volDir} ${volDir === "up" ? "text-up" : volDir === "down" ? "text-down" : "text-muted"}`} aria-hidden>
                <svg width="22" height="22" viewBox="0 0 22 22" fill="none">
                  <path d="M11 3.5 L17 12 H13.2 V18.5 H8.8 V12 H5 Z" fill="currentColor" />
                </svg>
              </span>
            </span>
            <span className="text-right font-mono text-xs leading-tight">
              <span className="block tracking-widest text-muted">VOLUME 20s</span>
              <span className={volDir === "up" ? "text-up" : volDir === "down" ? "text-down" : "text-muted"}>
                {compact(recent)} {volDelta == null ? "" : `${volDelta > 0 ? "+" : ""}${Math.round(volDelta)}%`}
              </span>
            </span>
          </div>
          <p className={`text-right font-mono text-xs ${stale ? "text-warn" : "text-up"}`}>
            {stale ? "TEMPORARILY DELAYED" : "LIVE"}
            <span className="mt-1 block text-muted">{age == null ? "linking" : `${age.toFixed(1)} sec ago`}</span>
          </p>
        </div>
      </div>
      <div className="mt-2 flex gap-3 overflow-x-auto font-mono text-xs tabular-nums">
        {bits.map(([label, ms]) => {
          const prior = priceAgo(samples, ms, now);
          const delta = price != null && prior ? price - prior.px : null;
          const up = delta != null && delta > 0.5;
          const down = delta != null && delta < -0.5;
          return (
            <span key={label} className={`shrink-0 ${up ? "text-up" : down ? "text-down" : "text-muted"}`}>
              {label} {signed(delta)}
            </span>
          );
        })}
      </div>
    </header>
  );
}

function FastMoves() {
  const price = useLive((s) => s.price);
  const samples = useLive((s) => s.samples);
  const rows = [
    ["1 SEC", 1_000],
    ["3 SEC", 3_000],
    ["5 SEC", 5_000],
    ["10 SEC", 10_000],
    ["15 SEC", 15_000],
    ["30 SEC", 30_000],
    ["1 MIN", 60_000],
    ["5 MIN", 300_000],
    ["15 MIN", 900_000],
  ] as const;
  return (
    <section className="border border-line bg-surface p-3">
      <p className="text-[11px] tracking-[0.18em] text-muted">BTC LIVE MOVEMENT</p>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-sm sm:grid-cols-4">
        {rows.map(([label, ms]) => {
          const prior = priceAgo(samples, ms);
          const delta = price != null && prior ? price - prior.px : null;
          return (
            <p key={label} className="flex justify-between gap-2">
              <span className="text-muted">{label}</span>
              <span className={delta != null && delta > 0.5 ? "text-up" : delta != null && delta < -0.5 ? "text-down" : "text-muted"}>{signed(delta)}</span>
            </p>
          );
        })}
      </div>
    </section>
  );
}

function TimerRing({ leftMs }: { leftMs: number | null }) {
  const total = 900;
  const secs = leftMs == null ? null : Math.max(0, Math.floor(leftMs / 1000));
  const label = secs == null ? "--:--" : `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
  const r = 54;
  const c = 2 * Math.PI * r;
  const dash = secs == null ? c : (secs / total) * c;
  const tone = secs == null ? "text-accent" : secs <= 30 ? "text-down" : secs <= 120 ? "text-warn" : secs <= 300 ? "text-fg" : "text-accent";
  return (
    <div className="mx-auto mt-4 w-40 text-center">
      <svg viewBox="0 0 140 140" className="mx-auto h-40 w-40">
        <circle cx="70" cy="70" r={r} fill="none" stroke="currentColor" className="text-line" strokeWidth="3" />
        <circle
          cx="70"
          cy="70"
          r={r}
          fill="none"
          stroke="currentColor"
          className={tone}
          strokeWidth="4"
          strokeDasharray={`${dash} ${c}`}
          strokeLinecap="round"
          transform="rotate(-90 70 70)"
        />
        <text x="70" y="66" textAnchor="middle" className="fill-fg" fontSize="22" fontFamily="ui-monospace, monospace">
          {label}
        </text>
        <text x="70" y="86" textAnchor="middle" className="fill-muted" fontSize="8" letterSpacing="2">
          TIME LEFT
        </text>
      </svg>
    </div>
  );
}

function KalshiSpark({ points }: { points: { t: number; yes: number }[] }) {
  if (points.length < 2) return <p className="mt-2 text-xs text-muted">Kalshi movement chart fills in as prices are saved.</p>;
  const ys = points.map((p) => p.yes);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const w = 240;
  const h = 48;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.yes - min) / Math.max(max - min, 0.01)) * (h - 4) - 2;
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="mt-2 h-12 w-full" role="img" aria-label="Kalshi YES price">
      <path d={d} fill="none" stroke="currentColor" className="text-accent" strokeWidth="1.5" />
    </svg>
  );
}

function Stat({ k, v, tone }: { k: string; v: string; tone?: number | null }) {
  const cls = tone == null ? "" : tone > 0.5 ? "text-up" : tone < -0.5 ? "text-down" : "";
  return (
    <p>
      <span className="block text-[10px] tracking-widest text-muted">{k}</span>
      <span className={cls}>{v}</span>
    </p>
  );
}

function Row({ k, v, tone }: { k: string; v: string; tone?: number | null }) {
  const cls = tone == null ? "" : tone > 0.5 ? "text-up" : tone < -0.5 ? "text-down" : "";
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className={cls}>{v}</dd>
    </div>
  );
}

function Bar({ label, pct, tone }: { label: string; pct: number | null; tone: "yes" | "no" }) {
  const width = pct == null ? 0 : Math.round(pct * 100);
  return (
    <p className="mt-2 font-mono text-xs">
      <span className="text-muted">{label} {pct == null ? "—" : `${width}%`}</span>
      <span className="mt-1 block h-1.5 bg-surface-2">
        <span className={`block h-full ${tone === "yes" ? "bg-up" : "bg-down"}`} style={{ width: `${width}%` }} />
      </span>
    </p>
  );
}

function DayStats({ candles, price, windowStart }: { candles: Candle[]; price: number | null; windowStart: number }) {
  const today = candles.filter((c) => c.t >= windowStart - 20 * 3600);
  const open = today[0]?.o ?? candles[0]?.o ?? null;
  const high = today.reduce((m, c) => Math.max(m, c.h), 0);
  const low = today.reduce((m, c) => (m === 0 ? c.l : Math.min(m, c.l)), 0);
  const change = price != null && open != null ? price - open : null;
  return (
    <p className="mb-2 font-mono text-xs text-muted">
      OPEN {money(open)} · HIGH {money(high || null)} · LOW {money(low || null)} ·{" "}
      <span className={change != null && change > 0 ? "text-up" : change != null && change < 0 ? "text-down" : ""}>
        DAY {signed(change)} {open && change != null ? `(${((change / open) * 100).toFixed(2)}%)` : ""}
      </span>
    </p>
  );
}

function Recent({ frozen }: { frozen: Frozen[] }) {
  const rows = frozen.filter((row) => row.result).slice(0, 8);
  return (
    <article className="border border-line bg-surface p-3">
      <p className="text-[11px] tracking-[0.18em] text-muted">FROZEN SPOT FORECAST RESULTS</p>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-muted">No settled live predictions yet. Past candles are not rewritten into fake saved calls.</p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {rows.map((row) => (
            <li key={row.start} className={`border-l-2 py-2 pl-3 font-mono text-xs ${row.result === "CORRECT" ? "border-up" : row.result === "WRONG" ? "border-down" : "border-line"}`}>
              <p>{new Date(row.start * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
              <p className={row.call === "YES" ? "text-up" : row.call === "NO" ? "text-down" : "text-muted"}>BOT {row.call} {row.pUp == null ? "" : `${Math.round((row.call === "NO" ? 1 - row.pUp : row.pUp) * 100)}%`}</p>
              <p>BTC {signed(row.settledPx != null ? row.settledPx - row.startPx : null)}</p>
              <p>{row.result === "CORRECT" ? "CORRECT" : row.result === "WRONG" ? "WRONG" : "SKIPPED"}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted">Calls freeze at T+30–60s while this tab is open. Late visits are skipped. Coinbase close results are not Kalshi settlements; WAIT counts in probability scoring.</p>
    </article>
  );
}

function ModelCore({ frozen }: { frozen: Frozen[] }) {
  const stats = evaluationSummary(frozen);
  return (
    <article className="border border-line bg-surface p-3 text-sm">
      <p className="text-xs tracking-widest text-muted">MODEL METHOD & CALIBRATION</p>
      <p className="mt-2 text-warn">EXPERIMENTAL · UNCALIBRATED · spot-close-v2</p>
      <p className="mt-2 text-muted">Completed one-minute log returns only: variance = 75% last 60 returns + 25% last 15. Forecast uses the normal CDF of log(spot/open) plus a small momentum drift, divided by volatility × √minutes left. Drift = 10% of the five-minute return per minute, capped at five minutes. Probabilities shrink 15% toward 50%.</p>
      <p className="mt-2 text-muted">Comparable windows match signed distance / volatility and volatility at the same elapsed minute, using only features available then. At least 20 matches are required to blend a smoothed empirical rate (at most 25% weight). These assumptions require held-out validation.</p>
      <p className="mt-2 font-mono text-xs">{stats.count} completed · {stats.directional} directional · {stats.waits} WAIT · {stats.directional ? `${stats.correct}/${stats.directional} correct (${Math.round(stats.correct / stats.directional * 100)}%)` : "Accuracy: collecting predictions"}</p>
      <p className="mt-2 font-mono text-xs">Brier {stats.brier == null ? "—" : stats.brier.toFixed(3)} · 50/50 baseline 0.250 · Log loss {stats.logLoss == null ? "—" : stats.logLoss.toFixed(3)} (lower is better; includes WAIT)</p>
      {stats.count > 0 ? <div className="mt-3 overflow-x-auto"><table className="w-full text-left text-xs"><thead><tr><th>P(up) bucket</th><th>n</th><th>Mean forecast</th><th>Realized up</th></tr></thead><tbody>{stats.buckets.filter((b) => b.count > 0).map((b) => <tr key={b.label}><td className="py-2">{b.label}</td><td>{b.count}</td><td>{Math.round(b.predicted! * 100)}%</td><td>{Math.round(b.observed! * 100)}%</td></tr>)}</tbody></table></div> : <p className="mt-2 text-muted">No completed v2 forecasts yet. Older model records are excluded.</p>}
      <p className="mt-2 text-xs text-muted">Recorded locally in this browser, only at T+30–60s; not an independently audited track record. Small samples and tab-open selection can bias results. Order book, whale flow and radar remain context, not extra votes in the probability. A positive quoted difference alone does not establish profitability.</p>
    </article>
  );
}
