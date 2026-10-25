import { useEffect, useMemo, useState } from "react";
import { formatCost } from "../../core/cost";
import type { Strings } from "../../core/i18n";
import { PROVIDERS } from "../../core/providers";
import type { HistoryEntry } from "../../core/types";
import { summarizeUsage, USAGE_PROVIDERS, USAGE_WINDOWS, type UsageColumn, type UsageProvider, type UsageSummary, type UsageWindow } from "../../core/usage";
import { useStrings } from "../lang";

// What dictation cost and how much was said, per period: after T3 Code's Usage page.

type Metric = "cost" | "minutes";

const COLORS: Record<UsageProvider, string> = { openai: "#10a37f", gemini: "#4c8df6", other: "#a1a1aa" };

const providerName = (p: UsageProvider, tr: Strings) => (p === "other" ? tr.usage.other : PROVIDERS[p].name);
const minutesOf = (ms: number) => Math.round(ms / 60_000);

export function UsagePanel() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [period, setPeriod] = useState<UsageWindow>(30);
  const [metric, setMetric] = useState<Metric>("cost");
  const tr = useStrings();

  useEffect(() => {
    void ciao.history.list().then(setEntries);
    return ciao.history.onChanged((e) =>
      setEntries((list) => list && (list.some((x) => x.id === e.id) ? list.map((x) => (x.id === e.id ? e : x)) : [e, ...list])),
    );
  }, []);

  // The periods end now: move them on while the tab stays open (past midnight, the next hour).
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);

  const summary = useMemo(
    () => entries && summarizeUsage(entries.map((e) => ({ ...e, createdAt: Date.parse(e.createdAt) })), period, now),
    [entries, period, now],
  );
  if (!summary) return null;

  const { total } = summary;
  const since = new Date(summary.from).toLocaleDateString(tr.locale, { day: "numeric", month: "long", year: "numeric" });
  const perDay = summary.activeDays ? total.usd / summary.activeDays : 0;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pt-5 pb-16">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <Toggle options={USAGE_WINDOWS.map((w) => ({ value: w, label: tr.usage.windows[w] }))} value={period} onChange={setPeriod} />
          <Toggle options={(["cost", "minutes"] as const).map((m) => ({ value: m, label: tr.usage.metrics[m] }))} value={metric} onChange={setMetric} />
        </div>

        <div className="mb-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Tile label={tr.usage.cost} value={formatCost(total.usd)} hint={tr.usage.since(since)} />
          <Tile label={tr.usage.minutes} value={tr.usage.duration(minutesOf(total.ms))} />
          <Tile label={tr.usage.dictations} value={total.count.toLocaleString(tr.locale)} />
          <Tile label={tr.usage.perDay} value={formatCost(perDay)} hint={summary.activeDays ? tr.usage.perDayHint(summary.activeDays) : undefined} />
        </div>

        {total.count === 0 ? (
          <div className="mt-16 text-center text-[14px] text-faint">{tr.usage.empty}</div>
        ) : (
          <>
            <Chart summary={summary} metric={metric} />
            <Models summary={summary} metric={metric} />
          </>
        )}
        <p className="mt-6 text-[12px] leading-relaxed text-ghost">{tr.usage.note}</p>
      </div>
    </div>
  );
}

function Toggle<T extends string | number>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-0.5 rounded-xl bg-tint/5 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-[10px] px-2.5 py-1 text-[12.5px] transition-colors ${o.value === value ? "bg-card text-fg shadow-sm ring-1 ring-tint/[0.07]" : "text-muted hover:text-fg"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl bg-card px-4 py-3 ring-1 ring-tint/[0.07]">
      <div className="text-[12px] text-faint">{label}</div>
      <div className="mt-0.5 text-[20px] font-semibold tracking-tight text-fg tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 truncate text-[11.5px] text-ghost">{hint}</div>}
    </div>
  );
}

const W = 720;
const H = 200;
const LEFT = 44;
const TOP = 10;
const BOTTOM = 22;

