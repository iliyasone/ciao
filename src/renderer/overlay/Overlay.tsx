import { Check, ClipboardCheck, CloudOff, Copy, History, Loader2, Lock, RotateCcw, Square, TriangleAlert, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { formatCost } from "../../core/cost";
import { layout, PARAGRAPH_PAUSE_MS, type Pause } from "../../core/liveLayout";
import { revisePauses } from "../../core/revision";
import type { OverlayState, TermSuggestion } from "../../core/types";
import { useStrings } from "../lang";
import { meter, setWake, startCapture, stopCapture } from "./capture";
import { playSound, warmUp } from "./sounds";

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
  /** Where the speaker paused, as offsets in settled + fresh text (for live paragraphs). */
  pauses: Pause[];
}

type TextAction =
  | { type: "delta"; seq: number; text: string; at: number; gapMs: number }
  | { type: "revise"; seq: number; text: string; at: number; gapMs: number }
  | { type: "final"; seq: number; text: string }
  | { type: "reset"; seq: number }
  | { type: "settle"; before: number };

const emptyText = (seq: number): TextState => ({ seq, settled: "", fresh: [], final: null, nextId: 0, pauses: [] });

const textLength = (s: TextState) => s.settled.length + s.fresh.reduce((n, t) => n + t.text.length, 0);

