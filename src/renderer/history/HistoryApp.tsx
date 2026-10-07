import {
  AlertTriangle, Check, ClipboardCheck, Copy, FolderOpen, Loader2, Pause, Play, RotateCcw, Search, Sparkles, Trash2, X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { formatCost } from "../../core/cost";
import type { Strings } from "../../core/i18n";
import { isMac } from "../../core/platform";
import { PROVIDERS } from "../../core/providers";
import type { HistoryEntry, Provider, RetryMode } from "../../core/types";
import { useStrings } from "../lang";
import { SettingsPanel } from "./SettingsPanel";
import { UpdateButton, useUpdateState } from "./update";

type Tab = "history" | "settings";

export function HistoryApp() {
  const [tab, setTab] = useState<Tab>(location.hash === "#settings" ? "settings" : "history");
  const update = useUpdateState();
  const tr = useStrings();
  return (
    <div className="flex h-full flex-col">
      {/* Room for the window buttons: macOS traffic lights on the left, Windows controls on the right. */}
      <header className={`drag flex h-11 shrink-0 items-center gap-5 border-b border-tint/5 ${isMac ? "pr-4 pl-21" : "pr-40 pl-4"}`}>
        <div className="flex items-center gap-2">
          <img src="./icon.png" className="size-5 rounded-md" alt="" />
          <span className="text-[14px] font-semibold tracking-tight text-fg">Ciao</span>
        </div>
        <nav className="no-drag flex gap-1">
          {(["history", "settings"] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`rounded-lg px-3 py-1 text-[13px] transition-colors ${tab === t ? "bg-tint/10 text-fg" : "text-muted hover:text-fg"}`}
            >
              {tr.tabs[t]}
            </button>
          ))}
        </nav>
        <div className="ml-auto">
          <UpdateButton state={update} />
        </div>
      </header>
      <main className="min-h-0 flex-1">{tab === "history" ? <History /> : <SettingsPanel updateState={update} />}</main>
    </div>
  );
}

// ── History list ──────────────────────────────────────────────────────────

function dayLabel(iso: string, tr: Strings): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return tr.history.today;
  if (d.toDateString() === yesterday.toDateString()) return tr.history.yesterday;
  return d.toLocaleDateString(tr.locale, { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

const duration = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const entryCost = (e: HistoryEntry) => e.transcripts.reduce((sum, t) => sum + t.costUsd, 0);

/** The service in Settings and every service with a key: a recording can be retried with any of them. */
interface Services {
  current: Provider;
  keyed: Provider[];
}

function useServices(): Services {
  const [current, setCurrent] = useState<Provider>("openai");
  const [keyed, setKeyed] = useState<Provider[]>([]);
  useEffect(() => {
    let alive = true;
    const check = () =>
      void Promise.all((Object.keys(PROVIDERS) as Provider[]).map(async (p) => ((await ciao.settings.hasApiKey(p)) ? p : null))).then(
        (list) => alive && setKeyed(list.filter((p) => p !== null)),
      );
    void ciao.settings.get().then((s) => alive && setCurrent(s.provider));
    check();
    const offSettings = ciao.settings.onChanged((s) => setCurrent(s.provider));
    const offKeys = ciao.settings.onKeys(check); // one may have come from another device
    return () => {
      alive = false;
      offSettings();
      offKeys();
    };
  }, []);
  return { current, keyed };
}

/** Cards drawn at first and added per scroll: drawing a long history at once froze the window. */
const PAGE = 40;

function History() {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const scroller = useRef<HTMLDivElement | null>(null);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const services = useServices();
  const tr = useStrings();

  useEffect(() => {
    void ciao.history.list().then(setEntries);
    return ciao.history.onChanged((e) =>
      setEntries((list) => {
        if (!list) return list;
        const i = list.findIndex((x) => x.id === e.id);
        if (i === -1) return [e, ...list];
        const copy = list.slice();
        copy[i] = e;
        return copy;
      }),
    );
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (entries ?? []).filter((e) => !q || e.transcripts.some((t) => t.text.toLowerCase().includes(q)));
  }, [entries, query]);

  // Draw the next page while the end of the list is still a screen or two away.
  const more = filtered.length > limit;
  useEffect(() => {
    if (!more || !sentinel.current) return;
    const observer = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting) setLimit((l) => l + PAGE);
      },
      { root: scroller.current, rootMargin: "1500px 0px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [more, limit]);

  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const e of filtered.slice(0, limit)) {
      const k = dayLabel(e.createdAt, tr);
      map.set(k, [...(map.get(k) ?? []), e]);
    }
    return [...map];
  }, [filtered, limit, tr]);

  const today = useMemo(() => (entries ?? []).filter((e) => new Date(e.createdAt).toDateString() === new Date().toDateString()), [entries]);
  const total = entries ?? [];

  if (!entries) return null;

  return (
    <div ref={scroller} className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pt-5 pb-16">
        <div className="mb-4 flex items-end justify-between gap-4">
          <div className="text-[12.5px] text-faint">
            <Stat label={tr.history.statToday} entries={today} />
            <span className="mx-2 text-ghost">·</span>
            <Stat label={tr.history.statTotal} entries={total} />
          </div>
          <label className="flex w-64 items-center gap-2 rounded-xl bg-tint/5 px-3 py-1.5 ring-1 ring-tint/5 focus-within:ring-tint/15">
            <Search className="size-3.5 text-faint" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(PAGE);
              }}
              placeholder={tr.history.search}
              className="selectable w-full bg-transparent text-[13px] text-fg outline-none placeholder:text-ghost"
            />
          </label>
        </div>

        {groups.length === 0 && (
          <div className="mt-24 text-center text-[14px] text-faint">
            {query ? tr.history.nothingFound : tr.history.empty}
          </div>
        )}

        {groups.map(([day, list]) => (
          <section key={day} className="mb-6">
            <h2 className="mb-2 px-1 text-[12px] font-semibold tracking-wide text-faint uppercase">{day}</h2>
            <div className="flex flex-col gap-2">
              {list.map((e) => (
                <EntryCard key={e.id} entry={e} services={services} onRemoved={() => setEntries((l) => l?.filter((x) => x.id !== e.id) ?? l)} />
              ))}
            </div>
          </section>
        ))}
        {more && <div ref={sentinel} className="h-px" />}
      </div>
    </div>
  );
}

