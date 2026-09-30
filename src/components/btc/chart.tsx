import { useMemo } from "react";
import { CartesianGrid, ComposedChart, Customized, ResponsiveContainer, XAxis, YAxis } from "recharts";
import type { Candle } from "@/lib/btc/types";

export type ChartMark = { t: number; label: string; tone: "up" | "down" | "neutral" };

type Axis = { scale: (v: number) => number };
type ChartProps = {
  yAxisMap?: Record<string, Axis>;
  offset?: { left: number; top: number; width: number; height: number };
};

function moneyShort(n: number) {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

function Overlay(
  props: ChartProps & {
    rows?: Candle[];
    start?: number | null;
    current?: number | null;
    marks?: ChartMark[];
    shadeFrom?: number | null;
    band?: [number, number] | null;
  },
) {
  const yAxis = props.yAxisMap ? Object.values(props.yAxisMap)[0] : undefined;
  const rows = props.rows ?? [];
  if (!yAxis || !props.offset || rows.length === 0) return null;
  const left = props.offset.left;
  const width = props.offset.width;
  const step = width / rows.length;
  const yOf = (price: number) => yAxis.scale(price);
  const xOfTime = (t: number) => {
    let idx = 0;
    for (let i = 0; i < rows.length; i += 1) {
      if ((rows[i]?.t ?? 0) <= t) idx = i;
    }
    return left + idx * step + step / 2;
  };
  const shade =
    props.shadeFrom == null
      ? null
      : (() => {
          const x = xOfTime(props.shadeFrom);
          return <rect x={x} y={props.offset!.top} width={Math.max(8, left + width - x)} height={props.offset!.height} fill="var(--color-accent)" opacity={0.08} />;
        })();
  return (
    <g>
      {shade}
      {props.band ? (
        <rect
          x={left}
          y={Math.min(yOf(props.band[0]), yOf(props.band[1]))}
          width={width}
          height={Math.max(2, Math.abs(yOf(props.band[0]) - yOf(props.band[1])))}
          fill="var(--color-warn)"
          opacity={0.12}
        />
      ) : null}
      {rows.map((c, i) => {
        const bar = Math.max(4, step * 0.62);
        const x = left + i * step + (step - bar) / 2;
        const up = c.c >= c.o;
        const color = up ? "var(--color-up)" : "var(--color-down)";
        const yOpen = yOf(c.o);
        const yClose = yOf(c.c);
        const top = Math.min(yOpen, yClose);
        return (
          <g key={c.t}>
            <line x1={x + bar / 2} x2={x + bar / 2} y1={yOf(c.h)} y2={yOf(c.l)} stroke={color} strokeWidth={1.5} />
            <rect x={x} y={top} width={bar} height={Math.max(2, Math.abs(yClose - yOpen))} fill={color} rx={1} />
          </g>
        );
      })}
      {props.start != null ? (
        <g>
          <line x1={left} x2={left + width} y1={yOf(props.start)} y2={yOf(props.start)} stroke="var(--color-accent)" strokeDasharray="4 4" />
          <text x={left + width - 4} y={yOf(props.start) - 6} textAnchor="end" fill="var(--color-muted)" fontSize={12}>
            START {moneyShort(props.start)}
          </text>
        </g>
      ) : null}
      {props.current != null ? (
        <g>
          <line x1={left} x2={left + width} y1={yOf(props.current)} y2={yOf(props.current)} stroke="var(--color-up)" strokeOpacity={0.7} />
          <text x={left + width - 4} y={yOf(props.current) + 14} textAnchor="end" fill="var(--color-fg)" fontSize={12}>
            NOW {moneyShort(props.current)}
          </text>
        </g>
      ) : null}
      {(props.marks ?? []).slice(0, 6).map((mark) => (
        <circle
          key={`${mark.t}${mark.label}`}
          cx={xOfTime(mark.t)}
          cy={yOf(props.current ?? props.start ?? rows[rows.length - 1]?.c ?? 0)}
          r={5}
          fill={mark.tone === "up" ? "var(--color-up)" : mark.tone === "down" ? "var(--color-down)" : "var(--color-accent)"}
        />
      ))}
    </g>
  );
}

export function PriceChart({
  candles,
  start,
  current,
  marks,
  shadeFrom,
  band,
  tall,
}: {
  candles: Candle[];
  start: number | null;
  current: number | null;
  marks?: ChartMark[];
  shadeFrom?: number | null;
  band?: [number, number] | null;
  tall?: boolean;
}) {
  const data = useMemo(() => candles, [candles]);
  const prices = data.flatMap((c) => [c.h, c.l]);
  if (start) prices.push(start);
  if (current) prices.push(current);
  if (band) prices.push(band[0], band[1]);
  const min = prices.length ? Math.min(...prices) : 0;
  const max = prices.length ? Math.max(...prices) : 1;
  const pad = Math.max(12, (max - min) * 0.18);
  if (data.length < 2) return <p className="px-4 py-16 text-sm text-muted">Waiting for candles.</p>;
  return (
    <div className={tall ? "h-[420px] w-full sm:h-[520px]" : "h-44 w-full"}>
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 18, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--color-line)" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(v: number) => new Date(v * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            domain={[min - pad, max + pad]}
            orientation="right"
            tick={{ fill: "var(--color-muted)", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
            width={58}
            tickFormatter={(v: number) => Math.round(v).toLocaleString("en-US")}
          />
          <Customized
            component={(props: ChartProps) => (
              <Overlay {...props} rows={data} start={start} current={current} marks={marks} shadeFrom={shadeFrom} band={band} />
            )}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
