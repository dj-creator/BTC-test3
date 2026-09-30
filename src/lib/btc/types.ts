export type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
};

export type StrikeRule = "greater_or_equal" | "greater" | "unknown";

export type MarketQuote = {
  ticker: string;
  title: string;
  status: string;
  strike: number | null;
  strikeRule: StrikeRule;
  closeTime: number;
  openTime: number;
  yesBid: number | null;
  yesAsk: number | null;
  noBid: number | null;
  noAsk: number | null;
  volume: number | null;
  openInterest: number | null;
};

export type SettledWindow = {
  ticker: string;
  openTime: number;
  closeTime: number;
  strike: number | null;
  settle: number | null;
  result: "yes" | "no" | "unknown";
  volume: number | null;
};

export type Snapshot = {
  fetchedAt: number;
  spot: number | null;
  spotAt: number | null;
  spotSource: string;
  bookAt: number | null;
  kalshiOk: boolean;
  kalshiError: string | null;
  market: MarketQuote | null;
  candles: Candle[];
  dayCandles: Candle[];
  history: SettledWindow[];
};

export type FeedChoice =
  | "live"
  | "healthy"
  | "kalshi-down"
  | "no-strike"
  | "settlement"
  | "exact-touch"
  | "stale-book"
  | "negative-edge"
  | "stale-spot";

export type ModelView = {
  paused: boolean;
  reason: string | null;
  pUp: number | null;
  yesAsk: number | null;
  noAsk: number | null;
  modelMinusAsk: number | null;
  feeAware: number | null;
  afterBuffer: number | null;
  breakevenYes: number | null;
  matches: number;
  volLabel: string;
  regime: "chop" | "trend" | "settlement-minute";
  call: "NO TRADE" | "WATCH YES" | "WATCH NO" | "PAUSED";
  momentum: number | null;
  sigmaDollar: number | null;
  sigmaToStrike: number | null;
};
