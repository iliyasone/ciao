// Linux input bridge for the Electron app: the same protocol as native/win-input (see Program.cs
// there), one JSON object per line over stdin/stdout. Run by Electron as plain Node
// (ELECTRON_RUN_AS_NODE) with "--koffi DIR" and one "--trigger SPEC" per dictation trigger.
//
// What differs from Windows:
// - Keys and buttons come from /dev/input (evdev), so the user must be in the "input" group.
//   They are never swallowed: the focused app sees the trigger, Esc and captured keys too
//   (the main process grabs Esc on X11 while armed, see src/main/input.ts).
// - The active window, and the check that it is still in front before pasting, need X11. On a
//   Wayland desktop "foreground" reports id 0 and the paste goes to whatever is in front.
// - Ctrl+V is typed with XTest on X11 and with a uinput virtual keyboard on Wayland.
// - "field" reads through AT-SPI (atspi.ts): "unsupported" without an accessibility bus. The app in
//   front is the one owning the active X11 window, or on Wayland the one whose window says it is
//   active. Chromium and Electron apps show their fields only with accessibility turned on for
//   the desktop (GNOME: toolkit-accessibility, or a screen reader running); otherwise "no-field".
// - "key" events: since keys come from evdev, the app gets them at the same time, so the text read
//   on Enter may already be gone (null). "paste" goes by the key's position (where QWERTY has V).
//   On Wayland the watched window has no id, so Enter reads nothing, and "field" sticks with the app
//   its first read in a watch found in front: in any other app it answers "focus-changed".
// - AT-SPI calls are synchronous: a read holds up the helper's other work for up to about a second.
//
// Extra event: {"type":"status","reading":N,"denied":M} after every device scan.
import readline from "node:readline";
import { Atspi, type FieldResult } from "./atspi";
import { Devices } from "./evdev";
import { isLoneModifier, isModifier, KEY_ESC, keyName, modifierPrefix, modifiersMatch, modifiersOf, MOUSE_BUTTONS, parseTrigger, type Modifiers, type Trigger } from "./keys";
import { DEVICE_NAME, Uinput } from "./uinput";
import { X11 } from "./x11";

const args = process.argv.slice(2);
const argValues = (name: string) => args.flatMap((a, i) => (a === name && i + 1 < args.length ? [args[i + 1]!] : []));

const emit = (o: Record<string, unknown>): void => void process.stdout.write(`${JSON.stringify(o)}\n`);
const log = (message: string) => emit({ type: "log", message });

let triggers: Trigger[] = [];
let armed = false;
let capturing = false;
const held = new Set<number>();
const captureMods = new Set<number>();
let loneModifier: number | null = null;
let watching = false;
/** The window whose field Enter reads while watching (0: none). */
let watchWindow = 0;

function setTriggers(specs: string[]): void {
  triggers = [];
  for (const spec of specs) {
    const t = parseTrigger(spec);
    if (t) triggers.push(t);
    else log(`bad trigger: ${spec}`);
  }
}

function onKey(code: number, value: number): void {
  if (value === 2) return; // auto-repeat
  const down = value === 1;
  const mouse = MOUSE_BUTTONS[code];
  if (mouse) return onMouse(mouse, down);
  if (down) held.add(code);
  else held.delete(code);
  if (capturing) return captureKey(code, down);

  const mods = modifiersOf(held);
  for (const t of triggers) {
    if (t.key !== code) continue;
    if (down && !t.active && modifiersMatch(t, mods)) {
      t.active = true;
      emit({ type: "trigger", down: true, spec: t.spec });
    } else if (!down && t.active) {
      t.active = false;
      emit({ type: "trigger", down: false, spec: t.spec });
    }
  }
  if (!down || triggers.some((t) => t.key === code)) return;
  if (armed && code === KEY_ESC) return emit({ type: "escape" });
  if (watching && !isModifier(code)) reportKey(code, mods);
  if (triggers.some((t) => t.active && isLoneModifier(t) && t.key !== code)) emit({ type: "other" });
}

