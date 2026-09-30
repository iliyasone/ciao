import { Check, ClipboardCheck, CloudOff, Loader2, Lock, TriangleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { formatCost } from "../../core/cost";
import type { OverlayState } from "../../core/types";
import { meter, startCapture, stopCapture } from "./capture";

// ── Text model ────────────────────────────────────────────────────────────
// New tokens stay individual spans (animated) for FRESH_MS, then merge into one
// plain string. Keeps the DOM tiny no matter how long you talk.

const FRESH_MS = 1250;

interface Token {
  id: number;
  text: string;
  at: number;
}

interface TextState {
  seq: number;
  settled: string;
  fresh: Token[];
  final: string | null;
  nextId: number;
}

type TextAction =
  | { type: "delta"; seq: number; text: string; at: number }
  | { type: "final"; seq: number; text: string }
  | { type: "reset"; seq: number }
  | { type: "settle"; before: number };

const emptyText = (seq: number): TextState => ({ seq, settled: "", fresh: [], final: null, nextId: 0 });

function textReducer(s: TextState, a: TextAction): TextState {
  switch (a.type) {
    case "reset":
      return a.seq === s.seq ? s : emptyText(a.seq);
    case "delta": {
      const base = a.seq === s.seq ? s : a.seq > s.seq ? emptyText(a.seq) : null;
      if (!base) return s;
      const text = base.settled === "" && base.fresh.length === 0 ? a.text.trimStart() : a.text;
      if (!text) return base;
      return { ...base, fresh: [...base.fresh, { id: base.nextId, text, at: a.at }], nextId: base.nextId + 1 };
    }
    case "final":
      return a.seq === s.seq ? { ...s, final: a.text } : s;
    case "settle": {
      const keep = s.fresh.findIndex((t) => t.at > a.before);
      const old = keep === -1 ? s.fresh : s.fresh.slice(0, keep);
      if (!old.length) return s;
      return { ...s, settled: s.settled + old.map((t) => t.text).join(""), fresh: keep === -1 ? [] : s.fresh.slice(keep) };
    }
  }
}

// ── Pieces ────────────────────────────────────────────────────────────────

const LINE = 25; // px, matches leading below
const MAX_LINES = 6;

/** Grows smoothly line by line, then scrolls; sticks to the bottom unless you scroll up. */
function Scroller({ children }: { children: ReactNode }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [height, setHeight] = useState(LINE);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      const h = inner.current!.offsetHeight;
      setHeight(Math.min(Math.max(h, LINE), LINE * MAX_LINES));
      if (stick.current) outer.current!.scrollTo({ top: outer.current!.scrollHeight, behavior: "smooth" });
    });
    ro.observe(inner.current!);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={outer}
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      }}
      style={{ height }}
      className="scroll-thin overflow-y-auto overscroll-contain transition-[height] duration-200 ease-out"
    >
      <div ref={inner} className="text-[16px] leading-[25px] break-words">
        {children}
      </div>
    </div>
  );
}