function Chart({ summary, metric }: { summary: UsageSummary; metric: Metric }) {
  const [hover, setHover] = useState<number | null>(null);
  const tr = useStrings();
  const value = (t: { usd: number; ms: number }) => (metric === "cost" ? t.usd : t.ms / 60_000);
  const format = (v: number) => (metric === "cost" ? formatCost(v) : tr.usage.duration(Math.round(v)));
  const { columns } = summary;
  const max = Math.max(...columns.map((c) => value(c.total)), metric === "cost" ? 0.01 : 1);
  const step = niceStep(max / 3);
  const top = Math.ceil(max / step) * step;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const plotW = W - LEFT;
  const plotH = H - BOTTOM - TOP;
  const slot = plotW / columns.length;
  const bar = Math.max(1, Math.min(28, slot * 0.7));
  const y = (v: number) => TOP + plotH - (v / top) * plotH;
  const label = (c: UsageColumn) =>
    summary.resolution === "hour"
      ? new Date(c.start).toLocaleTimeString(tr.locale, { hour: "2-digit", minute: "2-digit" })
      : new Date(c.start).toLocaleDateString(tr.locale, { day: "numeric", month: "short" });
  // About six dates along the axis, the last column always among them.
  const every = Math.max(1, Math.ceil(columns.length / 6));
  const shown = hover !== null ? columns[hover] : null;
  const used = USAGE_PROVIDERS.filter((p) => columns.some((c) => value(c.byProvider[p]) > 0));

  return (
    <section className="mb-6 rounded-2xl bg-card px-4 pt-3 pb-2 ring-1 ring-tint/[0.07]">
      <div className="mb-2 flex min-h-5 flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
        {shown ? (
          <>
            <span className="font-medium text-fg2">{label(shown)}</span>
            {used.map((p) => (
              <Legend key={p} provider={p} value={format(value(shown.byProvider[p]))} />
            ))}
            <span className="ml-auto text-faint tabular-nums">
              {formatCost(shown.total.usd)} · {tr.usage.duration(minutesOf(shown.total.ms))}
            </span>
          </>
        ) : (
          used.map((p) => <Legend key={p} provider={p} />)
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={LEFT} x2={W} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-tint/[0.07]" />
            <text x={LEFT - 6} y={y(t) + 3.5} textAnchor="end" className="fill-ghost text-[10px] tabular-nums">
              {metric === "cost" ? formatCost(t) : Math.round(t)}
            </text>
          </g>
        ))}
        {columns.map((c, i) => {
          const x = LEFT + i * slot + (slot - bar) / 2;
          let base = 0;
          return (
            <g key={c.start} onMouseEnter={() => setHover(i)}>
              <rect x={LEFT + i * slot} y={TOP} width={slot} height={plotH} fill="transparent" className={hover === i ? "fill-tint/[0.04]" : ""} />
              {USAGE_PROVIDERS.map((p) => {
                const v = value(c.byProvider[p]);
                if (v <= 0) return null;
                const y0 = y(base);
                base += v;
                return <rect key={p} x={x} y={y(base)} width={bar} height={Math.max(0.5, y0 - y(base))} rx={Math.min(3, bar / 4)} fill={COLORS[p]} />;
              })}
              {(i % every === (columns.length - 1) % every) && (
                <text
                  x={i === columns.length - 1 ? W : LEFT + i * slot + slot / 2}
                  y={H - 6}
                  textAnchor={i === columns.length - 1 ? "end" : "middle"}
                  className="fill-ghost text-[10px]"
                >
                  {label(c)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </section>
  );
}

function Legend({ provider, value }: { provider: UsageProvider; value?: string }) {
  const tr = useStrings();
  return (
    <span className="flex items-center gap-1.5">
      <span className="size-2 rounded-[3px]" style={{ backgroundColor: COLORS[provider] }} />
      <span className="text-faint">{providerName(provider, tr)}</span>
      {value && <span className="text-fg2 tabular-nums">{value}</span>}
    </span>
  );
}

/** 1, 2 or 5 times a power of ten, at least [raw]. */
function niceStep(raw: number): number {
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((s) => s >= raw)!;
}

function Models({ summary, metric }: { summary: UsageSummary; metric: Metric }) {
  const tr = useStrings();
  const value = (m: { usd: number; ms: number }) => (metric === "cost" ? m.usd : m.ms);
  const total = summary.models.reduce((s, m) => s + value(m), 0);
  if (!summary.models.length) return null;
  return (
    <section>
      <h2 className="mb-2 px-1 text-[12px] font-semibold tracking-wide text-faint uppercase">{tr.usage.byModel}</h2>
      <div className="overflow-hidden rounded-2xl bg-card ring-1 ring-tint/[0.07]">
        <div className="flex items-center gap-3 border-b border-tint/[0.05] px-4 py-2 text-[11.5px] text-ghost">
          <span className="min-w-0 flex-1 pl-5">{tr.usage.model}</span>
          <span className="hidden w-28 sm:block" />
          <span className="w-10" />
          <span className="w-12 text-right">{tr.usage.dictations}</span>
          <span className="w-24 text-right">{tr.usage.minutes}</span>
          <span className="w-16 text-right">{tr.usage.cost}</span>
        </div>
        {summary.models.map((m) => {
          const share = total ? value(m) / total : 0;
          return (
            <div key={m.model} className="flex items-center gap-3 border-b border-tint/[0.05] px-4 py-2.5 text-[13px] last:border-0">
              <span className="size-2 shrink-0 rounded-[3px]" style={{ backgroundColor: COLORS[m.provider] }} />
              <span className="min-w-0 flex-1 truncate font-medium text-fg2">{m.model}</span>
              <div className="hidden h-1.5 w-28 overflow-hidden rounded-full bg-tint/[0.06] sm:block">
                <div className="h-full rounded-full" style={{ width: `${share * 100}%`, backgroundColor: COLORS[m.provider] }} />
              </div>
              <span className="w-10 text-right text-[12px] text-ghost tabular-nums">{Math.round(share * 100)}%</span>
              <span className="w-12 text-right text-[12px] text-faint tabular-nums">{m.count}</span>
              <span className="w-24 text-right text-[12px] text-faint tabular-nums">{tr.usage.duration(minutesOf(m.ms))}</span>
              <span className="w-16 text-right font-medium text-fg tabular-nums">{formatCost(m.usd)}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}