function Stat({ label, entries }: { label: string; entries: HistoryEntry[] }) {
  const ms = entries.reduce((s, e) => s + e.durationMs, 0);
  const usd = entries.reduce((s, e) => s + entryCost(e), 0);
  const tr = useStrings().history;
  return (
    <span>
      {label}: <span className="text-fg2 tabular-nums">{entries.length}</span> · <span className="tabular-nums">{tr.minutes(Math.round(ms / 60_000))}</span> ·{" "}
      <span className="tabular-nums">{formatCost(usd)}</span>
    </span>
  );
}

function StatusBadge({ entry }: { entry: HistoryEntry }) {
  const base = "inline-flex items-center gap-1 rounded-md px-1.5 py-px text-[11px]";
  const tr = useStrings().history.status;
  if (entry.status === "recording" || entry.status === "transcribing")
    return <span className={`${base} bg-tint/5 text-muted`}><Loader2 className="size-3 animate-spin" />{tr.running}</span>;
  if (entry.status === "failed") return <span className={`${base} bg-amber-400/10 text-amber-700 dark:text-amber-300`}><AlertTriangle className="size-3" />{tr.failed}</span>;
  if (entry.status === "cancelled") return <span className={`${base} bg-tint/5 text-muted`}><X className="size-3" />{tr.cancelled}</span>;
  if (entry.delivery === "pasted") return <span className={`${base} bg-emerald-400/10 text-emerald-700 dark:text-emerald-300`}><Check className="size-3" />{tr.pasted}</span>;
  if (entry.delivery === "clipboard") return <span className={`${base} bg-sky-400/10 text-sky-700 dark:text-sky-300`}><ClipboardCheck className="size-3" />{tr.clipboard}</span>;
  return null;
}