/** Recording dot that breathes with the microphone level (no React re-renders). */
function LevelDot() {
  const dot = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      smooth += (Math.min(meter.level / 2500, 1) - smooth) * 0.35;
      if (dot.current) {
        dot.current.style.transform = `scale(${1 + smooth * 0.7})`;
        dot.current.style.boxShadow = `0 0 ${4 + smooth * 12}px rgb(244 103 127 / ${0.35 + smooth * 0.5})`;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <span ref={dot} className="block size-2.5 rounded-full bg-accent transition-transform duration-75" />;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

const HIDE_AFTER: Partial<Record<OverlayState["phase"], number>> = { done: 1100, clipboard: 3500, saved: 5000, empty: 0 };

// ── Overlay ───────────────────────────────────────────────────────────────

export function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [text, dispatch] = useReducer(textReducer, emptyText(-1));
  const [now, setNow] = useState(Date.now());
  const [leaving, setLeaving] = useState(false);
  const hovered = useRef(false);

  useEffect(() => {
    const offs = [
      ciao.overlay.onState((s) => {
        dispatch({ type: "reset", seq: s.seq });
        setState(s);
        setLeaving(false);
      }),
      ciao.overlay.onDelta((seq, t) => dispatch({ type: "delta", seq, text: t, at: performance.now() })),
      ciao.overlay.onFinal((seq, t) => dispatch({ type: "final", seq, text: t })),
      ciao.capture.onStart((seq) => void startCapture(seq)),
      ciao.capture.onStop((seq) => void stopCapture(seq)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  // Merge settled tokens into plain text.
  const hasFresh = text.fresh.length > 0;
  useEffect(() => {
    if (!hasFresh) return;
    const t = setInterval(() => dispatch({ type: "settle", before: performance.now() - FRESH_MS }), 250);
    return () => clearInterval(t);
  }, [hasFresh]);

  // Timer.
  const live = state?.phase === "recording";
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 200);
    return () => clearInterval(t);
  }, [live]);

  // Fade out and hide after a terminal phase (not while the pointer is over the card).
  useEffect(() => {
    if (!state) return;
    const delay = HIDE_AFTER[state.phase];
    if (delay === undefined) return;
    let timer = setTimeout(function leave() {
      if (hovered.current) {
        timer = setTimeout(leave, 400);
        return;
      }
      setLeaving(true);
      timer = setTimeout(() => ciao.overlay.hidden(state.seq), 210);
    }, state.message && state.phase === "empty" ? 1400 : delay);
    return () => clearTimeout(timer);
  }, [state]);

  if (!state) return null;

  const end = state.endedAt ?? (live ? now : Date.now());
  const elapsed = end - state.startedAt;
  const cost = formatCost((elapsed / 60_000) * state.costPerMinuteUsd);
  const busy = state.phase === "finishing";

  let icon: ReactNode;
  switch (state.phase) {
    case "recording":
      icon = <LevelDot />;
      break;
    case "finishing":
      icon = <Loader2 className="size-4 animate-spin text-muted" />;
      break;
    case "done":
      icon = <Check className="size-4 text-emerald-700 dark:text-emerald-400" strokeWidth={2.5} />;
      break;
    case "clipboard":
      icon = <ClipboardCheck className="size-4 text-amber-700 dark:text-amber-300" />;
      break;
    case "saved":
      icon = <TriangleAlert className="size-4 text-amber-700 dark:text-amber-300" />;
      break;
    default:
      icon = null;
  }

  const content =
    text.final !== null ? (
      <span className="text-settled">{text.final}</span>
    ) : text.settled || text.fresh.length ? (
      <>
        <span className="text-settled">{text.settled}</span>
        {text.fresh.map((t) => (
          <span key={t.id} className="tok">
            {t.text}
          </span>
        ))}
      </>
    ) : (
      <span className="animate-pulse text-ghost">…</span>
    );

  const showText = state.phase !== "empty" || text.final || text.settled || text.fresh.length;

  return (
    <div className="flex h-full w-full items-end justify-center px-10 pb-4">
      <div
        key={state.seq}
        onMouseEnter={() => {
          hovered.current = true;
          ciao.overlay.setInteractive(true);
        }}
        onMouseLeave={() => {
          hovered.current = false;
          ciao.overlay.setInteractive(false);
        }}
        className={`${leaving ? "card-leave" : "card-enter"} w-[640px] rounded-[22px] bg-overlay/95 px-5 pt-3 pb-3.5 shadow-[0_14px_44px_rgb(0_0_0/0.16)] dark:shadow-[0_14px_44px_rgb(0_0_0/0.5)] ring-1 ring-tint/10`}
      >
        <header className="mb-1.5 grid h-6 grid-cols-[1fr_auto_1fr] items-center">
          <div className="flex items-center gap-2">
            {icon}
            {state.handsFree && state.phase === "recording" && <Lock className="size-3.5 text-faint" />}
            {state.offline && state.phase === "recording" && <CloudOff className="size-3.5 text-amber-700 dark:text-amber-300/80" />}
          </div>
          <div className={`text-[13px] font-medium tracking-wide tabular-nums ${busy ? "text-faint" : "text-fg2"}`}>{clock(elapsed)}</div>
          <div className="justify-self-end text-[12px] text-faint tabular-nums">
            {[state.delay, state.showCost ? cost : null].filter(Boolean).join(" · ")}
          </div>
        </header>
        {showText ? <Scroller>{content}</Scroller> : null}
        {state.message && <div className="mt-2 text-[12.5px] text-amber-700 dark:text-amber-200/90">{state.message}</div>}
      </div>
    </div>
  );
}
