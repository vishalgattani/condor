import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, BarChart2, Terminal } from "lucide-react";

import { api, type IndicatorCandle, type PaperTrade, type PaperTradeBot } from "@/lib/api";
import { pnlColor } from "@/lib/formatters";

// ── Helpers ──

function fmt(ts: string) {
  const d = new Date(ts);
  return d.toLocaleString("en-US", {
    month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
}

function fmtPrice(v: number) {
  return v >= 1000
    ? "$" + v.toLocaleString("en-US", { maximumFractionDigits: 2 })
    : "$" + v.toFixed(4);
}

function sign(v: number) { return v >= 0 ? "+" : ""; }

// Parse interval string from bot name: "bot-5m-eth-usd-..." → "5m"
function botInterval(botName: string): string {
  const m = botName.match(/^bot-(\d+[mhd])-/);
  return m ? m[1] : "5m";
}

// Parse pair from bot name: "bot-5m-eth-usd-..." → "ETH-USD"
function botPair(botName: string): string {
  const m = botName.match(/^bot-\d+[mhd]-([a-z]+-[a-z]+)-/);
  return m ? m[1].toUpperCase() : "ETH-USD";
}

// How often to refetch indicators based on candle interval
function indicatorRefetchMs(interval: string): number {
  if (interval.endsWith("h")) return 60_000;
  const mins = parseInt(interval);
  return Math.max(Math.floor(mins * 60_000 / 2), 15_000);
}

const INTERVALS = ["5m", "15m", "1h", "4h"] as const;
type Interval = typeof INTERVALS[number];

// ── RSI + EMA chart ──

function IndicatorChart({ botName }: { botName: string }) {
  const defaultInterval = (botInterval(botName) as Interval) ?? "5m";
  const pair = botPair(botName);

  const [interval, setInterval] = useState<Interval>(
    INTERVALS.includes(defaultInterval) ? defaultInterval : "5m"
  );

  const { data, isLoading } = useQuery({
    queryKey: ["indicators", pair, interval],
    queryFn: () => api.getIndicators(pair, interval, 60),
    refetchInterval: indicatorRefetchMs(interval),
  });

  const fmtTime = (t: number) => {
    const d = new Date(t * 1000);
    return interval.endsWith("h")
      ? d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", hour12: false })
      : d.toLocaleString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  };

  const candles: IndicatorCandle[] = data?.candles ?? [];

  if (isLoading) return (
    <div className="flex h-40 items-center justify-center text-[var(--color-text-muted)] text-xs">
      Loading {pair} {interval} candles…
    </div>
  );

  if (!candles.length) return (
    <div className="flex h-40 items-center justify-center text-[var(--color-text-muted)] text-xs">
      No candle data returned.
    </div>
  );

  const prices = candles.map((c) => c.close);
  const yMin = Math.floor(Math.min(...prices) * 0.9995);
  const yMax = Math.ceil(Math.max(...prices) * 1.0005);

  const tickProps = { fontSize: 10, fill: "var(--color-text-muted)" };
  const gridProps = { strokeDasharray: "3 3", stroke: "var(--color-border)", strokeOpacity: 0.4 };
  const xAxisProps = {
    dataKey: "time" as const,
    tickFormatter: fmtTime,
    tick: tickProps,
    stroke: "var(--color-border)",
    tickLine: false,
    minTickGap: 48,
  };

  return (
    <div className="space-y-0">
      {/* Interval picker */}
      <div className="flex items-center gap-1 pb-3">
        {INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval(iv)}
            className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
              iv === interval
                ? "bg-[var(--color-primary)] text-white"
                : "bg-[var(--color-surface-hover)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            }`}
          >
            {iv}
          </button>
        ))}
        <span className="ml-2 text-[10px] text-[var(--color-text-muted)]">{pair}</span>
      </div>

      {/* Price + EMA panel */}
      <div>
        <div className="flex items-center gap-3 pb-1 text-[10px] text-[var(--color-text-muted)]">
          <span className="font-bold uppercase tracking-widest">Price + EMA</span>
          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-blue-400" />EMA 9</span>
          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-4 bg-orange-400" />EMA 21</span>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <ComposedChart data={candles} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis
              domain={[yMin, yMax]}
              tickFormatter={(v) => `$${v.toLocaleString()}`}
              tick={tickProps}
              stroke="var(--color-border)"
              tickLine={false}
              axisLine={false}
              width={72}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const c = payload[0].payload as IndicatorCandle;
                return (
                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-2.5 py-2 text-[10px] shadow-lg space-y-0.5">
                    <div className="text-[var(--color-text-muted)]">{fmtTime(c.time)}</div>
                    <div>Close: <span className="font-mono font-semibold">{fmtPrice(c.close)}</span></div>
                    {c.ema_fast != null && <div className="text-blue-400">EMA9: {fmtPrice(c.ema_fast)}</div>}
                    {c.ema_slow != null && <div className="text-orange-400">EMA21: {fmtPrice(c.ema_slow)}</div>}
                  </div>
                );
              }}
            />
            <Line type="monotone" dataKey="close" stroke="var(--color-text-muted)" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="ema_fast" stroke="#60a5fa" strokeWidth={1.5} dot={false} connectNulls />
            <Line type="monotone" dataKey="ema_slow" stroke="#fb923c" strokeWidth={1.5} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* RSI panel */}
      <div>
        <div className="pb-1 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">RSI (14)</div>
        <ResponsiveContainer width="100%" height={120}>
          <ComposedChart data={candles} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 30, 50, 70, 100]}
              tick={tickProps}
              stroke="var(--color-border)"
              tickLine={false}
              axisLine={false}
              width={32}
            />
            <Tooltip
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const c = payload[0].payload as IndicatorCandle;
                const rsi = c.rsi;
                if (rsi == null) return null;
                const color = rsi < 30 ? "#22c55e" : rsi > 70 ? "#ef4444" : "var(--color-text)";
                return (
                  <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-2.5 py-2 text-[10px] shadow-lg">
                    <div className="text-[var(--color-text-muted)]">{fmtTime(c.time)}</div>
                    <div style={{ color }}>RSI: <span className="font-mono font-semibold">{rsi.toFixed(1)}</span></div>
                  </div>
                );
              }}
            />
            <ReferenceLine y={70} stroke="#ef4444" strokeOpacity={0.5} strokeDasharray="3 3" />
            <ReferenceLine y={30} stroke="#22c55e" strokeOpacity={0.5} strokeDasharray="3 3" />
            <ReferenceLine y={50} stroke="var(--color-text-muted)" strokeOpacity={0.2} strokeDasharray="2 4" />
            <Line type="monotone" dataKey="rsi" stroke="#a78bfa" strokeWidth={1.5} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="pt-1 text-[10px] text-[var(--color-text-muted)]">
        refreshes every {indicatorRefetchMs(interval) / 1000}s
      </div>
    </div>
  );
}