function EntryCard({ entry, services, onRemoved }: { entry: HistoryEntry; services: Services; onRemoved: () => void }) {
  const [shown, setShown] = useState<string | null>(null); // transcript id
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState<RetryMode | null>(null);
  const [error, setError] = useState<{ message: string; mode: RetryMode; provider: Provider } | null>(null);
  // The service retries go through; Settings' by default.
  const [picked, setPicked] = useState<Provider | null>(null);
  const via = picked && services.keyed.includes(picked) ? picked : services.current;
  const [copied, setCopied] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const strings = useStrings();
  const tr = strings.history;

  const current = entry.transcripts.find((t) => t.id === shown) ?? entry.transcripts.at(-1);
  const time = new Date(entry.createdAt).toLocaleTimeString(strings.locale, { hour: "2-digit", minute: "2-digit" });
  const needsAttention = entry.status === "failed" || entry.status === "cancelled";

  const retry = async (mode: RetryMode, provider = via) => {
    setBusy(mode);
    setError(null);
    try {
      const updated = await ciao.history.retry(entry.id, mode, provider);
      setShown(updated.transcripts.at(-1)?.id ?? null);
    } catch (e) {
      setError({ message: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""), mode, provider });
    } finally {
      setBusy(null);
    }
  };

  return (
    <article className="group rounded-2xl bg-card px-4 py-3 ring-1 ring-tint/[0.07] transition-colors hover:bg-card-hover">
      <div className="mb-1.5 flex items-center gap-2 text-[12px] text-faint">
        <span className="font-medium text-fg2 tabular-nums">{time}</span>
        <span className="tabular-nums">{duration(entry.durationMs)}</span>
        {entry.target?.process && <span className="truncate text-ghost">{entry.target.process}</span>}
        <StatusBadge entry={entry} />
        <span className="ml-auto tabular-nums text-ghost">{formatCost(entryCost(entry))}</span>
      </div>

      {current?.text ? (
        <p
          onClick={() => setExpanded((x) => !x)}
          className={`selectable cursor-text text-[14.5px] leading-[1.55] whitespace-pre-wrap text-fg ${expanded ? "" : "line-clamp-4"}`}
        >
          {current.text}
        </p>
      ) : (
        <p className="text-[13.5px] text-faint italic">{tr.noText}</p>
      )}

      {(entry.error || error) && <p className="mt-1.5 text-[12px] text-amber-700 dark:text-amber-300/90">{error?.message ?? entry.error}</p>}
      {/* One service failing (an outage, a rate limit) shouldn't mean a trip to Settings: offer the other. */}
      {error &&
        services.keyed
          .filter((p) => p !== error.provider)
          .map((p) => (
            <button
              key={p}
              disabled={busy !== null}
              onClick={() => {
                setPicked(p);
                void retry(error.mode, p);
              }}
              className="mt-1 text-[12px] font-medium text-fg2 underline decoration-tint/30 underline-offset-2 hover:text-fg disabled:opacity-40"
            >
              {tr.tryWith(PROVIDERS[p].name)}
            </button>
          ))}

      {entry.transcripts.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {entry.transcripts.map((t) => (
            <button
              key={t.id}
              onClick={() => setShown(t.id)}
              className={`rounded-md px-2 py-0.5 text-[11px] transition-colors ${t.id === current?.id ? "bg-tint/12 text-fg" : "bg-tint/[0.04] text-faint hover:text-fg2"}`}
            >
              {tr.source[t.source]} · {t.model}
            </button>
          ))}
        </div>
      )}

      <div className={`mt-2 -ml-2 flex items-center gap-0.5 ${needsAttention ? "" : "opacity-60 group-hover:opacity-100 focus-within:opacity-100"} transition-opacity`}>
        <Player id={entry.id} />
        <Action
          icon={copied ? Check : Copy}
          label={copied ? tr.copied : tr.copy}
          disabled={!current?.text}
          onClick={async () => {
            await ciao.history.copy(current!.text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        />
        <Action icon={busy === "file" ? Loader2 : Sparkles} spin={busy === "file"} label={tr.retryFile} title={tr.retryFileTitle} disabled={busy !== null} onClick={() => retry("file")} />
        <Action icon={busy === "live" ? Loader2 : RotateCcw} spin={busy === "live"} label={tr.retryLive} title={tr.retryLiveTitle} disabled={busy !== null} onClick={() => retry("live")} />
        {services.keyed.length > 1 && (
          <div className="ml-1 flex items-center gap-0.5 text-[11px]">
            <span className="mr-0.5 text-ghost">{tr.via}</span>
            {services.keyed.map((p) => (
              <button
                key={p}
                title={tr.viaTitle(PROVIDERS[p].name)}
                disabled={busy !== null}
                onClick={() => setPicked(p)}
                className={`rounded-md px-1.5 py-0.5 transition-colors disabled:opacity-40 ${p === via ? "bg-tint/12 text-fg" : "text-faint hover:text-fg2"}`}
              >
                {PROVIDERS[p].name}
              </button>
            ))}
          </div>
        )}
        <Action icon={FolderOpen} title={tr.openFolder} onClick={() => void ciao.history.openFolder(entry.id)} />
        <div className="ml-auto">
          <Action
            icon={Trash2}
            title={tr.delete}
            label={confirmDelete ? tr.confirmDelete : undefined}
            danger={confirmDelete}
            onClick={async () => {
              if (!confirmDelete) {
                setConfirmDelete(true);
                setTimeout(() => setConfirmDelete(false), 2500);
                return;
              }
              await ciao.history.remove(entry.id);
              onRemoved();
            }}
          />
        </div>
      </div>
    </article>
  );
}

function Action(props: {
  icon: typeof Copy;
  label?: string;
  title?: string;
  onClick: () => void;
  disabled?: boolean;
  spin?: boolean;
  danger?: boolean;
}) {
  const Icon = props.icon;
  return (
    <button
      onClick={props.onClick}
      disabled={props.disabled}
      title={props.title ?? props.label}
      className={`inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] whitespace-nowrap transition-colors disabled:opacity-40 ${
        props.danger ? "bg-red-500/15 text-red-700 dark:text-red-300" : "text-muted hover:bg-tint/8 hover:text-fg"
      }`}
    >
      <Icon className={`size-3.5 ${props.spin ? "animate-spin" : ""}`} />
      {props.label && <span>{props.label}</span>}
    </button>
  );
}

function Player({ id }: { id: string }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const tr = useStrings().history;
  useEffect(() => () => audio.current?.pause(), []);
  return (
    <Action
      icon={playing ? Pause : Play}
      label={playing ? tr.pause : tr.play}
      onClick={() => {
        if (!audio.current) {
          audio.current = new Audio(ciao.history.audioUrl(id));
          audio.current.onended = () => setPlaying(false);
        }
        if (playing) audio.current.pause();
        else void audio.current.play();
        setPlaying(!playing);
      }}
    />
  );
}
