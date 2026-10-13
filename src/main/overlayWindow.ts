import path from "node:path";
import { BrowserWindow, screen, type Rectangle } from "electron";
import type { OverlayState, TermSuggestion } from "../core/types";
import type { OverlayPort } from "./dictation";

// Transparent window a bit larger than the card (room for its shadow); the card grows
// smoothly inside and the empty area lets clicks through. Never focusable, so the app you
// dictate into stays active. Between dictations it shows a small Ciao pill where the card's bottom
// edge is (if Settings.overlayPill): the card unfolds from it and folds back into it. The pill and
// the card are dragged anywhere and the card's corner sizes it; the spot and size are remembered.
//
// Letting clicks through: on Windows and macOS the window ignores the mouse except while the pointer
// is over the pill or a card. The renderer reports what it draws, and the cursor is checked against
// that here: the hovers it reports come from mouse moves forwarded to a click-through window, which
// don't always arrive (a suggestion that came up while you typed elsewhere let its clicks through).
// Linux can't forward them at all, so there the window's shape is cut to what is drawn instead.
// A press that comes while the window still lets clicks through goes to the app below and is lost,
// so near what is drawn the check runs every 25 ms; far from it, less often (by how soon the pointer
// could get there), so an idle pill doesn't wake the app 40 times a second.
//
// Dragging follows the cursor from here, not the pointer positions the renderer sees: those are
// measured against a window that is itself moving, and stall or jump while it does.
const LINE = 25; // px, one line of the card's text
/** Window height minus the text lines: the card's header, padding and shadow room. */
const CHROME_HEIGHT = 170;
const SIDE_PADDING = 80; // card width + this = window width
/** From the window's bottom edge to the card's (the renderer's bottom padding). */
const CARD_BOTTOM = 16;
const SCREEN_GAP = 28; // from the bottom of the screen to the window, by default
export const DEFAULT_CARD_WIDTH = 640;
const MIN_CARD_WIDTH = 420;
const MAX_CARD_WIDTH = 1400;
export const MIN_LINES = 3;
export const MAX_LINES = 24;
const LINUX = process.platform === "linux";
/** How often the cursor is checked against what is drawn, near it and far from it (Windows, macOS). */
const POLL_MIN_MS = 25;
const POLL_MAX_MS = 250;
/** A fast flick of the pointer, px per ms: the next check comes before it could reach what is drawn. */
const POINTER_SPEED = 4;
/** How often a drag moves the window after the cursor (about a frame). */
const DRAG_MS = 16;

