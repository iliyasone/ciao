import path from "node:path";
import { BrowserWindow, screen, type Rectangle } from "electron";
import type { OverlayState } from "../core/types";
import type { OverlayPort } from "./dictation";

// Transparent window a bit larger than the card (room for its shadow); the card grows
// smoothly inside and the empty area is click-through. Never focusable, so the app you
// dictate into stays active. It sits bottom-centre until the user drags it by the grip;
// the chosen position and width are then remembered.
const HEIGHT = 320;
const SIDE_PADDING = 80; // card width + this = window width
const BOTTOM_GAP = 28;
export const DEFAULT_CARD_WIDTH = 640;
const MIN_CARD_WIDTH = 420;
const MAX_CARD_WIDTH = 1200;

export interface OverlayPlacement {
  /** Window top-left; null = bottom-centre of the display under the cursor. */
  position: { x: number; y: number } | null;
  cardWidth: number;
}

export class OverlayWindow implements OverlayPort {
  readonly win: BrowserWindow;
  private visibleSeq = -1;
  private dragOrigin: Rectangle | null = null;
  private wake = false;

  constructor(
    preload: string,
    rendererDir: string,
    private readonly placement: () => OverlayPlacement,
    private readonly savePlacement: (p: OverlayPlacement) => void,
  ) {
    this.win = new BrowserWindow({
      width: DEFAULT_CARD_WIDTH + SIDE_PADDING,
      height: HEIGHT,
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
    this.win.setIgnoreMouseEvents(true, { forward: true });
    void this.win.loadFile(path.join(rendererDir, "overlay.html"));
    this.win.webContents.on("did-finish-load", () => this.win.webContents.send("wake:enable", this.wake));
  }

  /** Keep the mic open for the wake-word detector (or not). */
  setWake(on: boolean): void {
    this.wake = on;
    if (!this.win.webContents.isLoading()) this.win.webContents.send("wake:enable", on);
  }

  /** The card was hovered/left: let clicks and wheel scrolling through only while over it. */
  setInteractive(on: boolean): void {
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  /** The renderer finished its fade-out for this card. */
  hidden(seq: number): void {
    if (seq === this.visibleSeq) {
      this.win.hide();
      this.visibleSeq = -1;
    }
  }

  // ── Moving and resizing by the grip ─────────────────────────────────────

  dragStart(): void {
    this.dragOrigin = this.win.getBounds();
  }

  /** dx/dy: pointer offset since dragStart; mode "move" shifts the window, "resize" widens it. */
  drag(mode: "move" | "resize", dx: number, dy: number): void {
    const o = this.dragOrigin;
    if (!o) return;
    if (mode === "move") {
      this.win.setBounds({ ...o, x: Math.round(o.x + dx), y: Math.round(o.y + dy) });
    } else {
      // Grow symmetrically so the card stays centred on the same spot.
      const card = Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, o.width - SIDE_PADDING + 2 * dx));
      const width = card + SIDE_PADDING;
      this.win.setBounds({ x: Math.round(o.x + (o.width - width) / 2), y: o.y, width, height: HEIGHT });
    }
  }

  dragEnd(): void {
    if (!this.dragOrigin) return;
    this.dragOrigin = null;
    const b = this.win.getBounds();
    console.log("overlay moved to", JSON.stringify(b));
    this.savePlacement({ position: { x: b.x, y: b.y }, cardWidth: b.width - SIDE_PADDING });
  }

  /** Back to bottom-centre at the default width. */
  resetPlacement(): void {
    this.dragOrigin = null;
    this.savePlacement({ position: null, cardWidth: DEFAULT_CARD_WIDTH });
    this.place();
  }

  // ── OverlayPort ─────────────────────────────────────────────────────────

  state(s: OverlayState): void {
    if (this.visibleSeq !== s.seq) {
      this.place();
      this.win.showInactive();
      this.visibleSeq = s.seq;
    }
    this.win.webContents.send("overlay:state", s);
  }

  delta(seq: number, text: string, gapMs: number): void {
    this.win.webContents.send("overlay:delta", seq, text, gapMs);
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

  private place(): void {
    const { position, cardWidth } = this.placement();
    const width = Math.min(MAX_CARD_WIDTH, Math.max(MIN_CARD_WIDTH, cardWidth)) + SIDE_PADDING;
    // A saved spot is used only while it is still on some screen (monitors come and go).
    if (position) {
      const onScreen = screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return position.x + width / 2 >= a.x && position.x + width / 2 <= a.x + a.width && position.y + HEIGHT / 2 >= a.y && position.y + HEIGHT / 2 <= a.y + a.height;
      });
      if (onScreen) {
        this.win.setBounds({ ...position, width, height: HEIGHT });
        return;
      }
    }
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + area.height - HEIGHT - BOTTOM_GAP),
      width,
      height: HEIGHT,
    });
  }
}
