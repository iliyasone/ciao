import path from "node:path";
import { BrowserWindow, screen, type Rectangle } from "electron";
import { Spring } from "../core/spring";
import type { OverlayState, TermSuggestion } from "../core/types";
import type { OverlayPort } from "./dictation";
import { logRenderer } from "./rendererLog";
import { WakeWord } from "./wakeWord";

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
// Windows: a press on a window that can't be activated never reaches the page. Chromium answers the
// WM_MOUSEACTIVATE that comes before it with "don't activate, and eat the click"
// (HWNDMessageHandler::OnMouseActivate), so only the release arrives and no button, drag or text
// selection works. The press is handed to the page from here, where the cursor is as the message
// comes (a few pixels on from the press after a flick). If a later Electron stops eating it, every
// press arrives twice: check this on an upgrade. The page's press doesn't capture the mouse, so a
// release outside the window (a resize stopped by its limits) isn't seen until the pointer is back.
//
// Windows: an app that moves a picture of the screen (a desktop switch that follows the fingers) sends
// the "Lanes.ScreenPicture" message to topmost windows just before it copies the screen: wParam 1, and
// 0 once it has. The pill leaves itself out of screen capture in between (WDA_EXCLUDEFROMCAPTURE, read
// by that app to keep it over the picture, live), and is in screenshots again right after.
//
// Windows: the window is topmost, yet it has stopped being seen while everything else went on (cards
// drawn and folded, nothing in ciao.log) until Ciao was started again. So each card goes back on top of
// the other windows as it comes up, and ciao.log first says what kept it from being seen, if anything:
// the windows lying over it, or that Windows hides it (cloaked).
//
// The page records the mic too, so a crashed or stuck page means no pill and every dictation empty
// until it is loaded again: it is, after a crash, a hang, or a stop it didn't answer (restart).
//
// Dragging follows the cursor from here, not the pointer positions the renderer sees: those are
// measured against a window that is itself moving, and stall or jump while it does.
//
// Moving: what is placed is the pill (its centre, the anchor), anywhere on the screen; the window is the
// card's size around it, kept on the screen, and the renderer is told where in it the pill is. The card
// opens upwards from the pill, or downwards where there is no room above. Dragged, the pill or the card
// trails the cursor on a stiff spring, so it has some weight; let go, it glides on a softer one: thrown,
// it goes on a little; near a screen edge it settles against it, near bottom-centre it goes home. A card
// on screen stops at the screen edges as at a wall and keeps the side it opens to.
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
/** How often a drag or a glide moves the window (about a frame). */
const FRAME_MS = 16;
/** The pill, px (the renderer's Pill). */
const PILL_W = 56;
const PILL_H = 30;
/** Springs (as on Android, src/core/spring.ts): trailing the cursor, and gliding to where it settles. */
const DRAG_STIFFNESS = 1500;
const GLIDE_STIFFNESS = 380;
/** A throw: faster than this goes on for this long at its speed (capped), px/s and s. */
const THROW_SPEED = 500;
const THROW_MAX_SPEED = 4000;
const THROW_S = 0.12;
/** Settling: the pill keeps this far inside the screen; closer to an edge than SNAP, it goes against it; closer to home than HOME_SNAP, home. */
const EDGE_INSET = 8;
const EDGE_SNAP = 32;
const HOME_SNAP = 48;
const WM_MOUSEACTIVATE = 0x0021;
const WM_LBUTTONDOWN = 0x0201;
const WM_LBUTTONDBLCLK = 0x0203;
/** After a crash, before loading the page again: a page that crashes on load doesn't spin the CPU. */
const RELOAD_AFTER_MS = 1000;