export interface OverlayPlacement {
  /** The middle of the card's bottom edge on screen; null = bottom-centre of the display under the cursor. */
  anchor: { x: number; y: number } | null;
  cardWidth: number;
  lines: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class OverlayWindow implements OverlayPort {
  readonly win: BrowserWindow;
  private visibleSeq = -1;
  private drag0: { mode: "move" | "resize"; bounds: Rectangle; lines: number; cursor: { x: number; y: number } } | null = null;
  private dragTimer: ReturnType<typeof setInterval> | null = null;
  private dragAt = { x: NaN, y: NaN };
  private wake = false;
  private pill: boolean;
  /** The renderer shows a card or a suggestion; without the pill the window hides when it shows nothing. */
  private busy = false;
  /** What the renderer draws, in window pixels. */
  private region: Rectangle[] = [];
  /** The renderer saw the pointer over something it draws. */
  private hovered = false;
  private ignoring = true;
  private poll: ReturnType<typeof setTimeout> | null = null;

  constructor(
    preload: string,
    rendererDir: string,
    private readonly placement: () => OverlayPlacement,
    private readonly savePlacement: (p: OverlayPlacement) => void,
    pill: boolean,
  ) {
    this.pill = pill;
    this.win = new BrowserWindow({
      ...this.bounds(),
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      alwaysOnTop: true,
      // macOS: the first click on it is a click, not one that only activates it (it never is active).
      acceptFirstMouse: true,
      // macOS: a non-activating panel, so showing it never takes focus from the app being dictated into.
      ...(process.platform === "darwin" && { type: "panel" }),
      backgroundColor: "#00000000",
      webPreferences: {
        preload,
        backgroundThrottling: false, // the mic is captured here even while hidden
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    // macOS: show on every Space, over full-screen apps too.
    if (process.platform === "darwin") this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    if (LINUX) this.win.setShape([]);
    else this.win.setIgnoreMouseEvents(true, { forward: true });
    // A monitor went away or changed: bring the pill back onto a screen (not under a running card).
    const replace = () => {
      if (this.pill && !this.busy && this.win.isVisible()) this.place();
    };
    screen.on("display-removed", replace);
    screen.on("display-metrics-changed", replace);
    void this.win.loadFile(path.join(rendererDir, "overlay.html"));
    this.win.on("closed", () => {
      this.stopPoll();
      this.stopDragTimer();
    });
    this.win.webContents.on("did-finish-load", () => {
      // A reloaded page reports what it draws afresh.
      this.hovered = false;
      this.drag0 = null;
      this.stopDragTimer();
      this.setRegion([]);
      this.win.webContents.send("wake:enable", this.wake);
      this.win.webContents.send("overlay:pill", this.pill);
      if (this.pill) this.win.showInactive();
    });
  }

  /** Keep the mic open for the wake-word detector (or not). */
  setWake(on: boolean): void {
    this.wake = on;
    if (!this.win.webContents.isLoading()) this.win.webContents.send("wake:enable", on);
  }

  /** Show the pill between dictations (or not). */
  setPill(on: boolean): void {
    if (on === this.pill) return;
    this.pill = on;
    if (this.win.webContents.isLoading()) return;
    this.win.webContents.send("overlay:pill", on);
    if (on) {
      if (!this.busy) this.place(); // not under a card that is up
      this.win.showInactive();
    } else if (!this.busy) {
      this.win.hide();
    }
  }

  /** Windows, macOS: the renderer saw the pointer come over the pill or a card (or leave it). */
  setInteractive(on: boolean): void {
    this.hovered = on;
    this.updateMouse();
  }

  /** What the renderer draws (the pill, a card), in window pixels; the rest lets clicks through. */
  setRegion(rects: Rectangle[]): void {
    this.region = rects;
    if (LINUX) {
      // Room for the shadows (0 14px 44px): the shape clips drawing too.
      this.win.setShape(rects.map((r) => ({ x: Math.floor(r.x - 30), y: Math.floor(r.y - 20), width: Math.ceil(r.width + 60), height: Math.ceil(r.height + 76) })));
      return;
    }
    this.updatePoll();
    this.updateMouse();
  }

  private updatePoll(): void {
    const on = !LINUX && this.region.length > 0;
    if (on === (this.poll !== null)) return;
    this.stopPoll();
    if (on) this.tick();
  }

  private tick(): void {
    const distance = this.updateMouse();
    this.poll = setTimeout(() => this.tick(), clamp(distance / POINTER_SPEED, POLL_MIN_MS, POLL_MAX_MS));
  }

  private stopPoll(): void {
    if (this.poll) clearTimeout(this.poll);
    this.poll = null;
  }

  /**
   * Windows, macOS: clicks and wheel scrolling land on the window while the pointer is over what it draws, or a drag is on.
   * Returns how far the pointer is from what is drawn, px (0 over it; Infinity with nothing to check).
   */
  private updateMouse(): number {
    if (LINUX || this.win.isDestroyed()) return Infinity;
    let interactive = this.drag0 !== null;
    let distance = interactive ? 0 : Infinity;
    if (!interactive && this.win.isVisible()) {
      const b = this.win.getBounds();
      const p = screen.getCursorScreenPoint();
      for (const r of this.region) {
        const dx = Math.max(b.x + r.x - p.x, 0, p.x - (b.x + r.x + r.width));
        const dy = Math.max(b.y + r.y - p.y, 0, p.y - (b.y + r.y + r.height));
        distance = Math.min(distance, Math.hypot(dx, dy));
      }
      // A hover the renderer missed the end of doesn't count once the pointer is off the window.
      interactive = (this.hovered && contains(b, p)) || this.region.some((r) => contains({ x: b.x + r.x, y: b.y + r.y, width: r.width, height: r.height }, p));
      if (interactive) distance = 0;
    }
    if (interactive === this.ignoring) {
      this.ignoring = !interactive;
      this.win.setIgnoreMouseEvents(this.ignoring, { forward: true });
    }
    return distance;
  }

  /** The renderer finished folding away the card for `seq`. */
  hidden(seq: number): void {
    if (seq === this.visibleSeq) this.visibleSeq = -1;
  }

  /** The renderer shows a card or a suggestion (true), or nothing but maybe the pill (false). */
  setBusy(on: boolean): void {
    this.busy = on;
    // A card that folded away may report after the next one was already shown: keep that one up.
    if (on && !this.win.isVisible()) this.win.showInactive();
    else if (!on && !this.pill && this.visibleSeq === -1) this.win.hide();
  }

  // ── Moving and resizing ─────────────────────────────────────────────────

  /**
   * x/y: where the press was on screen (a move starts once the pointer went a few pixels from it;
   * the window hasn't moved yet, so the renderer's reading is right). From here the window follows
   * the cursor until dragEnd.
   */
  dragStart(mode: "move" | "resize", x: number, y: number): void {
    this.drag0 = { mode, bounds: this.win.getBounds(), lines: this.placement().lines, cursor: { x, y } };
    this.dragAt = { x: NaN, y: NaN };
    this.updateMouse();
    this.drag();
    this.stopDragTimer();
    this.dragTimer = setInterval(() => this.drag(), DRAG_MS);
  }

  private stopDragTimer(): void {
    if (this.dragTimer) clearInterval(this.dragTimer);
    this.dragTimer = null;
  }

  /** Puts the window where the cursor says. "move" shifts it; "resize" widens the card (both ways) and adds lines (upwards). */
  private drag(): void {
    const d = this.drag0;
    if (!d || this.win.isDestroyed()) return;
    const c = screen.getCursorScreenPoint();
    if (c.x === this.dragAt.x && c.y === this.dragAt.y) return;
    this.dragAt = c;
    const dx = c.x - d.cursor.x;
    const dy = c.y - d.cursor.y;
    const o = d.bounds;
    if (d.mode === "move") {
      this.win.setBounds({ ...o, x: Math.round(o.x + dx), y: Math.round(o.y + dy) });
      return;
    }
    const card = clamp(o.width - SIDE_PADDING + 2 * dx, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
    const lines = clamp(d.lines + Math.round(-dy / LINE), MIN_LINES, MAX_LINES);
    const width = card + SIDE_PADDING;
    const height = CHROME_HEIGHT + lines * LINE;
    // The card's bottom edge stays where it is and its middle too.
    this.win.setBounds({ x: Math.round(o.x + (o.width - width) / 2), y: o.y + o.height - height, width, height });
  }

  dragEnd(): void {
    this.stopDragTimer();
    if (!this.drag0) return;
    this.drag();
    this.drag0 = null;
    const save = () => {
      const b = this.win.getBounds();
      this.savePlacement({
        anchor: { x: b.x + Math.round(b.width / 2), y: b.y + b.height - CARD_BOTTOM },
        cardWidth: b.width - SIDE_PADDING,
        lines: Math.round((b.height - CHROME_HEIGHT) / LINE),
      });
    };
    save();
    // Dropped (partly) off the screen: back into it, and remember where it ended up.
    this.place();
    save();
    this.updateMouse();
    console.log("overlay moved to", JSON.stringify(this.win.getBounds()));
  }

  /** Back to bottom-centre at the default size. */
  resetPlacement(): void {
    this.drag0 = null;
    this.stopDragTimer();
    this.savePlacement({ anchor: null, cardWidth: DEFAULT_CARD_WIDTH, lines: 6 });
    this.place();
    this.updateMouse();
  }

  // ── OverlayPort ─────────────────────────────────────────────────────────

  state(s: OverlayState): void {
    if (this.visibleSeq !== s.seq) {
      // Without a saved spot the card comes up on the display you're working on; while the pill is
      // shown it unfolds where the pill is.
      if (!this.pill || !this.win.isVisible()) this.place();
      this.win.showInactive();
      this.visibleSeq = s.seq;
    }
    this.win.webContents.send("overlay:state", s);
  }

  delta(seq: number, text: string, gapMs: number): void {
    this.win.webContents.send("overlay:delta", seq, text, gapMs);
  }

  revise(seq: number, text: string, gapMs: number): void {
    this.win.webContents.send("overlay:revise", seq, text, gapMs);
  }

  final(seq: number, text: string): void {
    this.win.webContents.send("overlay:final", seq, text);
  }

  startCapture(seq: number): void {
    this.win.webContents.send("capture:start", seq);
  }

  stopCapture(seq: number): void {
    this.win.webContents.send("capture:stop", seq);
  }

  suggest(s: TermSuggestion): void {
    if (!this.win.isVisible()) {
      this.place();
      this.win.showInactive();
    }
    this.win.webContents.send("overlay:suggest", s);
  }

  /** Where the window goes for the saved spot and size, or bottom-centre of the display under the cursor. */
  private bounds(): Rectangle {
    const { anchor, cardWidth, lines } = this.placement();
    const width = clamp(cardWidth, MIN_CARD_WIDTH, MAX_CARD_WIDTH) + SIDE_PADDING;
    const height = CHROME_HEIGHT + clamp(lines, MIN_LINES, MAX_LINES) * LINE;
    // The card unfolds up and to both sides of the anchor: keep all of it on the anchor's screen (its
    // transparent margin may stick out), so a pill dragged to an edge doesn't open a card off screen.
    const at = (x: number, y: number, a: Rectangle) => ({
      x: Math.round(clamp(x - width / 2, a.x - SIDE_PADDING / 2, a.x + a.width - width + SIDE_PADDING / 2)),
      y: Math.round(clamp(y + CARD_BOTTOM - height, a.y, a.y + a.height - height + CARD_BOTTOM)),
      width,
      height,
    });
    // A saved spot is used while it is still on or next to some screen (monitors come and go;
    // a pill dropped on the taskbar is just past the work area).
    if (anchor) {
      const near = screen.getDisplayNearestPoint(anchor).bounds;
      if (contains({ x: near.x - 200, y: near.y - 200, width: near.width + 400, height: near.height + 400 }, anchor)) {
        return at(anchor.x, anchor.y, screen.getDisplayNearestPoint(anchor).workArea);
      }
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    return at(area.x + area.width / 2, area.y + area.height - SCREEN_GAP - CARD_BOTTOM, area);
  }

  private place(): void {
    this.win.setBounds(this.bounds());
  }
}

function contains(a: Rectangle, p: { x: number; y: number }): boolean {
  return p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height;
}
