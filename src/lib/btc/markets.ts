import { createServerFn } from "@tanstack/react-start";

export type PolyRead = {
  ok: boolean;
  comparable: boolean;
  title: string | null;
  up: number | null;
  volume: number | null;
  note: string;
};

let cache: { at: number; read: PolyRead } | null = null;

export const getPolymarket = createServerFn({ method: "GET" }).handler(async (): Promise<PolyRead> => {
  const now = Date.now();
  if (cache && now - cache.at < 45_000) return cache.read;
  const fail = (note: string): PolyRead => ({ ok: false, comparable: false, title: null, up: null, volume: null, note });
  try {
    const res = await fetch(
      "https://gamma-api.polymarket.com/public-search?q=bitcoin%20up%20or%20down",
      { headers: { accept: "application/json" } },
    );
    if (!res.ok) {
      const read = fail(`DATA UNAVAILABLE (${res.status})`);
      cache = { at: now, read };
      return read;
    }
    const body = (await res.json()) as {
      events?: { title?: string; endDate?: string; markets?: { question?: string; outcomePrices?: string; volume?: string }[] }[];
    };
    const events = body.events ?? [];
    const soon = events
      .flatMap((event) =>
        (event.markets ?? []).map((market) => ({
          title: market.question ?? event.title ?? null,
          end: Date.parse(event.endDate ?? ""),
          prices: market.outcomePrices,
          volume: Number(market.volume),
        })),
      )
      .filter((row) => row.title && /bitcoin|btc/i.test(row.title) && /up|higher|above/i.test(row.title));
    const picked = soon.sort((a, b) => Math.abs((a.end || 0) - now) - Math.abs((b.end || 0) - now))[0];
    if (!picked || !picked.prices) {
      const read = fail("DATA UNAVAILABLE");
      cache = { at: now, read };
      return read;
    }
    let up: number | null = null;
    try {
      const parsed = JSON.parse(picked.prices) as string[];
      const n = Number(parsed[0]);
      up = Number.isFinite(n) ? n : null;
    } catch {
      up = null;
    }
    const read: PolyRead = {
      ok: up != null,
      comparable: false,
      title: picked.title,
      up,
      volume: Number.isFinite(picked.volume) ? picked.volume : null,
      note: "MARKET NOT DIRECTLY COMPARABLE — public Polymarket question and clock are not verified as the same 15-minute window.",
    };
    cache = { at: now, read };
    return read;
  } catch {
    const read = fail("DATA UNAVAILABLE");
    cache = { at: now, read };
    return read;
  }
});