export interface OverlayPlacement {
  /** The middle of the card's bottom edge on screen; null = bottom-centre of the display under the cursor. */
  anchor: { x: number; y: number } | null;
  cardWidth: number;
  lines: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

type Point = { x: number; y: number };
interface Layout {
  rect: Rectangle;
  /** The pill's centre on screen, moved onto the screen (or with the card, see layout). */
  anchor: Point;
  /** The card opens downwards from the pill. */
  down: boolean;
}

export class OverlayWindow implements OverlayPort {
  readonly win: BrowserWindow;
  private visibleSeq = -1;
  /** Cards showing the check (done), and when it showed. */
  private readonly doneAt = new Map<number, { at: number; t3: boolean }>();
  private drag0: {
    mode: "move" | "resize";
    anchor: Point;
    rect: Rectangle;
    cardWidth: number;
    lines: number;
    cursor: Point;
    glue: Point | null;
    /** It was gliding when caught: where it ends up is a new spot, not the saved one. */
    gliding: boolean;
  } | null = null;
  /** Moves the window each frame while a drag or a glide is on. */
  private motion: ReturnType<typeof setInterval> | null = null;
  private motionAt = 0;
  private readonly spring = new Spring(DRAG_STIFFNESS);
  /** Where a glide ends: the saved spot then (null: home). */
  private glideTo: Point | null | undefined;
  /** Where the pill is now, and the side the card opens to. */
  private anchor: Point = { x: 0, y: 0 };
  private down = false;
  /** What the renderer was last told of where the pill is in the window. */
  private told = "";
  private wake = false;
  private mic = "";
  private pill: boolean;
  /** The dictation recording now: a page loaded meanwhile (after a crash) is told to record it. */
  private capturing: number | null = null;
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
    const first = this.layout(this.saved(), this.size());
    this.anchor = first.anchor;
    this.down = first.down;
    this.win = new BrowserWindow({
      ...first.rect,
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
    if (process.platform === "win32") {
      this.win.hookWindowMessage(WM_MOUSEACTIVATE, (_wParam, lParam) => this.pressEaten(lParam.readUInt32LE(0) >>> 16));
      // Handled inside the window procedure, so it is set before the sender's SendMessage returns.
      const picture = screenPictureMessage();
      if (picture) this.win.hookWindowMessage(picture, (wParam) => this.win.setContentProtection(wParam.readUInt32LE(0) === 1));
    }
    // A monitor went away or changed: bring the pill back onto a screen (not under a running card).
    const replace = () => {
      if (this.pill && !this.busy && this.win.isVisible()) this.place();
    };
    screen.on("display-removed", replace);
    screen.on("display-metrics-changed", replace);
    void this.win.loadFile(path.join(rendererDir, "overlay.html"));
    const wc = this.win.webContents;
    logRenderer(wc, "overlay");
    wc.on("render-process-gone", () => {
      setTimeout(() => {
        if (!this.win.isDestroyed() && wc.isCrashed()) wc.reload(); // in a new process
      }, RELOAD_AFTER_MS);
    });
    wc.on("unresponsive", () => this.restart("not responding"));
    this.win.on("closed", () => {
      this.stopPoll();
      this.stopMotion();
    });
    this.win.webContents.on("did-finish-load", () => {
      // A reloaded page reports what it draws afresh.
      this.hovered = false;
      this.drag0 = null;
      this.sizeNow = null;
      this.stopMotion();
      this.setRegion([]);
      // It shows nothing yet: the next card is placed and shown afresh. The pill goes back to the
      // saved spot and size (a drag or a resize it cut short isn't saved), and is told where it is.
      this.busy = false;
      this.visibleSeq = -1;
      this.told = "";
      this.place();
      this.win.webContents.send("capture:mic", this.mic); // before the wake word opens it
      this.win.webContents.send("wake:enable", this.wake);
      this.win.webContents.send("overlay:pill", this.pill);
      if (this.capturing !== null) this.win.webContents.send("capture:start", this.capturing);
      if (this.pill) this.win.showInactive();
    });
  }

  /** The page is stuck or didn't answer: end its process, and render-process-gone loads it again in a new one. */
  restart(why: string): void {
    if (this.win.isDestroyed() || this.win.webContents.isCrashed()) return;
    console.warn("overlay: loading the page again:", why);
    this.win.webContents.forcefullyCrashRenderer();
  }

  /** Keep the mic open for the wake-word detector (or not). */
  setWake(on: boolean): void {
    this.wake = on;
    if (!this.win.webContents.isLoading()) this.win.webContents.send("wake:enable", on);
  }

  /** The microphone to record from, by name ("" = the system's default). */
  setMic(name: string): void {
    this.mic = name;
    if (!this.win.webContents.isLoading()) this.win.webContents.send("capture:mic", name);
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
    this.check();
  }

  /** What the renderer draws (the pill, a card), in window pixels; the rest lets clicks through. */
  setRegion(rects: Rectangle[]): void {
    this.region = rects;
    // A card that grew (the text did) stays on the screen.
    if (this.busy && !this.drag0 && !this.motion && rects.length) this.apply(this.layout(this.anchor, this.size(), this.glued()));
    if (LINUX) {
      // Room for the shadows (0 14px 44px): the shape clips drawing too.
      this.win.setShape(rects.map((r) => ({ x: Math.floor(r.x - 30), y: Math.floor(r.y - 20), width: Math.ceil(r.width + 60), height: Math.ceil(r.height + 76) })));
      return;
    }
    this.check();
  }

  /** Checks the cursor now, and schedules the next check by what is drawn now: a timeout queued for the old drawing may be far off. */
  private check(): void {
    this.stopPoll();
    if (!LINUX && this.region.length) this.tick();
    else this.updateMouse();
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

  /** Windows: the left-button press that Chromium is about to eat (`message` started it), given to the page instead. */
  private pressEaten(message: number): void {
    if (message !== WM_LBUTTONDOWN && message !== WM_LBUTTONDBLCLK) return;
    const c = screen.getCursorScreenPoint();
    const b = this.win.getBounds();
    this.win.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      x: c.x - b.x,
      y: c.y - b.y,
      globalX: c.x,
      globalY: c.y,
      clickCount: message === WM_LBUTTONDBLCLK ? 2 : 1,
    });
  }