// ── Cumulative P/L chart ──

interface ChartPoint { time: number; pnl: number }

function PnlChart({ trades }: { trades: PaperTrade[] }) {
  const data = useMemo<ChartPoint[]>(() => {
    const sells = trades.filter((t) => t.side === "SELL");
    if (sells.length === 0) return [];
    return sells.map((t) => ({
      time: new Date(t.timestamp).getTime(),
      pnl: t.cumulative_pnl_usd ?? 0,
    }));
  }, [trades]);

  if (data.length < 2) return (
    <div className="flex h-48 items-center justify-center text-[var(--color-text-muted)] text-sm">
      Waiting for closed trades to chart…
    </div>
  );

  const latest = data[data.length - 1].pnl;
  const lineColor = latest >= 0 ? "#22c55e" : "#ef4444";

  const fmtTime = (ms: number) =>
    new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });

  return (
    <ResponsiveContainer width="100%" height={200}>
      <ComposedChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
        <defs>
          <linearGradient id="paperPnlGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor={lineColor} stopOpacity={0.2} />
            <stop offset="95%" stopColor={lineColor} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" strokeOpacity={0.4} />
        <XAxis
          dataKey="time"
          type="number"
          domain={["dataMin", "dataMax"]}
          tickFormatter={fmtTime}
          tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
          stroke="var(--color-border)"
          tickLine={false}
        />
        <YAxis
          tickFormatter={(v) => `$${v.toFixed(2)}`}
          tick={{ fontSize: 10, fill: "var(--color-text-muted)" }}
          stroke="var(--color-border)"
          tickLine={false}
          axisLine={false}
          width={56}
        />
        <ReferenceLine y={0} stroke="var(--color-text-muted)" strokeOpacity={0.4} strokeDasharray="4 4" />
        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload?.length || label == null) return null;
            const pnl = payload[0].value as number;
            const labelMs = typeof label === "number" ? label : Number(label);
            return (
              <div className="rounded border border-[var(--color-border)] bg-[var(--color-bg)]/95 px-2.5 py-2 text-xs shadow-lg">
                <div className="text-[var(--color-text-muted)] mb-1">{fmtTime(labelMs)}</div>
                <div style={{ color: pnlColor(pnl) }} className="font-semibold">
                  {sign(pnl)}${pnl.toFixed(2)}
                </div>
              </div>
            );
          }}
        />
        <Area type="monotone" dataKey="pnl" stroke="none" fill="url(#paperPnlGrad)" activeDot={false} />
        <Area type="monotone" dataKey="pnl" stroke={lineColor} strokeWidth={2} fill="none" dot={{ r: 3, fill: lineColor }} />
      </ComposedChart>
    </ResponsiveContainer>
  );
}

