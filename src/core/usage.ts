// What dictation costs over a period: totals, a column per day (per hour for the last 24 hours)
// split by provider, and every model's share. Drawn by the Usage tab (src/renderer/history/UsagePanel.tsx);
// ported to Android as android/…/Usage.kt, whose tests hold this file's outputs.

import type { Provider } from "./types";

/** Days back from now; "all" starts at the first dictation. */
export type UsageWindow = 1 | 7 | 30 | 90 | "all";
export const USAGE_WINDOWS: readonly UsageWindow[] = [1, 7, 30, 90, "all"];

/** What a dictation needs here; HistoryEntry has it, Android maps its entries to it. */
export interface UsageEntry {
  createdAt: number;
  durationMs: number;
  transcripts: { model: string; costUsd: number }[];
}

export interface UsageTotals {
  count: number;
  ms: number;
  usd: number;
}

/** Who a model belongs to; "other" for the rest (none so far costs anything). */
export type UsageProvider = Provider | "other";
export const USAGE_PROVIDERS: readonly UsageProvider[] = ["openai", "gemini", "other"];

export interface UsageColumn {
  /** Local midnight of the day, or the start of the hour. */
  start: number;
  total: UsageTotals;
  byProvider: Record<UsageProvider, UsageTotals>;
}

export interface UsageModel extends UsageTotals {
  model: string;
  provider: UsageProvider;
}

export interface UsageSummary {
  /** The first moment counted; with "all", the first dictation (now when there is none). */
  from: number;
  resolution: "hour" | "day";
  total: UsageTotals;
  /** Days with a dictation, for the average per day. */
  activeDays: number;
  columns: UsageColumn[];
  /** Paid models only, the most expensive first. */
  models: UsageModel[];
}

export function providerOf(model: string): UsageProvider {
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("gemini-")) return "gemini";
  return "other";
}

const HOUR = 3_600_000;

const zero = (): UsageTotals => ({ count: 0, ms: 0, usd: 0 });

function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** The next local midnight: a day around a clock change is 23 or 25 hours long. */
function nextDay(day: number): number {
  const d = new Date(day);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * A dictation counts once, with all its minutes, for the provider of its first paid transcript (the
 * live one, as a rule); its cost is every transcript's, each for its own model's provider.
 */
export function summarizeUsage(entries: readonly UsageEntry[], window: UsageWindow, now: number): UsageSummary {
  const resolution = window === 1 ? "hour" : "day";
  let from: number;
  if (window === 1) from = Math.floor(now / HOUR) * HOUR - 23 * HOUR;
  else if (window === "all") from = startOfDay(entries.reduce((min, e) => Math.min(min, e.createdAt), now));
  else {
    const d = new Date(startOfDay(now));
    d.setDate(d.getDate() - (window - 1));
    from = d.getTime();
  }

  const starts: number[] = [];
  for (let at = from; at <= now; at = resolution === "hour" ? at + HOUR : nextDay(at)) starts.push(at);
  const columns: UsageColumn[] = starts.map((start) => ({
    start,
    total: zero(),
    byProvider: { openai: zero(), gemini: zero(), other: zero() },
  }));

  const total = zero();
  const models = new Map<string, UsageModel>();
  const days = new Set<number>();
  for (const e of entries) {
    if (e.createdAt < from || e.createdAt > now) continue;
    // The last column starting at or before the entry.
    let i = columns.length - 1;
    while (i > 0 && columns[i]!.start > e.createdAt) i--;
    const column = columns[i]!;
    const paid = e.transcripts.filter((t) => t.costUsd > 0);
    const owner = paid.length ? providerOf(paid[0]!.model) : "other";
    for (const totals of [total, column.total, column.byProvider[owner]]) {
      totals.count++;
      totals.ms += e.durationMs;
    }
    for (const t of paid) {
      const provider = providerOf(t.model);
      total.usd += t.costUsd;
      column.total.usd += t.costUsd;
      column.byProvider[provider].usd += t.costUsd;
    }
    // Per model, a dictation counts once for each model that transcribed it.
    for (const model of new Set(paid.map((t) => t.model))) {
      const m = models.get(model) ?? { model, provider: providerOf(model), ...zero() };
      m.count++;
      m.ms += e.durationMs;
      m.usd += paid.filter((t) => t.model === model).reduce((sum, t) => sum + t.costUsd, 0);
      models.set(model, m);
    }
    days.add(startOfDay(e.createdAt));
  }

  return {
    from,
    resolution,
    total,
    activeDays: days.size,
    columns,
    models: [...models.values()].sort((a, b) => b.usd - a.usd || a.model.localeCompare(b.model)),
  };
}
