import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Bitcoin, Minus, Zap } from "lucide-react";
import { loadJournal, readWhales, saveJournal, whaleAdjust, type JournalRow, type WhaleEvent, type XPulse } from "@/lib/btc/intel";
import { priceAgo, startCoinbaseFeed, useFlow, useLive, type Sample } from "@/lib/btc/live";
import { momentumWord, outlookNow, scorePastWindows } from "@/lib/btc/outlook";
import { getSnapshot } from "@/lib/btc/snapshot";
import type { Candle, Snapshot } from "@/lib/btc/types";
import { PriceChart, type ChartMark } from "./chart";

function money(n: number | null | undefined) {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

function usdCompact(n: number) {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${Math.round(n / 1000)}k`;
  return `$${Math.round(n)}`;
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function windowStartSec(now = Date.now()) {
  return Math.floor(now / 1000 / 900) * 900;
}

function startPrice(candles: Candle[], start: number) {
  return candles.find((c) => c.t >= start && c.t < start + 900)?.o ?? null;
}

function withLiveCandle(candles: Candle[], px: number | null, nowSec: number, keep: number) {
  const base = candles.slice(-keep);
  if (px == null || base.length === 0) return base;
  const step = base.length > 20 ? 300 : 60;
  const bucket = Math.floor(nowSec / step) * step;
  const last = base[base.length - 1];
  if (!last) return base;
  if (last.t === bucket) {
    const next = base.slice();
    next[next.length - 1] = { ...last, c: px, h: Math.max(last.h, px), l: Math.min(last.l, px) };
    return next;
  }
  if (bucket > last.t) return [...base, { t: bucket, o: px, h: px, l: px, c: px }].slice(-keep);
  return base;
}

function toneClass(n: number | null) {
  if (n == null || Math.abs(n) < 0.5) return "text-muted";
  return n > 0 ? "text-up" : "text-down";
}

function Dir({ n }: { n: number | null }) {
  if (n == null) return <Minus className="size-4 text-muted" aria-hidden="true" />;
  if (n > 0.5) return <ArrowUp className="size-4 text-up" aria-hidden="true" />;
  if (n < -0.5) return <ArrowDown className="size-4 text-down" aria-hidden="true" />;
  return <Minus className="size-4 text-muted" aria-hidden="true" />;
}

export function Cockpit({ initial }: { initial: Snapshot }) {
  const query = useQuery({
    queryKey: ["btc-snapshot"],
    queryFn: () => getSnapshot(),
    initialData: initial,
    refetchInterval: 15_000,
  });
  const candles = query.data.candles;
  const dayCandles = query.data.dayCandles ?? [];
  const [win, setWin] = useState(() => windowStartSec());
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const [picked, setPicked] = useState<WhaleEvent | null>(null);

  useEffect(() => startCoinbaseFeed(), []);
  useEffect(() => setJournal(loadJournal()), []);
  useEffect(() => {
    if (!candles.length) return;
    useLive.getState().seedHistory(candles.slice(-20).map((c) => ({ t: c.t * 1000 + 59_000, px: c.c })));
  }, [candles]);
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = windowStartSec();
      setWin((prev) => (prev === next ? prev : next));
    }, 1000);
    return () => window.clearInterval(id);
  }, []);

  const start = startPrice(candles, win);
  const scored = useMemo(() => scorePastWindows(candles), [candles]);

  return (
    <main className="min-h-screen bg-bg text-fg">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3 sm:px-6">
        <span className="flex size-9 items-center justify-center rounded-md bg-surface-2 text-up">
          <Bitcoin className="size-5" aria-hidden="true" />
        </span>
        <p className="text-sm font-medium">
          BTC Window <span className="text-muted">/ 15m</span>
        </p>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:px-6 lg:hidden">
        <PriceHero />
        <OutlookPanel candles={candles} start={start} windowStart={win} asks={query.data.market} />
        <RightNow />
        <WindowChart candles={candles} start={start} windowStart={win} onPick={setPicked} />
        <WhalePanel onPick={setPicked} />
        <XPanel />
        <MoveStrip candles={candles} windowStart={win} />
        <DayChart candles={dayCandles} windowStart={win} />
        <Recent scored={scored} journal={journal} />
        <Performance journal={journal} />
        <Advanced market={query.data.market} />
        {picked ? <EventCard event={picked} onClose={() => setPicked(null)} /> : null}
      </div>
      <div className="mx-auto hidden max-w-6xl gap-4 px-6 py-4 lg:grid lg:grid-cols-3">
        <div className="col-span-3">
          <PriceHero />
        </div>
        <div className="col-span-2 flex flex-col gap-4">
          <WindowChart candles={candles} start={start} windowStart={win} onPick={setPicked} />
          <MoveStrip candles={candles} windowStart={win} />
          <DayChart candles={dayCandles} windowStart={win} />
          <Recent scored={scored} journal={journal} />
          <Performance journal={journal} />
          <Advanced market={query.data.market} />
        </div>
        <div className="flex flex-col gap-4">
          <OutlookPanel
            candles={candles}
            start={start}
            windowStart={win}
            asks={query.data.market}
            onSettle={(row) => {
              setJournal((prev) => {
                if (prev.some((item) => item.start === row.start)) return prev;
                const next = [row, ...prev].slice(0, 40);
                saveJournal(next);
                return next;
              });
            }}
          />
          <XPanel />
          <WhalePanel onPick={setPicked} />
          {picked ? <EventCard event={picked} onClose={() => setPicked(null)} /> : null}
        </div>
      </div>
    </main>
  );
}

function PriceHero() {
  const price = useLive((s) => s.price);
  const flash = useLive((s) => s.flash);
  const samples = useLive((s) => s.samples);
  const minute = priceAgo(samples, 60_000);
  const delta = price != null && minute ? price - minute.px : null;
  return (
    <section className={`rounded-xl border border-line bg-surface px-4 py-4 sm:px-5 ${flash === "up" ? "tick-up" : flash === "down" ? "tick-down" : ""}`}>
      <p className="text-xs tracking-widest text-muted">BITCOIN</p>
      <p className="mt-1 font-mono text-4xl font-medium sm:text-5xl">{money(price)}</p>
      <p className={`mt-1 flex items-center gap-2 text-base ${toneClass(delta)}`}>
        <Dir n={delta} />
        {delta == null ? "Waiting for a minute of ticks" : `${money(Math.abs(delta))} last minute`}
      </p>
      <p className="mt-2 flex items-center gap-2 text-sm text-muted">
        Momentum <span className={toneClass(delta)}>{momentumWord(delta)}</span>
      </p>
      <LiveAge />
    </section>
  );
}

function LiveAge() {
  const tickAt = useLive((s) => s.tickAt);
  const status = useLive((s) => s.status);
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, []);
  const age = tickAt == null || now == null ? null : Math.max(0, (now - tickAt) / 1000);
  const delayed = status === "delayed" || (age != null && age > 5);
  return (
    <p className={`mt-2 text-sm ${delayed ? "text-down" : "text-muted"}`}>
      {delayed ? "PRICE DATA DELAYED" : status === "live" ? `LIVE · Updated ${age == null ? "—" : age.toFixed(1)} sec ago` : "Connecting to Coinbase…"}
    </p>
  );
}

function RightNow() {
  const rows = useMoves();
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-muted">RIGHT NOW</p>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {rows.slice(0, 4).map((row) => (
          <div key={row.label}>
            <p className="text-sm text-muted">{row.label}</p>
            <p className={`flex items-center gap-1 font-mono text-xl ${toneClass(row.delta)}`}>
              <Dir n={row.delta} />
              {row.delta == null ? "—" : `$${Math.abs(row.delta).toFixed(0)}`}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function useMoves() {
  const [snap, setSnap] = useState<{ price: number | null; samples: Sample[] }>({ price: null, samples: [] });
  useEffect(() => {
    const read = () => {
      const state = useLive.getState();
      setSnap({ price: state.price, samples: state.samples });
    };
    read();
    const id = window.setInterval(read, 1000);
    return () => window.clearInterval(id);
  }, []);
  return (
    [
      ["5 sec", 5_000],
      ["30 sec", 30_000],
      ["1 min", 60_000],
      ["3 min", 180_000],
      ["5 min", 300_000],
      ["15 min", 900_000],
    ] as const
  ).map(([label, ms]) => {
    const prior = priceAgo(snap.samples, ms);
    return { label, delta: snap.price != null && prior ? snap.price - prior.px : null };
  });
}

function OutlookPanel({
  candles,
  start,
  windowStart,
  asks,
  pulse,
  onSettle,
}: {
  candles: Candle[];
  start: number | null;
  windowStart: number;
  asks: Snapshot["market"];
  pulse?: XPulse;
  onSettle?: (row: JournalRow) => void;
}) {
  const [spot, setSpot] = useState<number | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [modelTick, setModelTick] = useState(0);
  const [whaleScore, setWhaleScore] = useState(0);
  useEffect(() => {
    const read = () => {
      setSpot(useLive.getState().price);
      setWhaleScore(readWhales(useFlow.getState().trades, useFlow.getState().liqs).score);
    };
    read();
    const slow = window.setInterval(() => {
      read();
      setModelTick((n) => n + 1);
    }, 8_000);
    setNow(Date.now());
    const clockId = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(slow);
      window.clearInterval(clockId);
    };
  }, []);
  const xScore = pulse?.ok ? pulse.score : 0;
  const xAdj = pulse?.ok ? whaleAdjust(xScore, false) : 0;
  const wAdj = whaleAdjust(whaleScore, Math.abs(whaleScore) > 0.85);
  const pack = useMemo(() => {
    const built = outlookNow({ candles, spot, start, windowStart, asks, now: Date.now(), spotAt: useLive.getState().tickAt });
    const base = built.model.pUp;
    const finalP = base == null ? null : Math.min(0.92, Math.max(0.08, base + xAdj + wAdj));
    const outlook = {
      ...built.outlook,
      ...describeSafe(finalP, built.outlook),
    };
    return { built, base, finalP, outlook };
  }, [candles, spot, start, windowStart, asks, modelTick, xAdj, wAdj]);
  useEffect(() => {
    if (!onSettle || start == null || pack.finalP == null) return;
    const key = windowStart;
    const timer = window.setInterval(() => {
      const next = windowStartSec();
      if (next === key) return;
      const px = useLive.getState().price ?? start;
      const up = px >= start;
      const signal = pack.outlook.signal;
      const verdict = signal === "wait" ? "WAIT" : signal === "up" ? (up ? "CORRECT" : "WRONG") : up ? "WRONG" : "CORRECT";
      const slice = candles.filter((c) => c.t >= key && c.t < key + 900);
      onSettle({
        start: key,
        open: start,
        close: px,
        high: Math.max(start, ...slice.map((c) => c.h), px),
        low: Math.min(start, ...slice.map((c) => c.l), px),
        priceP: pack.base,
        xAdj,
        whaleAdj: wAdj,
        finalP: pack.finalP,
        signal,
        verdict,
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onSettle, start, windowStart, pack.base, pack.finalP, pack.outlook.signal, xAdj, wAdj, candles]);

  const remain = now == null ? null : (windowStart + 900) * 1000 - now;
  const outlook = pack.outlook;
  const tone = outlook.signal === "up" ? "text-up" : outlook.signal === "down" ? "text-down" : "text-muted";
  const headline = outlook.signal === "up" ? "LIKELY UP" : outlook.signal === "down" ? "LIKELY DOWN" : "WAIT";
  const pct = outlook.confidence == null ? null : Math.round(outlook.confidence * 100);
  return (
    <section className="rounded-xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-xs tracking-widest text-muted">15-MINUTE OUTLOOK</p>
      <p className={`mt-2 flex items-center gap-2 font-mono text-3xl font-medium ${tone}`}>
        {outlook.signal === "up" ? <ArrowUp className="size-7" /> : outlook.signal === "down" ? <ArrowDown className="size-7" /> : <Minus className="size-7" />}
        {headline}
      </p>
      <Meter pct={pct} signal={outlook.signal} />
      <p className="text-sm text-muted">{outlook.zone}</p>
      <p className="mt-4 text-xs tracking-widest text-muted">WINDOW CLOSES IN</p>
      <p className="font-mono text-4xl">{remain == null ? "--:--" : clock(remain)}</p>
      <div className="mt-4 border-t border-line pt-3">
        <p className="text-xs tracking-widest text-muted">WHAT IS DRIVING IT</p>
        <ul className="mt-2 space-y-1 text-sm">
          <li className="flex justify-between"><span className="text-muted">Price model</span><span className="font-mono">{pack.base == null ? "—" : `${Math.round(pack.base * 100)}%`}</span></li>
          <li className="flex justify-between"><span className="text-muted">X</span><span className="font-mono text-muted">Off</span></li>
          <li className="flex justify-between"><span className="text-muted">Whales</span><span className={`font-mono ${toneClass(wAdj)}`}>{`${wAdj >= 0 ? "+" : ""}${(wAdj * 100).toFixed(1)} pts`}</span></li>
          <li className="flex justify-between"><span className="text-muted">Final</span><span className="font-mono">{pack.finalP == null ? "—" : `${Math.round(pack.finalP * 100)}% up`}</span></li>
        </ul>
        <p className="mt-2 text-xs text-muted">Points are model nudges, not promises. Whale and X moves are capped.</p>
      </div>
      <div className="mt-4 border-t border-line pt-3">
        <p className="text-xs tracking-widest text-muted">WHY</p>
        <ul className="mt-2 space-y-2 text-sm">
          {outlook.sentences.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function describeSafe(finalP: number | null, prior: { sentences: string[]; paused: boolean }) {
  if (finalP == null) return { signal: "wait" as const, confidence: null, zone: prior.paused ? "Not enough history yet" : "WAIT" };
  const up = finalP >= 0.5;
  const confidence = up ? finalP : 1 - finalP;
  const pct = confidence * 100;
  const signal = pct < 55 ? ("wait" as const) : up ? ("up" as const) : ("down" as const);
  const zone = pct < 55 ? "No clear edge" : pct < 60 ? "Slight lean" : pct < 70 ? "Moderate confidence" : "Strong";
  return { signal, confidence, zone };
}

function Meter({ pct, signal }: { pct: number | null; signal: "up" | "down" | "wait" }) {
  const pos = pct == null ? 50 : signal === "down" ? 100 - pct : signal === "wait" ? 50 : pct;
  return (
    <div className="mt-3">
      <div className="flex justify-between text-xs text-muted">
        <span>DOWN</span>
        <span>UP</span>
      </div>
      <div className="relative mt-1 h-2 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 left-1/2 w-px bg-line" />
        <div className="absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-fg" style={{ left: `calc(${pos}% - 6px)` }} />
      </div>
      <p className="mt-2 text-lg">{pct == null ? "—" : `${pct}%`}</p>
    </div>
  );
}

function WindowChart({
  candles,
  start,
  windowStart,
  onPick,
}: {
  candles: Candle[];
  start: number | null;
  windowStart: number;
  onPick: (event: WhaleEvent) => void;
}) {
  const [px, setPx] = useState<number | null>(null);
  const [nowSec, setNowSec] = useState(0);
  const [events, setEvents] = useState<WhaleEvent[]>([]);
  useEffect(() => {
    const id = window.setInterval(() => {
      setPx(useLive.getState().price);
      setNowSec(Math.floor(Date.now() / 1000));
      setEvents(readWhales(useFlow.getState().trades, useFlow.getState().liqs).events);
    }, 1000);
    setPx(useLive.getState().price);
    return () => window.clearInterval(id);
  }, []);
  const shown = withLiveCandle(
    candles.filter((c) => c.t >= windowStart - 60 && c.t < windowStart + 900),
    px,
    nowSec,
    16,
  );
  const fallback = shown.length >= 2 ? shown : candles.slice(-15);
  const high = fallback.length ? Math.max(...fallback.map((c) => c.h)) : null;
  const low = fallback.length ? Math.min(...fallback.map((c) => c.l)) : null;
  const diff = px != null && start != null ? px - start : null;
  const pct = diff != null && start ? (diff / start) * 100 : null;
  const marks: ChartMark[] = events.slice(0, 4).map((event) => ({
    t: Math.floor(event.t / 1000),
    label: event.note,
    tone: event.kind === "market-buy" || event.kind === "short-liq" ? "up" : "down",
  }));
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-muted">LAST 15 MINUTES</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Start" value={money(start)} />
        <Stat label="Now" value={money(px)} />
        <Stat label="Change" value={diff == null ? "—" : `${diff >= 0 ? "+" : ""}$${diff.toFixed(0)}`} className={toneClass(diff)} />
        <Stat label="Percent" value={pct == null ? "—" : `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`} className={toneClass(diff)} />
        <Stat label="High" value={money(high)} />
        <Stat label="Low" value={money(low)} />
        <Stat label="Range" value={high != null && low != null ? `$${Math.round(high - low)}` : "—"} />
      </div>
      <PriceChart candles={fallback} start={start} current={px} marks={marks} tall />
      <div className="mt-2 flex flex-wrap gap-2">
        {events.length === 0 ? (
          <p className="text-xs text-muted">No large prints in this window.</p>
        ) : (
          events.slice(0, 4).map((event) => (
            <button key={event.id} type="button" className="rounded-md border border-line px-3 py-2 text-left text-xs" onClick={() => onPick(event)}>
              <Zap className={`mr-1 inline size-3 ${event.kind === "market-sell" || event.kind === "long-liq" ? "text-down" : "text-up"}`} />
              {event.note} · {usdCompact(event.usd)}
            </button>
          ))
        )}
      </div>
    </section>
  );
}

function Stat({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <p>
      <span className="block text-xs text-muted">{label}</span>
      <span className={`font-mono text-lg ${className ?? ""}`}>{value}</span>
    </p>
  );
}

function MoveStrip({ candles, windowStart }: { candles: Candle[]; windowStart: number }) {
  const rows = useMoves();
  const marks = [15, 10, 5, 0].map((min) => {
    const t = windowStart + (15 - min) * 60;
    const candle = [...candles].reverse().find((c) => c.t <= t);
    return { label: min === 0 ? "Now" : `${min}m ago`, px: candle?.c ?? null };
  });
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-muted">MOVEMENT</p>
      <div className="mt-3 grid grid-cols-3 gap-3 sm:grid-cols-6">
        {rows.map((row) => (
          <div key={row.label}>
            <p className="text-xs text-muted">{row.label}</p>
            <p className={`flex items-center gap-1 font-mono ${toneClass(row.delta)}`}>
              <Dir n={row.delta} />
              {row.delta == null ? "—" : `$${Math.abs(row.delta).toFixed(0)}`}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {marks.map((mark) => (
          <p key={mark.label} className="text-sm">
            <span className="block text-xs text-muted">{mark.label}</span>
            <span className="font-mono">{money(mark.px)}</span>
          </p>
        ))}
      </div>
    </section>
  );
}

function DayChart({ candles, windowStart }: { candles: Candle[]; windowStart: number }) {
  const [px, setPx] = useState<number | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setReady(true);
    const id = window.setInterval(() => setPx(useLive.getState().price), 5000);
    setPx(useLive.getState().price);
    return () => window.clearInterval(id);
  }, []);
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const today = ready ? candles.filter((c) => c.t * 1000 >= dayStart.getTime()) : [];
  const shown = today.length >= 2 ? today : candles.slice(-48);
  const open = shown[0]?.o ?? null;
  const high = shown.length ? Math.max(...shown.map((c) => c.h)) : null;
  const low = shown.length ? Math.min(...shown.map((c) => c.l)) : null;
  const diff = px != null && open != null ? px - open : null;
  const pct = diff != null && open ? (diff / open) * 100 : null;
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-muted">TODAY</p>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <Stat label="Open" value={money(open)} />
        <Stat label="Current" value={money(px)} />
        <Stat label="High" value={money(high)} />
        <Stat label="Low" value={money(low)} />
        <Stat label="Day change" value={diff == null ? "—" : `${diff >= 0 ? "+" : ""}$${Math.round(diff)} · ${pct == null ? "" : `${pct.toFixed(2)}%`}`} className={toneClass(diff)} />
      </div>
      <PriceChart candles={shown} start={open} current={px} shadeFrom={windowStart} />
      <p className="mt-2 text-xs text-muted">Shaded area is the current 15-minute window. 5-minute candles.</p>
    </section>
  );
}

function WhalePanel({ onPick }: { onPick: (event: WhaleEvent) => void }) {
  const trades = useFlow((s) => s.trades);
  const liqs = useFlow((s) => s.liqs);
  const liqStatus = useFlow((s) => s.liqStatus);
  const read = useMemo(() => readWhales(trades, liqs), [trades, liqs]);
  const label = read.label === "buyers" ? "BUYERS ACTIVE" : read.label === "sellers" ? "SELLERS ACTIVE" : read.label === "unusual" ? "UNUSUAL ACTIVITY" : "QUIET";
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-muted">WHALE RADAR</p>
      <p className={`mt-2 text-xl font-medium ${read.label === "buyers" ? "text-up" : read.label === "sellers" ? "text-down" : "text-muted"}`}>{label}</p>
      {!read.available ? (
        <p className="mt-2 text-sm text-muted">{read.sentence}</p>
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <p><span className="block text-xs text-muted">Buy pressure</span><span className="font-mono text-up">{usdCompact(read.buyUsd)}</span></p>
            <p><span className="block text-xs text-muted">Sell pressure</span><span className="font-mono text-down">{usdCompact(read.sellUsd)}</span></p>
            <p><span className="block text-xs text-muted">Net</span><span className={`font-mono ${toneClass(read.netUsd)}`}>{usdCompact(read.netUsd)}</span></p>
          </div>
          <p className="mt-3 text-sm">{read.sentence}</p>
          <ul className="mt-3 space-y-2">
            {read.events.map((event) => (
              <li key={event.id}>
                <button type="button" className="flex w-full items-center justify-between rounded-md border border-line px-3 py-2 text-left text-sm" onClick={() => onPick(event)}>
                  <span>{event.note}</span>
                  <span className="font-mono">{usdCompact(event.usd)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="mt-3 text-xs text-muted">
        Market prints are Coinbase trades larger than recent normal size. {liqStatus === "live" ? "Binance liquidation stream is connected." : "Liquidation stream unavailable."} Wallet transfers are not shown. X reports are separate.
      </p>
    </section>
  );
}

function XPanel() {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs tracking-widest text-muted">X PULSE</p>
      <p className="mt-2 text-xl font-medium text-muted">OFF</p>
      <p className="mt-2 text-sm">X signals are off, so this panel does not search or spend anything.</p>
    </section>
  );
}

function EventCard({ event, onClose }: { event: WhaleEvent; onClose: () => void }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium">{event.note}</p>
        <button type="button" className="text-sm text-muted" onClick={onClose}>Close</button>
      </div>
      <p className="mt-2 text-sm text-muted">{new Date(event.t).toLocaleTimeString()}</p>
      <p className="font-mono text-lg">{usdCompact(event.usd)}</p>
      <p className="mt-2 text-sm">This is a market print, not a wallet transfer. Direction comes from the trade itself.</p>
      <p className="mt-1 text-xs text-muted">Source: {event.kind.includes("liq") ? "Binance BTCUSDT liquidations" : "Coinbase BTC-USD matches"} · Confidence: observed</p>
    </section>
  );
}

function Recent({ scored, journal }: { scored: ReturnType<typeof scorePastWindows>; journal: JournalRow[] }) {
  const rows = scored.slice(0, 8).map((row) => {
    const saved = journal.find((item) => item.start === row.start);
    return {
      start: row.start,
      move: saved ? saved.close - saved.open : row.move,
      signal: saved?.signal ?? (row.verdict === "WAIT" ? "wait" : row.move >= 0 ? "up" : "down"),
      verdict: saved?.verdict ?? row.verdict,
      saved: Boolean(saved),
    };
  });
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="text-lg font-medium">Recent windows</h2>
      <ul className="mt-3 space-y-3">
        {rows.length === 0 ? <li className="text-sm text-muted">Waiting for a finished window.</li> : null}
        {rows.map((row) => (
          <li key={row.start} className="border-t border-line pt-3 text-sm">
            <p className="text-muted">{new Date(row.start * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</p>
            <p>Prediction: {row.saved ? row.signal.toUpperCase() : "NOT SAVED"}</p>
            <p className={toneClass(row.move)}>BTC {row.move >= 0 ? "+" : ""}${Math.abs(row.move).toFixed(0)}</p>
            <p>{row.saved ? row.verdict : "Price history only"}</p>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-muted">Saved calls are from this browser after a window closes. Older rows are price history, not scored trades. Past results do not predict the next one.</p>
    </section>
  );
}

function Performance({ journal }: { journal: JournalRow[] }) {
  const todayKey = new Date().toDateString();
  const today = journal.filter((row) => new Date(row.start * 1000).toDateString() === todayKey);
  const decided = today.filter((row) => row.verdict !== "WAIT");
  const hits = decided.filter((row) => row.verdict === "CORRECT").length;
  const priceOnlyHits = decided.filter((row) => {
    if (row.priceP == null) return false;
    const call = row.priceP >= 0.55 ? "up" : row.priceP <= 0.45 ? "down" : "wait";
    if (call === "wait") return false;
    const up = row.close >= row.open;
    return call === "up" ? up : !up;
  }).length;
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <h2 className="text-lg font-medium">Today's model performance</h2>
      {decided.length < 4 ? (
        <p className="mt-2 text-sm text-muted">Limited sample. {today.length} saved windows today. Accuracy is not meaningful yet.</p>
      ) : (
        <p className="mt-2 text-sm">
          {hits} correct, {decided.length - hits} wrong, {today.length - decided.length} wait. Directional {((hits / decided.length) * 100).toFixed(0)}% of {decided.length}.
        </p>
      )}
      <p className="mt-2 text-sm text-muted">
        Price-only correct calls in this sample: {priceOnlyHits}. Full model: {hits}. Same windows only. This does not prove X or whales help.
      </p>
    </section>
  );
}

function Advanced({ market }: { market: Snapshot["market"] }) {
  const cents = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}¢`);
  return (
    <details className="rounded-xl border border-line bg-surface p-4">
      <summary className="cursor-pointer text-sm text-muted">Advanced details</summary>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div className="flex justify-between gap-3"><dt className="text-muted">Kalshi YES / NO</dt><dd className="font-mono">{cents(market?.yesAsk)} / {cents(market?.noAsk)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted">Kalshi target</dt><dd className="font-mono">{market?.strike == null ? "—" : money(market.strike)}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-muted">Price source: Coinbase BTC-USD. Large trades use that same feed. Liquidations use Binance USD-M public prints. X reports are unconfirmed and never treated as trades.</p>
    </details>
  );
}