  /** The renderer finished folding away the card for `seq`; its fold waited `waitedMs` for the pointer to leave it, or went with the pointer on it (`over`). */
  hidden(seq: number, waitedMs: number, over: boolean): void {
    const done = this.doneAt.get(seq);
    this.doneAt.delete(seq);
    if (done) console.log("overlay: card", seq, done.t3 ? "(T3)" : "", "gone", `${Date.now() - done.at}ms`, "after its check", waitedMs ? `(waited ${waitedMs}ms for the pointer to leave it)` : over ? "(the pointer was on it)" : "");
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
    // A resize starts at the press itself: from the cursor, or a fractional screenX would size the card by a pixel on a click.
    const cursor = mode === "resize" ? screen.getCursorScreenPoint() : { x, y };
    const { cardWidth, lines } = this.size();
    const b = this.win.getBounds();
    // A card on screen moves with the pill where it is in it now.
    const glue = this.busy ? { x: this.anchor.x - b.x, y: this.anchor.y - b.y } : null;
    this.drag0 = { mode, anchor: { ...this.anchor }, rect: b, cardWidth, lines, cursor, glue, gliding: !!this.motion };
    // Caught mid-glide: from where it is, with the speed it has.
    if (!this.motion) this.spring.reset(this.anchor.x, this.anchor.y);
    this.spring.stiffness = DRAG_STIFFNESS;
    this.glideTo = undefined;
    this.updateMouse();
    this.startMotion();
  }

  private startMotion(): void {
    if (this.motion) return;
    this.motionAt = performance.now();
    this.motion = setInterval(() => this.frame(), FRAME_MS);
  }

  private stopMotion(): void {
    if (this.motion) clearInterval(this.motion);
    this.motion = null;
  }