// evdev codes are positions: Ctrl+V is the key where QWERTY has V, so it holds in the Russian layout too.
const KEY_V = 47;
const KEY_INSERT = 110;
const KEY_ENTER = 28;
const KEY_KPENTER = 96;

/** While watching: what kind of key the user pressed, so src/main/corrections.ts knows they are editing. */
function reportKey(code: number, m: Modifiers): void {
  if (code === KEY_ENTER || code === KEY_KPENTER) {
    // The app gets the Enter at the same time as we do and a chat app sends and clears the field on
    // it, so this read races it: kept short, and null when it lost.
    // Only the watched window's field: Enter in any other app is none of Ciao's business.
    const text = watchWindow !== 0 ? readField(watchWindow, 150).text : null;
    return emit({ type: "key", kind: "enter", text });
  }
  const paste = (code === KEY_V && m.ctrl && !m.alt && !m.win) || (code === KEY_INSERT && m.shift && !m.ctrl && !m.alt && !m.win);
  emit({ type: "key", kind: paste ? "paste" : "other" });
}

function onMouse(button: string, down: boolean): void {
  if (capturing) {
    if (down) endCapture(modifierPrefix(modifiersOf(captureMods)) + button);
    return;
  }
  const mods = modifiersOf(held);
  for (const t of triggers) {
    if (t.mouse !== button) continue;
    if (down && !t.active && modifiersMatch(t, mods)) {
      t.active = true;
      emit({ type: "trigger", down: true, spec: t.spec });
    } else if (!down && t.active) {
      t.active = false;
      emit({ type: "trigger", down: false, spec: t.spec });
    }
  }
}

/**
 * A modifier pressed and released alone becomes a lone-modifier trigger ("RControlKey");
 * otherwise the first other key or mouse button, with the modifiers held, does. Esc alone cancels.
 */
function captureKey(code: number, down: boolean): void {
  if (isModifier(code)) {
    if (down) {
      captureMods.add(code);
      loneModifier ??= code;
    } else {
      captureMods.delete(code);
      if (loneModifier === code) endCapture(keyName(code) ?? null);
    }
    return;
  }
  if (!down) return;
  if (code === KEY_ESC && captureMods.size === 0) return endCapture(null);
  const name = keyName(code);
  if (name) endCapture(modifierPrefix(modifiersOf(captureMods)) + name);
}

function startCapture(): void {
  captureMods.clear();
  loneModifier = null;
  capturing = true;
}

function endCapture(spec: string | null): void {
  capturing = false;
  captureMods.clear();
  loneModifier = null;
  emit({ type: "captured", spec });
}

// ── Windows and Ctrl+V ────────────────────────────────────────────────────

const koffi = require(argValues("--koffi")[0] ?? "koffi");
const wayland = process.env.XDG_SESSION_TYPE === "wayland" || (!!process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== "x11");
let x11: X11 | null = null;
try {
  x11 = X11.open(koffi);
} catch (e) {
  log(`X11 unavailable: ${(e as Error).message}`);
}
// On Wayland, XTest only reaches X11 apps, so the paste goes through a virtual keyboard.
const uinput = wayland || !x11 ? Uinput.open(koffi) : null;
if (wayland && !uinput) log("no write access to /dev/uinput: dictations stay on the clipboard");

// ── The focused field ─────────────────────────────────────────────────────

let atspi: Atspi | null | undefined; // connected on the first read, so a user who never needs it never connects
/** Wayland: the app the first read of this watch found in front; a read in another app is "focus-changed". */
let watchApp: number | null = null;