function textReducer(s: TextState, a: TextAction): TextState {
  switch (a.type) {
    case "reset":
      return a.seq === s.seq ? s : emptyText(a.seq);
    case "delta": {
      const base = a.seq === s.seq ? s : a.seq > s.seq ? emptyText(a.seq) : null;
      if (!base) return s;
      const text = base.settled === "" && base.fresh.length === 0 ? a.text.trimStart() : a.text;
      if (!text) return base;
      const at = textLength(base);
      const pauses = a.gapMs >= PARAGRAPH_PAUSE_MS && at > 0 ? [...base.pauses, { at, ms: a.gapMs }] : base.pauses;
      return { ...base, fresh: [...base.fresh, { id: base.nextId, text, at: a.at }], nextId: base.nextId + 1, pauses };
    }
    case "revise": {
      // The whole text so far, changed somewhere (Gemini revising its guess): keep what stayed the
      // same as it is, and fade in the rest as new.
      const base = a.seq === s.seq ? s : a.seq > s.seq ? emptyText(a.seq) : null;
      if (!base) return s;
      const text = a.text.trimStart();
      const full = base.settled + base.fresh.map((t) => t.text).join("");
      const { same, pauses } = revisePauses(full, text, base.pauses, a.gapMs);
      let settled = base.settled.slice(0, same);
      const fresh: Token[] = [];
      if (same >= base.settled.length) {
        settled = base.settled;
        let at = settled.length;
        for (const t of base.fresh) {
          if (at + t.text.length <= same) fresh.push(t);
          else if (same > at) fresh.push({ ...t, text: t.text.slice(0, same - at) });
          if (at + t.text.length >= same) break;
          at += t.text.length;
        }
      }
      const rest = text.slice(same);
      if (rest) fresh.push({ id: base.nextId, text: rest, at: a.at });
      return { ...base, settled, fresh, nextId: base.nextId + 1, pauses };
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

/**
 * The live text with its layout (paragraph gaps, "1." markers, dropped ordinals) applied, while
 * keeping each fresh token its own animated span.
 */
function LiveText({ text, withLayout }: { text: TextState; withLayout: boolean }) {
  const ranges = [{ key: "settled", start: 0, text: text.settled, fresh: false }];
  let offset = text.settled.length;
  for (const t of text.fresh) {
    ranges.push({ key: `t${t.id}`, start: offset, text: t.text, fresh: true });
    offset += t.text.length;
  }
  const full = text.settled + text.fresh.map((t) => t.text).join("");
  const { breaks, edits } = withLayout ? layout(full, text.pauses) : { breaks: [], edits: [] };
  const breakAt = new Map(breaks.map((b) => [b.at, b]));
  const editAt = new Map(edits.map((e) => [e.start, e]));

  let skipUntil = 0;
  const out: ReactNode[] = [];
  for (const r of ranges) {
    const parts: ReactNode[] = [];
    let buf = "";
    for (let i = r.start; i < r.start + r.text.length; i++) {
      const b = breakAt.get(i);
      if (b && i >= skipUntil) {
        if (buf) parts.push(buf);
        buf = "";
        if (i > 0) parts.push(<span key={`b${i}`} className={`block ${b.kind === "paragraph" ? "h-2.5" : "h-1"}`} />);
        if (b.kind === "item") parts.push(<span key={`n${i}`} className="text-faint tabular-nums">{`${b.n}. `}</span>);
      }
      if (i < skipUntil) continue;
      const e = editAt.get(i);
      if (e) {
        buf += e.insert;
        skipUntil = e.end;
        continue;
      }
      buf += full[i];
    }
    if (buf) parts.push(buf);
    if (!parts.length) continue;
    out.push(
      <span key={r.key} className={r.fresh ? "tok" : "text-settled"}>
        {parts}
      </span>,
    );
  }
  return <>{out}</>;
}

// ── Window plumbing ───────────────────────────────────────────────────────

const LINE = 25; // px, matches leading below
/** Window height minus the text lines (CHROME_HEIGHT in src/main/overlayWindow.ts). */
const CHROME_HEIGHT = 170;
const DRAG_THRESHOLD = 4; // px: less is a click

/** Lines the card shows before it scrolls: the window is sized for them (Settings.overlayLines). */
function useMaxLines(): number {
  const get = () => Math.max(3, Math.round((window.innerHeight - CHROME_HEIGHT) / LINE));
  const [n, setN] = useState(get);
  useEffect(() => {
    const onResize = () => setN(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return n;
}

// What is drawn (the pill, the card, a suggestion), in window pixels: on Linux the window's shape
// follows it; on Windows and macOS the main process lets the mouse in while the pointer is over it.
const drawn = new Set<HTMLElement>();
let reportQueued = false;
// Resizing the window moves what sits on its bottom edge without resizing it.
window.addEventListener("resize", () => reportRegion());
function reportRegion(): void {
  if (reportQueued) return;
  reportQueued = true;
  setTimeout(() => {
    reportQueued = false;
    ciao.overlay.setRegion([...drawn].map((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    }));
  });
}

/**
 * Registers what `ref` draws as part of the window's drawn region, and lets clicks through again
 * when it goes away. `mounted` changes whenever the element is replaced.
 */
function useDrawn(ref: React.RefObject<HTMLElement | null>, hovered: React.RefObject<boolean>, mounted?: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    drawn.add(el);
    reportRegion();
    const ro = new ResizeObserver(reportRegion);
    ro.observe(el);
    // Measured mid-animation the rect includes the entering transform; the animation's end doesn't resize it.
    // Its own animation only: the words' animations bubble up from inside.
    const onAnimationEnd = (e: AnimationEvent) => {
      if (e.target === el) reportRegion();
    };
    el.addEventListener("animationend", onAnimationEnd);
    return () => {
      ro.disconnect();
      el.removeEventListener("animationend", onAnimationEnd);
      drawn.delete(el);
      reportRegion();
      // It may vanish under the pointer, which then never "leaves" it.
      if (hovered.current) ciao.overlay.setInteractive(false);
      hovered.current = false;
    };
  }, [ref, hovered, mounted]);
}

/** Over the pill or a card, clicks and the wheel land on it (Windows, macOS); elsewhere they go through. */
function hoverHandlers(hovered: React.RefObject<boolean>, dragging: React.RefObject<boolean>) {
  return {
    onMouseEnter: () => {
      hovered.current = true;
      ciao.overlay.setInteractive(true);
    },
    onMouseLeave: () => {
      hovered.current = false;
      if (!dragging.current) ciao.overlay.setInteractive(false);
    },
  };
}

/**
 * Press and move a few pixels to drag the window ("move") or size the card ("resize", from the
 * corner: at once); a press without moving is a click. Once it is a drag, the main process moves the
 * window after the cursor from where the press began until the press ends. Buttons and the scroll
 * bar keep their own clicks.
 */
function useDrag(mode: "move" | "resize", dragging: React.RefObject<boolean>, hovered: React.RefObject<boolean>, onClick?: () => void) {
  // In a ref: the card re-renders every 200 ms while recording, and handlers recreated mid-drag
  // must still know where the press began.
  const press = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  // While a drag is on, its end is also heard on the whole page: when the captured element goes away
  // (a dictation started and a new card or the card took its place), its own handlers never hear it,
  // and the window would follow the cursor and take its clicks.
  const unwatch = useRef<(() => void) | null>(null);
  const end = (click: boolean) => {
    unwatch.current?.();
    unwatch.current = null;
    const p = press.current;
    press.current = null;
    if (!p) return;
    if (p.moved) {
      dragging.current = false;
      ciao.overlay.dragEnd();
      if (!hovered.current) ciao.overlay.setInteractive(false);
    } else if (click) {
      onClick?.();
    }
  };
  const startDrag = (x: number, y: number) => {
    unwatch.current?.();
    dragging.current = true;
    ciao.overlay.dragStart(mode, x, y);
    const over = () => end(false);
    for (const type of ["pointerup", "pointercancel"]) window.addEventListener(type, over);
    document.addEventListener("lostpointercapture", over);
    unwatch.current = () => {
      for (const type of ["pointerup", "pointercancel"]) window.removeEventListener(type, over);
      document.removeEventListener("lostpointercapture", over);
    };
  };
  // Unmounted mid-drag (the pill gave way to the card): end it.
  useEffect(() => () => end(false), []);
  return {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const target = e.target as HTMLElement;
      if (mode === "move" && target.closest("button, [data-selectable]")) return;
      const scroller = target.closest<HTMLElement>("[data-scroller]");
      if (scroller && e.clientX >= scroller.getBoundingClientRect().left + scroller.clientWidth) return;
      e.stopPropagation();
      press.current = { x: e.screenX, y: e.screenY, moved: mode === "resize" };
      // Captured only once it is a drag: a captured press sends its clicks to the card, and the
      // grip's double-click would never arrive.
      if (mode === "resize") {
        e.currentTarget.setPointerCapture(e.pointerId);
        startDrag(e.screenX, e.screenY);
      }
    },
    onPointerMove: (e: React.PointerEvent) => {
      const p = press.current;
      if (!p) return;
      // Released somewhere we never heard of (off the pill, before it was a drag): over.
      if (e.buttons === 0) return end(false);
      const dx = e.screenX - p.x;
      const dy = e.screenY - p.y;
      if (!p.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        p.moved = true;
        // The main process moves the window after the cursor from here on.
        startDrag(p.x, p.y);
      }
    },
    onPointerUp: () => end(true),
    onPointerCancel: () => end(false),
    onLostPointerCapture: () => end(false),
  };
}

// ── Pieces ────────────────────────────────────────────────────────────────

/** Grows smoothly line by line, then scrolls; sticks to the bottom unless you scroll up. */
function Scroller({ children, maxLines }: { children: ReactNode; maxLines: number }) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [content, setContent] = useState(LINE);

  useLayoutEffect(() => {
    const ro = new ResizeObserver(() => {
      setContent(inner.current!.offsetHeight);
      if (stick.current) outer.current!.scrollTo({ top: outer.current!.scrollHeight, behavior: "smooth" });
    });
    ro.observe(inner.current!);
    return () => ro.disconnect();
  }, []);

  return (
    <div
      ref={outer}
      data-scroller
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
      }}
      style={{ height: Math.min(Math.max(content, LINE), LINE * maxLines) }}
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
/** The fold/fade-out animations in styles.css, plus a frame. */
const LEAVE_MS = 210;
const SUGGESTION_MS = 15_000;
/** Two presses in the kept text box within this time make a double click: all of its text is selected. */
const DOUBLE_PRESS_MS = 500;

/** The Ciao pill between dictations: click to dictate, drag to move. Draws nothing but a static icon, so it costs nothing. */
function Pill({ dragging }: { dragging: React.RefObject<boolean> }) {
  const ref = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const tr = useStrings().overlay;
  useDrawn(ref, hovered);
  return (
    <div
      ref={ref}
      {...hoverHandlers(hovered, dragging)}
      {...useDrag("move", dragging, hovered, () => ciao.overlay.pillClick())}
      title={tr.pillTitle}
      className="pill-in absolute bottom-4 left-1/2 flex h-[30px] w-14 -translate-x-1/2 cursor-pointer items-center justify-center rounded-full bg-overlay/95 shadow-[0_6px_20px_rgb(0_0_0/0.16)] ring-1 ring-tint/10 transition-[scale] duration-150 ease-out hover:scale-[1.08] dark:shadow-[0_6px_20px_rgb(0_0_0/0.45)]"
    >
      <img src="./icon.png" alt="" draggable={false} className="size-[18px] rounded-[5px]" />
    </div>
  );
}

/** "Remember this word?" after the user corrected a pasted dictation. Plainly Ciao's: its icon and name lead. */
function Suggestion({ s, pill, dragging, onDone }: { s: TermSuggestion; pill: boolean; dragging: React.RefObject<boolean>; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const [added, setAdded] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const closing = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const tr = useStrings().overlay;
  useDrawn(ref, hovered);
  const done = useRef(false);
  const finish = useRef(() => {
    if (done.current) return;
    done.current = true;
    onDone();
  });
  // A dictation may take its place before it has finished leaving: it is answered all the same.
  useEffect(() => () => {
    timers.current.forEach(clearTimeout);
    if (closing.current) finish.current();
  }, []);

  // Once: the X after "Add" must not take the next suggestion away with this one.
  const close = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    setLeaving(true);
    timers.current.push(setTimeout(finish.current, LEAVE_MS));
  }, []);

  // Goes away by itself unless the pointer is on it; that is "not now", not "no".
  useEffect(() => {
    let timer = setTimeout(function leave() {
      if (hovered.current) {
        timer = setTimeout(leave, 1000);
        return;
      }
      close();
    }, SUGGESTION_MS);
    return () => clearTimeout(timer);
  }, [close]);

  return (
    <div className="absolute inset-x-10 bottom-4 flex justify-center">
      <div
        ref={ref}
        {...hoverHandlers(hovered, dragging)}
        {...useDrag("move", dragging, hovered)}
        className={`${leaving ? (pill ? "card-fold" : "card-leave") : pill ? "card-unfold" : "card-enter"} max-w-[460px] min-w-[300px] rounded-[20px] bg-overlay/95 px-4 pt-2.5 pb-3 shadow-[0_14px_44px_rgb(0_0_0/0.16)] ring-1 ring-tint/10 dark:shadow-[0_14px_44px_rgb(0_0_0/0.5)]`}
      >
        <header className="flex items-center gap-2 text-[12px] text-faint">
          <img src="./icon.png" alt="" draggable={false} className="size-4 rounded-[4px]" />
          <span className="font-semibold text-fg2">Ciao</span>
          <span>·</span>
          <span>{tr.suggestTitle}</span>
          <button onClick={close} title={tr.close} className="ml-auto rounded-md p-0.5 text-faint hover:bg-tint/10 hover:text-fg">
            <X className="size-3.5" />
          </button>
        </header>
        {added ? (
          <div className="mt-1.5 flex items-center gap-1.5 text-[14px] text-fg">
            <Check className="size-4 text-emerald-700 dark:text-emerald-400" strokeWidth={2.5} />
            {tr.suggestAdded(s.fixed)}
          </div>
        ) : (
          <>
            <div className="mt-1 text-[15px] leading-6 break-words">
              <span className="text-faint line-through decoration-tint/30">{s.heard}</span>
              <span className="mx-1.5 text-ghost">→</span>
              <span className="font-semibold text-fg">{s.fixed}</span>
            </div>
            <div className="mt-2 -ml-1 flex gap-1.5">
              <button
                onClick={() => {
                  ciao.overlay.answer(s, true);
                  setAdded(true);
                  timers.current.push(setTimeout(close, 1400));
                }}
                className="rounded-lg bg-tint/10 px-2.5 py-1 text-[12.5px] font-medium text-fg hover:bg-tint/15"
              >
                {tr.suggestAdd}
              </button>
              <button
                onClick={() => {
                  ciao.overlay.answer(s, false);
                  close();
                }}
                className="rounded-lg px-2.5 py-1 text-[12.5px] text-muted hover:bg-tint/8 hover:text-fg"
              >
                {tr.suggestNo}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Overlay ───────────────────────────────────────────────────────────────

export function Overlay() {
  const [state, setState] = useState<OverlayState | null>(null);
  const [text, dispatch] = useReducer(textReducer, emptyText(-1));
  const [now, setNow] = useState(Date.now());
  const [leaving, setLeaving] = useState(false);
  const [pill, setPill] = useState(false);
  const [suggestions, setSuggestions] = useState<TermSuggestion[]>([]);
  const maxLines = useMaxLines();
  const hovered = useRef(false);
  const dragging = useRef(false);
  const card = useRef<HTMLDivElement>(null);
  const gripPressedAt = useRef(0);
  // Hovering makes the card see-through (to read what's under it); scrolling or dragging it means
  // you want the card itself, so it turns solid again until the pointer leaves.
  const [peek, setPeek] = useState(false);
  const pointerAt = useRef<{ x: number; y: number } | null>(null);
  const solidUntilLeave = useRef(false);
  const [copied, setCopied] = useState(false);
  /** The kept box's last press, to tell a double press (select all) from a single one. */
  const lastPress = useRef({ at: 0, x: 0, y: 0 });
  /** A fold under way, and its card: a state for that card arriving meanwhile (kept after all) cancels it. */
  const folding = useRef<ReturnType<typeof setTimeout>>(undefined);
  const foldingSeq = useRef(-1);
  /** The card the user closed or copied: later states for it (a late check) don't bring it back. */
  const closedSeq = useRef(-1);
  const shownSeq = useRef(-1);
  const tr = useStrings().overlay;

  useEffect(() => {
    warmUp(); // the first start sound mustn't wait for the output to open
    const offs = [
      ciao.overlay.onState((s) => {
        if (s.seq === closedSeq.current) return;
        if (s.seq === foldingSeq.current) {
          clearTimeout(folding.current);
          foldingSeq.current = -1;
        }
        shownSeq.current = s.seq;
        dispatch({ type: "reset", seq: s.seq });
        setState(s);
        setLeaving(false);
        setCopied(false);
      }),
      ciao.overlay.onDelta((seq, t, gapMs) => dispatch({ type: "delta", seq, text: t, at: performance.now(), gapMs })),
      ciao.overlay.onRevise((seq, t, gapMs) => dispatch({ type: "revise", seq, text: t, at: performance.now(), gapMs })),
      ciao.overlay.onFinal((seq, t) => dispatch({ type: "final", seq, text: t })),
      ciao.overlay.onPill(setPill),
      ciao.overlay.onSuggest((s) =>
        setSuggestions((list) => (list.some((x) => x.fixed.toLowerCase() === s.fixed.toLowerCase()) ? list : [...list, s])),
      ),
      ciao.capture.onStart((seq) => void startCapture(seq)),
      ciao.capture.onSound(playSound),
      ciao.capture.onStop((seq) => void stopCapture(seq)),
      ciao.wake.onEnable((on) => void setWake(on)),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  const suggestion = state ? undefined : suggestions[0];
  const busy = state !== null || suggestion !== undefined;
  useEffect(() => ciao.overlay.setBusy(busy), [busy]);
  const nextSuggestion = useCallback(() => setSuggestions((list) => list.slice(1)), []);

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

  const fold = useCallback((seq: number) => {
    // Another card took its place meanwhile (a Copy's delayed close): just say this one is gone.
    if (shownSeq.current !== seq) return ciao.overlay.hidden(seq);
    // A fold of another card cut short still reports that card gone.
    if (foldingSeq.current !== -1 && foldingSeq.current !== seq) ciao.overlay.hidden(foldingSeq.current);
    setLeaving(true);
    clearTimeout(folding.current);
    foldingSeq.current = seq;
    folding.current = setTimeout(() => {
      foldingSeq.current = -1;
      ciao.overlay.hidden(seq);
      setState((s) => (s?.seq === seq ? null : s));
    }, LEAVE_MS);
  }, []);

  // Fold away after a terminal phase (not while the pointer is over the card).
  useEffect(() => {
    if (!state) return;
    const delay = state.keep ? undefined : HIDE_AFTER[state.phase];
    if (delay === undefined) return;
    let timer = setTimeout(function leave() {
      if (hovered.current) {
        timer = setTimeout(leave, 400);
        return;
      }
      fold(state.seq);
    }, state.message && state.phase === "empty" ? 1400 : delay);
    return () => clearTimeout(timer);
  }, [state, fold]);

  const cardDrag = useDrag("move", dragging, hovered);
  const resizeDrag = useDrag("resize", dragging, hovered);
  useDrawn(card, hovered, state?.seq);

  if (!state) {
    if (suggestion) return <Suggestion key={suggestion.id} s={suggestion} pill={pill} dragging={dragging} onDone={nextSuggestion} />;
    return pill ? <Pill dragging={dragging} /> : null;
  }

  const end = state.endedAt ?? (live ? now : Date.now());
  const elapsed = end - state.startedAt;
  const cost = formatCost((elapsed / 60_000) * state.costPerMinuteUsd);
  const finishing = state.phase === "finishing";

  let icon: ReactNode;
  if (state.keep) {
    // It sits where the pill was: a click on it starts the next dictation, as the pill's would.
    icon = (
      <button onClick={() => ciao.overlay.pillClick()} title={tr.dictateAgain} className="-m-1.5 cursor-pointer rounded-full p-1.5 hover:bg-tint/10">
        <ClipboardCheck className="size-4 text-amber-700 dark:text-amber-300" />
      </button>
    );
  } else switch (state.phase) {
    case "recording":
      // Hands-free there is no key to let go of: the dot finishes it, as a second click on the pill would.
      icon = state.handsFree ? (
        <button onClick={() => ciao.overlay.pillClick()} title={tr.finish} className="-m-1.5 cursor-pointer rounded-full p-1.5 hover:bg-tint/10">
          <LevelDot />
        </button>
      ) : (
        <LevelDot />
      );
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

  const kept = !!state.keep && text.final !== null;
  const keptText = text.final ?? "";
  const content =
    text.final !== null ? (
      <span className="text-settled whitespace-pre-wrap">{text.final}</span>
    ) : text.settled || text.fresh.length ? (
      <LiveText text={text} withLayout={state.layout ?? false} />
    ) : (
      <span className="animate-pulse text-ghost">…</span>
    );

  const showText = state.phase !== "empty" || text.final || text.settled || text.fresh.length;

  const withActions = state.phase === "recovered" || state.phase === "saved" || !!state.keep;
  const dismiss = () => {
    closedSeq.current = state.seq;
    ciao.overlay.closed(state.seq); // main forgets a kept card now, not after the fold
    fold(state.seq);
  };
  // Scrolling or dragging means you want the card itself: solid until the pointer leaves.
  const solid = () => {
    solidUntilLeave.current = true;
    setPeek(false);
  };

  return (
    <div className="flex h-full w-full items-end justify-center px-10 pb-4">
      <div
        ref={card}
        key={state.seq}
        onMouseEnter={() => {
          hovered.current = true;
          ciao.overlay.setInteractive(true);
        }}
        onMouseMove={(e) => {
          // Only a real pointer move turns it see-through: the card often appears right under a
          // resting cursor (at the prompt box), and that alone must not hide the text.
          // The header stays readable: its dot finishes a hands-free dictation.
          if ((e.target as HTMLElement).closest("header")) {
            if (peek) setPeek(false);
            pointerAt.current = null;
            return;
          }
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
        {...cardDrag}
        onPointerDown={(e) => {
          solid();
          cardDrag.onPointerDown(e);
        }}
        className={`${leaving ? (pill ? "card-fold" : "card-leave") : pill ? "card-unfold" : "card-enter"} group relative w-full cursor-grab rounded-[22px] bg-overlay/95 px-5 pt-3 pb-3.5 shadow-[0_14px_44px_rgb(0_0_0/0.16)] ring-1 ring-tint/10 transition-opacity duration-300 ease-out active:cursor-grabbing dark:shadow-[0_14px_44px_rgb(0_0_0/0.5)] ${peek ? "opacity-[0.18]" : "opacity-100"}`}
      >
        <header className="mb-1.5 grid h-6 grid-cols-[1fr_auto_1fr] items-center">
          <div className="flex items-center gap-2">
            {icon}
            {state.handsFree && state.phase === "recording" && <Lock className="size-3.5 text-faint" />}
            {state.offline && state.phase === "recording" && <CloudOff className="size-3.5 text-amber-700 dark:text-amber-300/80" />}
          </div>
          <div className={`flex items-center gap-1.5 text-[13px] font-medium tracking-wide tabular-nums ${finishing ? "text-faint" : "text-fg2"}`}>
            {/* Headed for T3 Code: its logo by the clock. */}
            {state.t3 && <img src="./t3code.png" alt="T3 Code" title={tr.t3Badge} draggable={false} className="size-4 rounded-[4px]" />}
            {clock(elapsed)}
          </div>
          <div className="mr-3 flex items-center justify-self-end gap-2 text-[12px] text-faint tabular-nums">
            {[state.delay, state.showCost ? cost : null].filter(Boolean).join(" · ")}
            {state.phase === "recording" && (
              // Finishes the dictation however it started (the pill, a key, the wake word): the text goes where it would on a stop.
              <button
                onClick={() => ciao.overlay.stop()}
                title={tr.finish}
                className="-my-1 inline-flex cursor-pointer items-center gap-1 rounded-lg px-2 py-0.5 text-[12px] font-medium text-fg2 ring-1 ring-tint/15 hover:bg-tint/10 hover:text-fg"
              >
                <Square className="size-2.5 fill-current" />
                {tr.stop}
              </button>
            )}
            {withActions && (
              <button onClick={dismiss} title={tr.close} className="rounded-md p-0.5 text-faint hover:bg-tint/10 hover:text-fg">
                <X className="size-3.5" />
              </button>
            )}
          </div>
        </header>
        {kept ? (
          // A text box like any other for the mouse: select, and drag the selection out into another
          // app's field. Read-only: the overlay never takes the keyboard, or it would keep it from the app
          // you dictate into (and from the one you drop the text in).
          <textarea
            data-selectable
            readOnly
            value={keptText}
            // A second press on the same spot within half a second selects it all, like a double click in a
            // text field. Counted here: on Windows the browser's own count is thrown off by the press the
            // window hands it in place of the one it would eat (overlayWindow.ts, pressEaten).
            onMouseDown={(e) => {
              if (e.button !== 0) return;
              const now = performance.now();
              const last = lastPress.current;
              lastPress.current = { at: now, x: e.clientX, y: e.clientY };
              if (e.detail < 2 && (now - last.at > DOUBLE_PRESS_MS || Math.hypot(e.clientX - last.x, e.clientY - last.y) > 6)) return;
              e.preventDefault(); // not the word under the pointer: all of it
              e.currentTarget.setSelectionRange(0, e.currentTarget.value.length);
            }}
            onDoubleClick={(e) => {
              // The browser's own double click would select a word (or nothing) after the press above.
              e.preventDefault();
              e.currentTarget.setSelectionRange(0, e.currentTarget.value.length);
            }}
            rows={Math.min(maxLines - 1, Math.max(2, Math.ceil(keptText.length / 70) + (keptText.match(/\n/g)?.length ?? 0)))}
            spellCheck={false}
            className="selectable block w-full cursor-text resize-none rounded-xl bg-tint/5 px-3 py-2 text-[15px] leading-[25px] text-fg outline-none ring-1 ring-tint/20 focus:ring-tint/40"
          />
        ) : showText ? (
          <Scroller maxLines={maxLines}>{content}</Scroller>
        ) : null}
        {state.message && <div className="mt-2 text-[12.5px] text-amber-700 dark:text-amber-200/90">{state.message}</div>}
        {withActions && (
          <div className="mt-2.5 -ml-2 flex gap-1">
            {(state.phase === "recovered" || state.keep) && text.final && (
              <button
                onClick={async () => {
                  await ciao.overlay.copy(kept ? keptText : text.final!);
                  setCopied(true);
                  setTimeout(dismiss, 700);
                }}
                className="inline-flex items-center gap-1.5 rounded-lg bg-tint/8 px-2.5 py-1 text-[12.5px] text-fg hover:bg-tint/12"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? tr.copied : tr.copy}
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
              {tr.history}
            </button>
          </div>
        )}

        {/* The whole card drags; the grip shows that it can, and a double-click on it puts the card back. Corner: width and height. */}
        <div
          // Only a double-click that began here: the pill sat on this spot, and its click starts the card.
          onPointerDown={() => (gripPressedAt.current = Date.now())}
          onDoubleClick={() => {
            if (Date.now() - gripPressedAt.current < 600) ciao.overlay.resetPlacement();
          }}
          title={tr.gripTitle}
          className="absolute -bottom-2.5 left-1/2 flex h-5 w-16 -translate-x-1/2 items-center justify-center opacity-0 transition-opacity group-hover:opacity-100"
        >
          <span className="h-1.5 w-10 rounded-full bg-tint/25 ring-1 ring-overlay" />
        </div>
        <div
          {...resizeDrag}
          title={tr.resizeTitle}
          className="absolute top-1 right-1 size-4 cursor-nesw-resize opacity-0 transition-opacity group-hover:opacity-100"
        >
          <svg viewBox="0 0 16 16" className="size-4 text-ghost">
            <path d="M6 2h8v8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" fill="none" />
          </svg>
        </div>
      </div>
    </div>
  );
}
