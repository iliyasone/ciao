import { findCorrections, newTerms, type Correction } from "../core/corrections";
import type { InputHelper } from "./input";

// Watches the field a dictation was pasted into for a couple of minutes and reports words the user
// corrected (src/core/corrections.ts decides which). The field is read through the input helper only
// after a key press in it (debounced), and right as Enter is pressed in that window: chat apps send
// and clear the field then. A correction is offered once two reads in a row show it (or Enter
// does), so a word still being typed ("PostHo") isn't. The text stays in this process: it is
// compared and dropped, never logged or stored.

const WATCH_MS = 120_000;
/** The user pastes text that missed its window by hand within this time, or it isn't watched. */
const MANUAL_PASTE_MS = 60_000;
/** After a paste, before the first read: the app needs a moment to take the text in. */
const SETTLE_MS = 400;
/** A read this long after the last key press. */
const TYPING_PAUSE_MS = 900;
/** A second read this long after one that found something, to see that it stayed. */
const CONFIRM_MS = 1500;

interface Watch {
  text: string;
  hwnd: number;
  /** Words already offered in this watch. */
  offered: Set<string>;
  /** Corrections the last read found, waiting for the next one to confirm them. */
  seen: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

export class CorrectionWatcher {
  private watch: Watch | null = null;
  /** Text that went to the clipboard, waiting for the user's own paste. */
  private pending: { text: string; until: number } | null = null;
  private stopAt?: ReturnType<typeof setTimeout>;
  private reading = false;

  constructor(
    private readonly deps: {
      input: InputHelper;
      /** Words not to offer: the terms, and suggestions the user turned down. */
      known: () => string[];
      suggest: (c: Correction) => void;
    },
  ) {
    deps.input.on("key", (kind, text) => this.onKey(kind, text));
  }

  /** `text` was just pasted into `hwnd`. */
  pasted(text: string, hwnd: number): void {
    this.stop();
    this.watch = { text, hwnd, offered: new Set(), seen: new Set() };
    this.listen(WATCH_MS, hwnd);
    this.schedule(SETTLE_MS);
  }

  /** `text` is on the clipboard (its window was gone): watch the field the user pastes it into. */
  onClipboard(text: string): void {
    this.stop();
    this.pending = { text, until: Date.now() + MANUAL_PASTE_MS };
    this.listen(MANUAL_PASTE_MS, 0);
  }

  stop(): void {
    if (this.watch?.timer) clearTimeout(this.watch.timer);
    clearTimeout(this.stopAt);
    if (this.watch || this.pending) this.deps.input.watch(false);
    this.watch = null;
    this.pending = null;
  }

  /** `hwnd`: the window whose field Enter reads (0: none). */
  private listen(ms: number, hwnd: number): void {
    this.deps.input.watch(true, hwnd);
    this.stopAt = setTimeout(() => this.stop(), ms);
  }

  private onKey(kind: "enter" | "paste" | "other", text: string | null): void {
    const p = this.pending;
    if (p && kind === "paste") {
      if (Date.now() > p.until) return this.stop();
      void this.deps.input.foreground().then((f) => {
        if (this.pending === p && f) this.pasted(p.text, f.hwnd);
      });
      return;
    }
    const w = this.watch;
    if (!w) return;
    if (kind === "enter" && text !== null) this.check(w, text, true);
    // After Enter too: the read shows whether the text was sent (and the watch can end).
    this.schedule(TYPING_PAUSE_MS);
  }

  private schedule(ms: number): void {
    const w = this.watch;
    if (!w) return;
    if (w.timer) clearTimeout(w.timer);
    w.timer = setTimeout(() => void this.read(w), ms);
  }

  private async read(w: Watch): Promise<void> {
    if (this.reading) return this.schedule(TYPING_PAUSE_MS);
    this.reading = true;
    try {
      const r = await this.deps.input.field(w.hwnd);
      if (this.watch !== w) return;
      if (r.text !== null) this.check(w, r.text, false);
      // The user is elsewhere for now; any other miss means this field can't be read at all.
      else if (r.reason !== "focus-changed" && r.reason !== "timeout") this.stop();
    } finally {
      this.reading = false;
    }
  }

  /** `final`: read as Enter was pressed, the last look at the text before it is sent. */
  private check(w: Watch, field: string, final: boolean): void {
    const found = findCorrections(w.text, field);
    if (found === null) {
      if (this.watch === w) this.stop(); // sent, deleted or rewritten
      return;
    }
    const fresh = newTerms(found, this.deps.known()).filter((c) => !w.offered.has(c.fixed.toLowerCase()));
    const seen = new Set(fresh.map((c) => c.fixed.toLowerCase()));
    let waiting = false;
    for (const c of fresh) {
      const k = c.fixed.toLowerCase();
      if (!final && !w.seen.has(k)) {
        waiting = true;
        continue;
      }
      w.offered.add(k);
      this.deps.suggest(c);
    }
    w.seen = seen;
    if (waiting && !final) this.schedule(CONFIRM_MS);
  }
}