/** See "field" in Program.cs; `budget` in ms. */
function readField(hwnd: number, budget: number): FieldResult | { text: null; reason: "focus-changed" } {
  let pid: number | null = null;
  if (!wayland && x11) {
    const front = x11.activeWindow();
    if (hwnd !== 0 && front !== hwnd) return { text: null, reason: "focus-changed" };
    pid = x11.pid(front);
  }
  connectAtspi();
  if (!atspi) return { text: null, reason: "unsupported" };
  let r: FieldResult;
  try {
    r = atspi.focusedText(pid, budget);
  } catch (e) {
    // Not one of the expected misses (a decoding error, say): answer rather than die.
    log(`reading the field: ${(e as Error).message}`);
    return { text: null, reason: "no-field" };
  }
  // Wayland names no window: stay with the app the watch began in, never read on in another one.
  if (wayland && watching) {
    watchApp ??= atspi.appPid;
    if (atspi.appPid !== watchApp) return { text: null, reason: "focus-changed" };
  }
  return r;
}

/** Connects once, at the first watch or read: an Enter read can't wait for the accessibility bus. */
function connectAtspi(): void {
  if (atspi === undefined) {
    try {
      atspi = Atspi.open(koffi);
      if (!atspi) log("no accessibility bus: Ciao can't read text fields");
    } catch (e) {
      atspi = null;
      log(`AT-SPI unavailable: ${(e as Error).message}`);
    }
  }
}

// Terminals paste with Ctrl+Shift+V; Ctrl+V there is a control character.
const TERMINALS = new Set([
  "gnome-terminal-server", "kgx", "ptyxis", "konsole", "yakuake", "kitty", "alacritty", "wezterm-gui", "foot", "ghostty",
  "tilix", "terminator", "xfce4-terminal", "mate-terminal", "lxterminal", "qterminal", "terminology", "guake", "tilda",
  "xterm", "uxterm", "urxvt", "st", "blackbox",
]);

function handle(msg: Record<string, unknown>): void {
  const id = msg.id;
  switch (msg.cmd) {
    case "foreground": {
      if (wayland || !x11) return emit({ id, hwnd: 0, title: "", process: "" });
      const w = x11.describe(x11.activeWindow());
      return emit({ id, hwnd: w.id, title: w.title, process: w.process });
    }
    case "paste": {
      const wanted = typeof msg.hwnd === "number" ? msg.hwnd : 0;
      if (!wayland && x11) {
        const front = x11.activeWindow();
        if (wanted !== 0 && front !== wanted) {
          const f = x11.describe(front);
          return emit({
            id, ok: false, reason: "focus-changed", foreground: f.title, foregroundProcess: f.process,
            targetExists: x11.exists(wanted), targetOnCurrentDesktop: x11.onCurrentDesktop(wanted) ?? null,
          });
        }
        x11.paste(TERMINALS.has(x11.describe(front).process));
        return emit({ id, ok: true });
      }
      if (!uinput) return emit({ id, ok: false, reason: "no-injector" });
      uinput.paste(false);
      return emit({ id, ok: true });
    }
    case "arm":
      armed = msg.on === true;
      return;
    case "triggers":
      setTriggers(Array.isArray(msg.list) ? msg.list.map(String) : []);
      return;
    case "capture":
      if (msg.on === true) startCapture();
      else capturing = false;
      return;
    case "field":
      return emit({ id, ...readField(typeof msg.hwnd === "number" ? msg.hwnd : 0, 700) });
    case "watch":
      watching = msg.on === true;
      watchWindow = typeof msg.hwnd === "number" ? msg.hwnd : 0;
      watchApp = null;
      if (watching) connectAtspi();
      return;
  }
}

setTriggers(argValues("--trigger"));
new Devices(onKey, (reading, denied) => emit({ type: "status", reading, denied }), DEVICE_NAME).start();
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  try {
    handle(JSON.parse(line));
  } catch (e) {
    log((e as Error).message);
  }
}).on("close", () => {
  // The parent closed the pipe. process.exit() would wait for the libuv threads, which are blocked
  // reading the devices; a signal ends the process at once.
  process.kill(process.pid, "SIGTERM");
});
emit({ type: "ready", triggers: triggers.map((t) => t.spec) });
