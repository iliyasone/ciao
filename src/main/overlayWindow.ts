import path from "node:path";
import { BrowserWindow, screen } from "electron";
import type { OverlayState } from "../core/types";
import type { OverlayPort } from "./dictation";

// Fixed-size transparent window; the card inside grows smoothly and the empty
// area is click-through. Never focusable, so the app you dictate into stays active.
const WIDTH = 720;
const HEIGHT = 320;
const BOTTOM_GAP = 28;

export class OverlayWindow implements OverlayPort {
  readonly win: BrowserWindow;
  private visibleSeq = -1;

  constructor(preload: string, rendererDir: string) {
    this.win = new BrowserWindow({
      width: WIDTH,
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
      backgroundColor: "#00000000",
      webPreferences: {
        preload,
        backgroundThrottling: false, // the mic is captured here even while hidden
        autoplayPolicy: "no-user-gesture-required",
      },
    });
    this.win.setAlwaysOnTop(true, "screen-saver");
    this.win.setIgnoreMouseEvents(true, { forward: true });
    void this.win.loadFile(path.join(rendererDir, "overlay.html"));
  }

  /** The card was hovered/left: let wheel scrolling through only while over it. */
  setInteractive(on: boolean): void {
    this.win.setIgnoreMouseEvents(!on, { forward: true });
  }

  /** The renderer finished its fade-out for this dictation. */
  hidden(seq: number): void {
    if (seq === this.visibleSeq) {
      this.win.hide();
      this.visibleSeq = -1;
    }
  }

  state(s: OverlayState): void {
    if (this.visibleSeq !== s.seq) {
      this.place();
      this.win.showInactive();
      this.visibleSeq = s.seq;
    }
    this.win.webContents.send("overlay:state", s);
  }

  delta(seq: number, text: string): void {
    this.win.webContents.send("overlay:delta", seq, text);
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
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    this.win.setBounds({
      x: Math.round(area.x + (area.width - WIDTH) / 2),
      y: Math.round(area.y + area.height - HEIGHT - BOTTOM_GAP),
      width: WIDTH,
      height: HEIGHT,
    });
  }
}