  /** One frame: a drag puts the window where the cursor says, a glide moves it on towards where it settles. */
  private frame(): void {
    if (this.win.isDestroyed()) return this.stopMotion();
    const now = performance.now();
    const dt = (now - this.motionAt) / 1000;
    this.motionAt = now;
    const d = this.drag0;
    if (d?.mode === "resize") return this.resize(d);
    if (d) {
      const c = screen.getCursorScreenPoint();
      this.spring.toX = d.anchor.x + c.x - d.cursor.x;
      this.spring.toY = d.anchor.y + c.y - d.cursor.y;
    }
    this.spring.step(dt);
    const glue = d ? d.glue : this.busy ? this.glued() : null;
    this.apply(this.layout({ x: this.spring.x, y: this.spring.y }, this.size(), glue));
    if (!d && this.spring.resting) this.settled();
  }

  /** Where the pill is in the window now, for a card that keeps it there. */
  private glued(): Point {
    const b = this.win.getBounds();
    return { x: this.anchor.x - b.x, y: this.anchor.y - b.y };
  }

  /**
   * The card's corner: wider both ways, and more lines away from the pill. Its middle and the edge the
   * pill is on stay where they are, unless that would put it off the screen; the pill stays on that edge.
   */
  private resize(d: NonNullable<typeof this.drag0>): void {
    const c = screen.getCursorScreenPoint();
    const dx = Math.round(c.x - d.cursor.x);
    const dy = Math.round(c.y - d.cursor.y);
    const cardWidth = clamp(d.cardWidth + 2 * dx, MIN_CARD_WIDTH, MAX_CARD_WIDTH);
    const lines = clamp(d.lines + Math.round((this.down ? dy : -dy) / LINE), MIN_LINES, MAX_LINES);
    this.sizeNow = { cardWidth, lines };
    const o = d.rect;
    const width = cardWidth + SIDE_PADDING;
    const height = CHROME_HEIGHT + lines * LINE;
    const area = screen.getDisplayNearestPoint({ x: Math.round(d.anchor.x), y: Math.round(d.anchor.y) }).workArea;
    const x = o.x + (o.width - width) / 2;
    const y = this.down ? o.y : o.y + o.height - height;
    // The card as it will be drawn: as high as now, on the pill's side of the resized window.
    const now = this.drawn();
    const was = this.win.getBounds().height; // the window it was drawn in
    const card = now && { x: SIDE_PADDING / 2, width: cardWidth, height: now.height, y: this.down ? now.y : height - (was - now.y) };
    const rect = card ? fitDrawn(area, x, y, card, width, height) : fitRect(area, x, y, width, height);
    // Kept on the card's edge, between its corners: a narrower card may no longer reach it.
    const edge = SIDE_PADDING / 2 + PILL_W / 2;
    const anchor = {
      x: clamp(d.anchor.x + rect.x + width / 2 - (o.x + o.width / 2), rect.x + edge, rect.x + width - edge),
      y: d.anchor.y + (this.down ? rect.y - o.y : rect.y + height - (o.y + o.height)),
    };
    this.apply({ rect, anchor, down: this.down });
  }

  /** The size the card has while its corner is dragged, before it is saved. */
  private sizeNow: { cardWidth: number; lines: number } | null = null;

  dragEnd(): void {
    const d = this.drag0;
    if (!d) return;
    this.drag0 = null;
    if (d.mode === "resize") {
      this.resize(d);
      this.stopMotion();
      const size = this.sizeNow!;
      this.sizeNow = null;
      // Home stays home, unless the card had to move off it (or was caught gliding).
      const moved = d.gliding || Math.hypot(this.anchor.x - d.anchor.x, this.anchor.y - d.anchor.y) >= 1;
      const anchor = this.placement().anchor === null && !moved ? null : { x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) };
      this.savePlacement({ anchor, ...size });
      this.check();
      return;
    }
    // Let go: on from where it is (not past a wall), at the speed it had.
    const { x, y } = this.anchor;
    this.spring.x = x;
    this.spring.y = y;
    const speed = Math.hypot(this.spring.vx, this.spring.vy);
    const k = speed > THROW_SPEED ? (THROW_S * Math.min(speed, THROW_MAX_SPEED)) / speed : 0;
    const thrown = { x: x + this.spring.vx * k, y: y + this.spring.vy * k };
    const to = this.busy ? this.layout(thrown, this.size(), d.glue).anchor : this.rest(thrown);
    this.glide(to ?? this.home());
    this.glideTo = to;
  }

