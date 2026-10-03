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
//
// Extra event: {"type":"status","reading":N,"denied":M} after every device scan.
import readline from "node:readline";
import { Devices } from "./evdev";
import { isLoneModifier, isModifier, KEY_ESC, keyName, modifierPrefix, modifiersMatch, modifiersOf, MOUSE_BUTTONS, parseTrigger, type Trigger } from "./keys";
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
  if (triggers.some((t) => t.active && isLoneModifier(t) && t.key !== code)) emit({ type: "other" });
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
