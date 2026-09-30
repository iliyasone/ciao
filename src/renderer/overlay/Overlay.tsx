import { Check, ClipboardCheck, CloudOff, Copy, History, Loader2, Lock, RotateCcw, TriangleAlert, X } from "lucide-react";
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

const HIDE_AFTER: Partial<Record<OverlayState["phase"], number>> = { done: 450, clipboard: 3500, saved: 6000, empty: 0 };

/**
 * Pointer drag on the grip (move) or the corner (resize). Offsets are sent relative to where the
 * drag started, so the main process can apply them to the window's original bounds.
 */
function dragHandlers(mode: "move" | "resize", dragging: { current: boolean }) {
  let start: { x: number; y: number } | null = null;
  return {
    onPointerDown: (e: React.PointerEvent) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      start = { x: e.screenX, y: e.screenY };
      dragging.current = true;
      ciao.overlay.dragStart();
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (start) ciao.overlay.drag(mode, e.screenX - start.x, e.screenY - start.y);
    },
    onPointerUp: () => {
      start = null;
      dragging.current = false;
      ciao.overlay.dragEnd();
    },
  };
}

// ── Overlay ───────────────────────────────────────────────────────────────

export function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [text, dispatch] = useReducer(textReducer, emptyText(-1));
  const [now, setNow] = useState(Date.now());
  const [leaving, setLeaving] = useState(false);
  const hovered = useRef(false);
  const dragging = useRef(false);
  // Hovering makes the card see-through (to read what's under it); scrolling or grabbing the
  // grip means you want the card itself, so it turns solid again until the pointer leaves.
  const [peek, setPeek] = useState(false);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const solidUntilLeave = useRef(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const offs = [
      ciao.overlay.onState((s) => {
        dispatch({ type: "reset", seq: s.seq });
        setState(s);
        setLeaving(false);
        setCopied(false);
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
    case "recovered":
      icon = <RotateCcw className="size-4 text-amber-700 dark:text-amber-300" />;
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

  const withActions = state.phase === "recovered" || state.phase === "saved";
  const dismiss = () => {
    setLeaving(true);
    setTimeout(() => ciao.overlay.hidden(state.seq), 210);
  };
  // Scrolling or touching the grip/corner means you want the card itself: solid until the pointer leaves.
  const solid = () => {
    solidUntilLeave.current = true;
    setPeek(false);
  };

  return (
    <div className="flex h-full w-full items-end justify-center px-10 pb-4">
      <div
        key={state.seq}
        onMouseEnter={() => {
          hovered.current = true;
          ciao.overlay.setInteractive(true);
        }}
        onMouseMove={(e) => {
          // Only a real pointer move turns it see-through: the card often appears right under a
          // resting cursor (at the prompt box), and that alone must not hide the text.
          const at = pointerAt.current;
          if (!at) pointerAt.current = { x: e.screenX, y: e.screenY };
          else if (!peek && !withActions && !solidUntilLeave.current && !dragging.current && Math.hypot(e.screenX - at.x, e.screenY - at.y) > 4) setPeek(true);
        }}
        onMouseLeave={() => {
          hovered.current = false;
          pointerAt.current = null;
          solidUntilLeave.current = false;
          setPeek(false);
          if (!dragging.current) ciao.overlay.setInteractive(false);
        }}
        onWheel={solid}
        className={`${leaving ? "card-leave" : "card-enter"} group relative w-full rounded-[22px] bg-overlay/95 px-5 pt-3 pb-3.5 shadow-[0_14px_44px_rgb(0_0_0/0.16)] ring-1 ring-tint/10 transition-opacity duration-150 dark:shadow-[0_14px_44px_rgb(0_0_0/0.5)] ${peek ? "opacity-[0.18]" : "opacity-100"}`}
      >
        <header className="mb-1.5 grid h-6 grid-cols-[1fr_auto_1fr] items-center">
          <div className="flex items-center gap-2">
            {icon}
            {state.handsFree && state.phase === "recording" && <Lock className="size-3.5 text-faint" />}
            {state.offline && state.phase === "recording" && <CloudOff className="size-3.5 text-amber-700 dark:text-amber-300/80" />}
          </div>
          <div className={`text-[13px] font-medium tracking-wide tabular-nums ${busy ? "text-faint" : "text-fg2"}`}>{clock(elapsed)}</div>
          <div className="flex items-center justify-self-end gap-2 text-[12px] text-faint tabular-nums">
            {[state.delay, state.showCost ? cost : null].filter(Boolean).join(" · ")}
            {withActions && (
              <button onClick={dismiss} title="Закрыть" className="rounded-md p-0.5 text-faint hover:bg-tint/10 hover:text-fg">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </header>
        {showText ? <Scroller>{content}</Scroller> : null}
        {state.message && <div className="mt-2 text-[12.5px] text-amber-700 dark:text-amber-200/90">{state.message}</div>}
        {withActions && (
          <div className="mt-2.5 -ml-2 flex gap-1">
            {state.phase === "recovered" && text.final && (
              <button
                onClick={async () => {
                  await ciao.overlay.copy(text.final!);
                  setCopied(true);
                  setTimeout(dismiss, 700);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-tint/8 px-2.5 py-1 text-[12.5px] text-fg hover:bg-tint/12"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Скопировано" : "Скопировать"}
              </button>
            )}
            <button
              onClick={() => {
                ciao.overlay.openHistory();
                dismiss();
              }}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[12.5px] text-muted hover:bg-tint/8 hover:text-fg"
            >
              <History className="size-3.5" />
              История
            </button>
          </div>
        )}

        {/* Grip: drag to move, double-click to put the card back. Corner: drag to resize. */}
        <div
          {...dragHandlers("move", dragging)}
          onMouseEnter={solid}
          onDoubleClick={() => ciao.overlay.resetPlacement()}
          title="Перетащи, чтобы подвинуть. Двойной клик — вернуть на место."
          className="absolute -bottom-2.5 left-1/2 flex h-5 w-16 -translate-x-1/2 cursor-grab items-center justify-center opacity-0 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
        >
          <span className="h-1.5 w-10 rounded-full bg-tint/25 ring-1 ring-overlay" />
        </div>
        <div
          {...dragHandlers("resize", dragging)}
          onMouseEnter={solid}
          title="Потяни, чтобы изменить ширину"
          className="absolute right-1 bottom-1 size-4 cursor-ew-resize opacity-0 transition-opacity group-hover:opacity-100"
        >
          <svg viewBox="0 0 16 16" className="size-4 text-ghost">
            <path d="M14 6 6 14M14 10l-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}