  /** Where a pill let go of at `p` comes to rest: on the screen, against an edge it is near; null = home. */
  private rest(p: Point): Point | null {
    const area = screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) }).workArea;
    const home = this.homeOn(area);
    if (Math.hypot(p.x - home.x, p.y - home.y) < HOME_SNAP) return null;
    const snap = (v: number, lo: number, hi: number) => {
      const c = clamp(v, lo, hi);
      return c - lo < EDGE_SNAP ? lo : hi - c < EDGE_SNAP ? hi : c;
    };
    return {
      x: snap(p.x, area.x + PILL_W / 2 + EDGE_INSET, area.x + area.width - PILL_W / 2 - EDGE_INSET),
      y: snap(p.y, area.y + PILL_H / 2 + EDGE_INSET, area.y + area.height - PILL_H / 2 - EDGE_INSET),
    };
  }

  private glide(to: Point): void {
    this.spring.stiffness = GLIDE_STIFFNESS;
    this.spring.toX = to.x;
    this.spring.toY = to.y;
    this.startMotion();
  }

  /** A glide came to rest: the spot is saved (null: home). */
  private settled(): void {
    this.stopMotion();
    if (this.busy) this.sideByScreen();
    const to = this.glideTo;
    this.glideTo = undefined;
    const { cardWidth, lines } = this.size();
    this.savePlacement({ anchor: to === null ? null : { x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) }, cardWidth, lines });
    this.check();
    console.log("overlay moved to", JSON.stringify(this.win.getBounds()));
  }

  /**
   * A card put down in the upper half of the screen opens downwards from then on, one in the lower half
   * upwards: the pill goes to that edge of it, so the card folds into it there and opens there again.
   * The card stays where it is on the screen.
   */
  private sideByScreen(): void {
    if (!this.region.length) return;
    const b = this.win.getBounds();
    const d = this.region.reduce(union);
    const top = b.y + d.y;
    const bottom = top + d.height;
    const area = screen.getDisplayNearestPoint({ x: Math.round(this.anchor.x), y: Math.round(this.anchor.y) }).workArea;
    const down = (top + bottom) / 2 < area.y + area.height / 2;
    if (down === this.down) return;
    const y = down ? top - CARD_BOTTOM : bottom + CARD_BOTTOM - b.height;
    this.apply({ rect: { ...b, y }, anchor: { x: this.anchor.x, y: down ? top + PILL_H / 2 : bottom - PILL_H / 2 }, down });
  }

  /** Back to bottom-centre at the default size: it glides there. */
  resetPlacement(): void {
    this.drag0 = null;
    this.sizeNow = null;
    this.savePlacement({ anchor: null, cardWidth: DEFAULT_CARD_WIDTH, lines: 6 });
    if (this.busy) {
      // A card turns to open upwards, as it does at home, with the pill in the middle of its bottom edge.
      const b = this.win.getBounds();
      const { cardWidth, lines } = this.size();
      const glue = { x: (cardWidth + SIDE_PADDING) / 2, y: CHROME_HEIGHT + lines * LINE - PILL_H / 2 - CARD_BOTTOM };
      this.down = false;
      this.anchor = { x: b.x + glue.x, y: b.y + glue.y };
    }
    // From where it is now (mid-glide too, at the speed it has).
    if (!this.motion) this.spring.reset(this.anchor.x, this.anchor.y);
    this.spring.x = this.anchor.x;
    this.spring.y = this.anchor.y;
    this.apply(this.layout(this.anchor, this.size(), this.busy ? this.glued() : null));
    this.glideTo = null;
    // Home has room for the default card above the pill (the drawn region may still be the old size's).
    this.glide(this.home());
  }

  // ── OverlayPort ─────────────────────────────────────────────────────────

  state(s: OverlayState): void {
    // When the check showed, so ciao.log can say how long the card stayed after it.
    // A card still up when the next one comes (the pointer kept it) is never reported hidden: it ends here.
    for (const [seq, done] of this.doneAt) {
      if (seq === s.seq) continue;
      console.log("overlay: card", seq, done.t3 ? "(T3)" : "", "still up", `${Date.now() - done.at}ms`, "after its check when card", s.seq, "took its place");
      this.doneAt.delete(seq);
    }
    if (s.phase === "done" && !s.keep && !this.doneAt.has(s.seq)) this.doneAt.set(s.seq, { at: Date.now(), t3: !!s.t3 });
    if (this.visibleSeq !== s.seq) {
      // Without a saved spot the card comes up on the display you're working on; while the pill is
      // shown it unfolds where the pill is.
      if (!this.pill || !this.win.isVisible()) this.place();
      this.win.showInactive();
      this.raise(s.seq);
      this.visibleSeq = s.seq;
    }
    this.win.webContents.send("overlay:state", s);
  }

  /** Windows: the card for `seq` comes up over the other windows; ciao.log says what was in its way. */
  private raise(seq: number): void {
    if (process.platform !== "win32") return;
    const hidden = hiddenBy(this.win);
    if (hidden) console.warn("overlay: card", seq, "came up", hidden);
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.moveTop();
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
    this.capturing = seq;
    this.win.webContents.send("capture:start", seq);
  }

  sound(kind: "start" | "stop"): void {
    this.win.webContents.send("overlay:sound", kind);
  }

  stopCapture(seq: number): void {
    if (this.capturing === seq) this.capturing = null;
    this.win.webContents.send("capture:stop", seq);
  }

  suggest(s: TermSuggestion): void {
    if (!this.win.isVisible()) {
      this.place();
      this.win.showInactive();
    }
    this.win.webContents.send("overlay:suggest", s);
  }

  /** What the renderer draws, as one box in window pixels; null if nothing. */
  private drawn(): Rectangle | null {
    return this.region.length ? this.region.reduce(union) : null;
  }

  /** The saved card size, or the one its corner is being dragged to. */
  private size(): { cardWidth: number; lines: number } {
    const { cardWidth, lines } = this.sizeNow ?? this.placement();
    return { cardWidth: clamp(cardWidth, MIN_CARD_WIDTH, MAX_CARD_WIDTH), lines: clamp(lines, MIN_LINES, MAX_LINES) };
  }

  /** The pill at home: bottom-centre of the work area under the cursor. */
  private home(): Point {
    return this.homeOn(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
  }

  private homeOn(area: Rectangle): Point {
    return { x: area.x + area.width / 2, y: area.y + area.height - SCREEN_GAP - CARD_BOTTOM - PILL_H / 2 };
  }

  /**
   * The saved spot, while it is still on or next to some screen (monitors come and go; a pill dropped on
   * the taskbar is just past the work area); otherwise home.
   */
  private saved(): Point {
    const { anchor } = this.placement();
    if (anchor) {
      const near = screen.getDisplayNearestPoint(anchor).bounds;
      if (contains({ x: near.x - 200, y: near.y - 200, width: near.width + 400, height: near.height + 400 }, anchor)) return anchor;
    }
    return this.home();
  }

  /**
   * The window for the pill at `a`: the pill on its screen, the card opening up from it (down where
   * there is no room above) and all of it on the screen (its transparent margin may stick out). A card
   * that is up keeps its side; `glue` (where the pill is in the window) moves the pill with the card, which
   * stops at the screen's edges.
   */
  private layout(a: Point, size: { cardWidth: number; lines: number }, glue: Point | null = null): Layout {
    const width = size.cardWidth + SIDE_PADDING;
    const height = CHROME_HEIGHT + size.lines * LINE;
    const area = screen.getDisplayNearestPoint({ x: Math.round(a.x), y: Math.round(a.y) }).workArea;
    const fit = (x: number, y: number) => fitRect(area, x, y, width, height);
    if (glue) {
      // What stops at the screen's edges is the card as drawn: the window is sized for the most lines, and
      // the empty part of it may go off the screen.
      const d = this.drawn();
      const rect = d ? fitDrawn(area, a.x - glue.x, a.y - glue.y, d, width, height) : fit(a.x - glue.x, a.y - glue.y);
      // The pill stays over what is drawn: a suggestion is narrower than the window.
      const x = d ? clamp(rect.x + glue.x, rect.x + d.x + PILL_W / 2, rect.x + d.x + d.width - PILL_W / 2) : rect.x + glue.x;
      return { rect, anchor: { x, y: rect.y + glue.y }, down: this.down };
    }
    const anchor = {
      x: clamp(a.x, area.x + PILL_W / 2, area.x + area.width - PILL_W / 2),
      y: clamp(a.y, area.y + PILL_H / 2, area.y + area.height - PILL_H / 2),
    };
    const upTop = anchor.y + PILL_H / 2 + CARD_BOTTOM - height;
    // A card on screen keeps its side; the pill alone takes the one with room (the roomier one if neither has).
    const down = this.busy ? this.down : upTop < area.y - CARD_BOTTOM && area.y + area.height - anchor.y > anchor.y - area.y;
    return { rect: fit(anchor.x - width / 2, down ? anchor.y - PILL_H / 2 - CARD_BOTTOM : upTop), anchor, down };
  }

  /** Moves the window there, and tells the renderer where in it the pill is if that changed. */
  private apply(l: Layout): void {
    const b = this.win.getBounds();
    const r = l.rect;
    this.anchor = l.anchor;
    if (r.x !== b.x || r.y !== b.y || r.width !== b.width || r.height !== b.height) {
      this.win.setBounds(r);
      // The system may keep a window from going where it was put (macOS, above the menu bar): the pill
      // stays where it is in the window.
      const got = this.win.getBounds();
      this.anchor = { x: l.anchor.x + got.x - r.x, y: l.anchor.y + got.y - r.y };
    }
    this.down = l.down;
    this.tell();
  }

  private tell(): void {
    const b = this.win.getBounds();
    const at = { x: Math.round(this.anchor.x - b.x), y: Math.round(this.anchor.y - b.y), down: this.down };
    const key = JSON.stringify(at);
    if (key === this.told) return;
    this.told = key;
    this.win.webContents.send("overlay:anchor", at);
  }

  /** At the saved spot and size, at once. */
  private place(): void {
    if (this.drag0 || this.motion) return;
    this.apply(this.layout(this.saved(), this.size()));
    this.check();
  }
}

