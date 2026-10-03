// The active window and Ctrl+V on X11, through libX11 and libXtst called with koffi (no compiling).
// Both libraries come with every X11 desktop; Electron itself needs them.
import fs from "node:fs";
import path from "node:path";

type Fn = (...args: unknown[]) => unknown;
interface Koffi {
  load(file: string): { func(signature: string): Fn };
  proto(signature: string): unknown;
  pointer(type: unknown): unknown;
  register(fn: Fn, type: unknown): unknown;
  decode(ptr: unknown, type: string, len?: number): unknown;
}

// X keysyms (X11/keysymdef.h).
const XK_Control_L = 0xffe3;
const XK_Shift_L = 0xffe1;
const XK_v = 0x0076;

export interface WindowInfo {
  id: number;
  title: string;
  process: string;
}

export class X11 {
  private readonly display: unknown;
  private readonly root: number;
  private readonly atoms = new Map<string, number>();
  private readonly f: Record<string, Fn>;

  private constructor(private readonly koffi: Koffi, display: unknown, f: Record<string, Fn>) {
    this.display = display;
    this.f = f;
    this.root = Number(f.XDefaultRootWindow!(display));
  }

  /** null when there is no X server to talk to. */
  static open(koffi: Koffi): X11 | null {
    if (!process.env.DISPLAY) return null;
    const x = koffi.load("libX11.so.6");
    const xtst = koffi.load("libXtst.so.6");
    const f: Record<string, Fn> = {
      XOpenDisplay: x.func("void *XOpenDisplay(const char *)"),
      XDefaultRootWindow: x.func("unsigned long XDefaultRootWindow(void *)"),
      XInternAtom: x.func("unsigned long XInternAtom(void *, const char *, int)"),
      XGetWindowProperty: x.func(
        "int XGetWindowProperty(void *, unsigned long, unsigned long, long, long, int, unsigned long, _Out_ unsigned long *, _Out_ int *, _Out_ unsigned long *, _Out_ unsigned long *, _Out_ void **)",
      ),
      XFree: x.func("int XFree(void *)"),
      XKeysymToKeycode: x.func("uint8_t XKeysymToKeycode(void *, unsigned long)"),
      XSync: x.func("int XSync(void *, int)"),
      XSetErrorHandler: x.func("void *XSetErrorHandler(void *)"),
      XTestFakeKeyEvent: xtst.func("int XTestFakeKeyEvent(void *, unsigned int, int, unsigned long)"),
    };
    // The default handler exits the process on any error, e.g. asking about a window that just closed.
    const handler = koffi.proto("int XErrorHandler(void *, void *)");
    f.XSetErrorHandler!(koffi.register(() => 0, koffi.pointer(handler)));
    const display = f.XOpenDisplay!(null);
    if (!display) return null;
    return new X11(koffi, display, f);
  }

  private atom(name: string): number {
    let a = this.atoms.get(name);
    if (a === undefined) this.atoms.set(name, (a = Number(this.f.XInternAtom!(this.display, name, 0))));
    return a;
  }

  /** A property of `window`: the numbers in it (format 32) or its text (format 8); null if it has none. */
  private property(window: number, name: string): number[] | string | null {
    const type = [0];
    const format = [0];
    const count = [0];
    const after = [0];
    const data: unknown[] = [null];
    // AnyPropertyType = 0; up to 1 MB.
    const status = this.f.XGetWindowProperty!(this.display, window, this.atom(name), 0, 1 << 18, 0, 0, type, format, count, after, data);
    if (status !== 0 || !data[0]) return null;
    try {
      const n = Number(count[0]);
      if (format[0] === 32) return (this.koffi.decode(data[0], "unsigned long", n) as (number | bigint)[]).map(Number); // longs on the client side
      if (format[0] === 8) return Buffer.from(this.koffi.decode(data[0], "uint8_t", n) as number[]).toString("utf8");
      return null;
    } finally {
      this.f.XFree!(data[0]);
    }
  }

  private number(window: number, name: string): number | null {
    const v = this.property(window, name);
    return Array.isArray(v) && v.length ? v[0]! : null;
  }

  activeWindow(): number {
    return this.number(this.root, "_NET_ACTIVE_WINDOW") ?? 0;
  }

  describe(window: number): WindowInfo {
    const title = this.property(window, "_NET_WM_NAME") ?? this.property(window, "WM_NAME");
    const pid = this.number(window, "_NET_WM_PID");
    return { id: window, title: typeof title === "string" ? title : "", process: pid ? processName(pid) : "" };
  }

  /** The window is still open (the window manager lists it). */
  exists(window: number): boolean {
    const list = this.property(this.root, "_NET_CLIENT_LIST");
    return Array.isArray(list) && list.includes(window);
  }

  /** undefined when the window manager doesn't say. */
  onCurrentDesktop(window: number): boolean | undefined {
    const current = this.number(this.root, "_NET_CURRENT_DESKTOP");
    const desktop = this.number(window, "_NET_WM_DESKTOP");
    if (current === null || desktop === null) return undefined;
    return desktop === current || desktop === 0xffffffff; // sticky: on every desktop
  }

  /** Ctrl+V, or Ctrl+Shift+V (terminals). */
  paste(shift: boolean): void {
    const code = (keysym: number) => this.f.XKeysymToKeycode!(this.display, keysym);
    const keys = [code(XK_Control_L), ...(shift ? [code(XK_Shift_L)] : []), code(XK_v)];
    for (const k of keys) this.f.XTestFakeKeyEvent!(this.display, k, 1, 0);
    for (const k of keys.reverse()) this.f.XTestFakeKeyEvent!(this.display, k, 0, 0);
    this.f.XSync!(this.display, 0);
  }
}

/** The executable's name, like the process name on Windows: "code", "kitty", "firefox". */
function processName(pid: number): string {
  try {
    return path.basename(fs.readlinkSync(`/proc/${pid}/exe`));
  } catch {
    try {
      return fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim();
    } catch {
      return "";
    }
  }
}