// ── KPI card ──

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums" style={color ? { color } : undefined}>{value}</p>
      {sub && <p className="text-xs text-[var(--color-text-muted)]">{sub}</p>}
    </div>
  );
}

// ── Trade table ──

function TradeTable({ trades }: { trades: PaperTrade[] }) {
  const sells = trades.filter((t) => t.side === "SELL");
  if (sells.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            {["#", "Time (UTC)", "Entry", "Exit", "P/L $", "P/L %", "Cumul $", "RSI", "Reason"].map((h) => (
              <th key={h} className="px-3 py-2 text-left text-[10px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[...sells].reverse().map((t) => {
            const pnl = t.pnl_usd ?? 0;
            const col = pnlColor(pnl);
            const buy = trades.find((b) => b.side === "BUY" && b.trade_num === t.trade_num);
            return (
              <tr key={`${t.trade_num}-sell`} className="border-b border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors">
                <td className="px-3 py-2 font-mono text-[var(--color-text-muted)]">{t.trade_num}</td>
                <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">{fmt(t.timestamp)}</td>
                <td className="px-3 py-2 tabular-nums">{buy ? fmtPrice(buy.price) : "—"}</td>
                <td className="px-3 py-2 tabular-nums">{fmtPrice(t.price)}</td>
                <td className="px-3 py-2 tabular-nums font-semibold" style={{ color: col }}>{sign(pnl)}${pnl.toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums" style={{ color: col }}>{sign(t.pnl_pct ?? 0)}{(t.pnl_pct ?? 0).toFixed(2)}%</td>
                <td className="px-3 py-2 tabular-nums text-[var(--color-text-muted)]">${(t.cumulative_pnl_usd ?? 0).toFixed(2)}</td>
                <td className="px-3 py-2 tabular-nums">{t.rsi.toFixed(1)}</td>
                <td className="px-3 py-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                    t.reason === "TP" ? "bg-green-500/15 text-green-400" :
                    t.reason === "SL" ? "bg-red-500/15 text-red-400" :
                    "bg-amber-500/15 text-amber-400"
                  }`}>
                    {t.reason}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Bot selector tab ──

function BotTab({ bot, active, onClick }: { bot: PaperTradeBot; active: boolean; onClick: () => void }) {
  const pnl = bot.summary?.total_pnl ?? 0;
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-start rounded-lg border px-3 py-2 text-left text-xs transition-all ${
        active
          ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10"
          : "border-[var(--color-border)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)]"
      }`}
    >
      <div className="flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${bot.running ? "bg-green-400" : "bg-[var(--color-text-muted)]"}`} />
        <span className="font-mono text-[10px] text-[var(--color-text-muted)] truncate max-w-[180px]">{bot.bot_name}</span>
      </div>
      <span className="font-semibold tabular-nums" style={{ color: pnlColor(pnl) }}>
        {sign(pnl)}${pnl.toFixed(2)}
      </span>
    </button>
  );
}

// ── Log viewer ──

function BotLogViewer({ botName }: { botName: string }) {
  const [open, setOpen] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const { data, dataUpdatedAt } = useQuery({
    queryKey: ["bot-logs", botName],
    queryFn: () => api.getBotLogs(botName, 150),
    refetchInterval: open ? 5_000 : false,
    enabled: open,
  });

  useEffect(() => {
    if (open && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [dataUpdatedAt, open]);

  function lineColor(line: string) {
    if (line.includes(" - ERROR") || line.includes("Traceback") || line.includes("EAPI"))
      return "text-red-400";
    if (line.includes(" - WARNING") || line.includes("rate limit"))
      return "text-amber-400";
    if (line.includes("BUY") || line.includes("SELL") || line.includes("PAPER"))
      return "text-green-400";
    return "text-[var(--color-text-muted)]";
  }

  return (
    <div className="rounded-lg border border-[var(--color-border)]">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)] transition-colors rounded-lg"
      >
        <Terminal className="h-3.5 w-3.5" />
        <span>Bot Logs</span>
        <span className="ml-auto text-[10px]">{open ? "▲ hide" : "▼ show"}</span>
      </button>
      {open && (
        <div className="border-t border-[var(--color-border)] bg-[#0d0d0d] rounded-b-lg overflow-hidden">
          <div className="h-72 overflow-y-auto p-3 font-mono text-[10px] leading-relaxed">
            {data?.lines.length === 0 && (
              <span className="text-[var(--color-text-muted)]">No log file found yet.</span>
            )}
            {data?.lines.map((line, i) => (
              <div key={i} className={lineColor(line)}>{line}</div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="border-t border-[var(--color-border)] px-3 py-1.5 text-[10px] text-[var(--color-text-muted)]">
            Last 150 lines · refreshes every 5s
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ──

export function PaperTrades() {
  const { data: bots, isLoading, error } = useQuery({
    queryKey: ["paper-trades"],
    queryFn: api.getPaperTrades,
    refetchInterval: 30_000,
  });

  const [selectedBot, setSelectedBot] = useState<string | null>(null);
  const [showChart, setShowChart] = useState(true);

  const activeBotName = selectedBot ?? bots?.[0]?.bot_name ?? null;
  const bot = bots?.find((b) => b.bot_name === activeBotName) ?? null;
  const s = bot?.summary;

  if (isLoading) return (
    <div className="flex h-64 items-center justify-center text-[var(--color-text-muted)] text-sm">
      Loading paper trade history…
    </div>
  );

  if (error) return (
    <div className="flex h-64 items-center justify-center text-red-400 text-sm">
      Failed to load: {(error as Error).message}
    </div>
  );

  if (!bots || bots.length === 0) return (
    <div className="flex flex-col items-center justify-center gap-3 h-64 text-[var(--color-text-muted)]">
      <Activity className="h-8 w-8 opacity-30" />
      <p className="text-sm">No paper trade bots found.</p>
      <p className="text-xs">Deploy one: <code className="bg-[var(--color-surface)] px-1 rounded">./bot_add.sh --name my-trader</code></p>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-lg font-semibold">Paper Trades</h1>
          <p className="text-xs text-[var(--color-text-muted)]">Simulated trades — live Kraken prices, no real orders</p>
        </div>
        <button
          onClick={() => setShowChart((v) => !v)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
            showChart
              ? "border-[var(--color-primary)] bg-[var(--color-primary)]/10 text-[var(--color-primary)]"
              : "border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface-hover)]"
          }`}
        >
          <BarChart2 className="h-3.5 w-3.5" />
          {showChart ? "Hide chart" : "Show chart"}
        </button>
      </div>

      {/* Bot tabs (only when multiple bots) */}
      {bots.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {bots.map((b) => (
            <BotTab
              key={b.bot_name}
              bot={b}
              active={b.bot_name === activeBotName}
              onClick={() => setSelectedBot(b.bot_name)}
            />
          ))}
        </div>
      )}

      {bot && (
        <>
          {/* Single-bot name + status */}
          {bots.length === 1 && (
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${bot.running ? "bg-green-400 shadow-[0_0_6px_#4ade80]" : "bg-[var(--color-text-muted)]"}`} />
              <p className="font-mono text-xs text-[var(--color-text-muted)]">{bot.bot_name}</p>
              <span className={`text-[10px] font-medium ${bot.running ? "text-green-400" : "text-[var(--color-text-muted)]"}`}>
                {bot.running ? "running" : "stopped"}
              </span>
            </div>
          )}

          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <KpiCard
              label="Total P/L"
              value={`${sign(s?.total_pnl ?? 0)}$${(s?.total_pnl ?? 0).toFixed(2)}`}
              color={pnlColor(s?.total_pnl ?? 0)}
            />
            <KpiCard
              label="Closed Trades"
              value={String(s?.closed_trades ?? 0)}
              sub={`${s?.wins ?? 0}W / ${s?.losses ?? 0}L`}
            />
            <KpiCard
              label="Win Rate"
              value={s?.closed_trades ? `${s.win_rate.toFixed(1)}%` : "—"}
              sub={s?.avg_win ? `avg +$${s.avg_win.toFixed(2)} / $${s.avg_loss.toFixed(2)}` : undefined}
            />
            <KpiCard
              label="Open Position"
              value={s?.open_trade ? `#${s.open_trade.trade_num} LONG` : "Flat"}
              sub={s?.open_trade ? `@ ${fmtPrice(s.open_trade.price)}` : undefined}
              color={s?.open_trade ? "#f59e0b" : undefined}
            />
          </div>

          {/* RSI + EMA chart (toggleable) */}
          {showChart && (
            <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
              <IndicatorChart botName={bot.bot_name} />
            </div>
          )}

          {/* Cumulative P/L chart */}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-3">
            <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-widest text-[var(--color-text-muted)]">
              Cumulative P/L
            </p>
            <PnlChart trades={bot.trades} />
          </div>

          {/* Trade table */}
          <TradeTable trades={bot.trades} />

          {/* Log viewer */}
          <BotLogViewer botName={bot.bot_name} />
        </>
      )}
    </div>
  );
}