/** A window of this size at (x, y), moved onto `area` (its transparent margin may stick out). */
function fitRect(area: Rectangle, x: number, y: number, width: number, height: number): Rectangle {
  return {
    x: Math.round(clamp(x, area.x - SIDE_PADDING / 2, area.x + area.width - width + SIDE_PADDING / 2)),
    y: Math.round(clamp(y, area.y - CARD_BOTTOM, area.y + area.height - height + CARD_BOTTOM)),
    width,
    height,
  };
}

/** A window of this size at (x, y), moved so that `d` (what is drawn in it, in window pixels) is on `area`. */
function fitDrawn(area: Rectangle, x: number, y: number, d: Rectangle, width: number, height: number): Rectangle {
  return {
    x: Math.round(clamp(x, area.x - d.x, area.x + area.width - d.x - d.width)),
    y: Math.round(clamp(y, area.y - d.y, area.y + area.height - d.y - d.height)),
    width,
    height,
  };
}

function union(a: Rectangle, b: Rectangle): Rectangle {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

function contains(a: Rectangle, p: { x: number; y: number }): boolean {
  return p.x >= a.x && p.x <= a.x + a.width && p.y >= a.y && p.y <= a.y + a.height;
}

interface Koffi {
  struct(name: string, fields: Record<string, string>): unknown;
  load(file: string): { func(signature: string): (...args: any[]) => any };
}

/** Windows: koffi, from the wake word's folder. */
function loadKoffi(): Koffi {
  return require(path.join(WakeWord.dir(), "koffi")) as Koffi;
}

/** Windows: the number of the "Lanes.ScreenPicture" message (the same in every process); null without koffi. */
function screenPictureMessage(): number | null {
  try {
    return loadKoffi().load("user32.dll").func("unsigned int __stdcall RegisterWindowMessageW(const char16_t *name)")("Lanes.ScreenPicture") || null;
  } catch (e) {
    console.warn("overlay: no screen-picture message:", e);
    return null;
  }
}

let windowCalls: ReturnType<typeof loadWindowCalls> | null | undefined;

function loadWindowCalls() {
  const koffi = loadKoffi();
  const user32 = koffi.load("user32.dll");
  koffi.struct("CiaoRect", { left: "long", top: "long", right: "long", bottom: "long" });
  return {
    next: user32.func("intptr_t __stdcall GetWindow(intptr_t hwnd, uint32_t cmd)"),
    visible: user32.func("bool __stdcall IsWindowVisible(intptr_t hwnd)"),
    rect: user32.func("bool __stdcall GetWindowRect(intptr_t hwnd, _Out_ CiaoRect *rect)"),
    process: user32.func("uint32_t __stdcall GetWindowThreadProcessId(intptr_t hwnd, _Out_ uint32_t *pid)"),
    className: user32.func("int __stdcall GetClassNameW(intptr_t hwnd, _Out_ uint16_t *name, int max)"),
    attribute: koffi.load("dwmapi.dll").func("long __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t attr, _Out_ int *value, uint32_t size)"),
  };
}

/**
 * Windows: what keeps `win` from being seen, for ciao.log: "cloaked" (Windows hides it), or the windows
 * of other programs that lie over it (class, process id, place and size); "" if nothing does.
 */
function hiddenBy(win: BrowserWindow): string {
  try {
    if (windowCalls === undefined) windowCalls = loadWindowCalls();
  } catch (e) {
    console.warn("overlay: can't tell what covers it:", e);
    windowCalls = null;
  }
  const w = windowCalls;
  if (!w) return "";
  type Box = { left: number; top: number; right: number; bottom: number };
  const cloaked = (h: number) => {
    const v = [0];
    return w.attribute(h, 14 /* DWMWA_CLOAKED */, v, 4) === 0 && v[0] !== 0;
  };
  const me = Number(win.getNativeWindowHandle().readBigInt64LE(0));
  if (cloaked(me)) return "cloaked";
  const mine = {} as Box;
  w.rect(me, mine);
  const over: string[] = [];
  // Front to back from this window: GW_HWNDPREV.
  for (let h = w.next(me, 3), n = 0; h && n < 1000 && over.length < 5; h = w.next(h, 3), n++) {
    if (!w.visible(h) || cloaked(h)) continue;
    const r = {} as Box;
    const pid = [0];
    w.process(h, pid);
    if (pid[0] === process.pid || !w.rect(h, r) || r.right <= mine.left || r.left >= mine.right || r.bottom <= mine.top || r.top >= mine.bottom) continue;
    const name = new Uint16Array(80);
    over.push(`${String.fromCharCode(...name.subarray(0, w.className(h, name, 80)))} (process ${pid[0]}) ${r.left},${r.top} ${r.right - r.left}x${r.bottom - r.top}`);
  }
  return over.length ? `under ${over.join("; ")}` : "";
}
