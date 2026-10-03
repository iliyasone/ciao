// Dictation triggers on Linux: the same spec syntax as native/win-input/Triggers.cs ("+"-separated
// Ctrl/Alt/Shift/Win, then a .NET Keys name or MButton/XButton1/XButton2), mapped to evdev codes
// (linux/input-event-codes.h), so settings read the same on both systems.

/** evdev key code → the .NET Keys name the Windows helper reports for that key. */
const KEY_NAMES: Record<number, string> = {
  1: "Escape", 14: "Back", 15: "Tab", 28: "Return", 57: "Space", 58: "Capital",
  12: "OemMinus", 13: "Oemplus", 26: "OemOpenBrackets", 27: "Oem6", 39: "Oem1", 40: "Oem7", 41: "Oemtilde",
  43: "Oem5", 51: "Oemcomma", 52: "OemPeriod", 53: "OemQuestion", 86: "OemBackslash",
  29: "LControlKey", 97: "RControlKey", 42: "LShiftKey", 54: "RShiftKey", 56: "LMenu", 100: "RMenu", 125: "LWin", 126: "RWin",
  127: "Apps", 69: "NumLock", 70: "Scroll", 99: "PrintScreen", 119: "Pause",
  102: "Home", 103: "Up", 104: "PageUp", 105: "Left", 106: "Right", 107: "End", 108: "Down", 109: "Next", 110: "Insert", 111: "Delete",
  55: "Multiply", 74: "Subtract", 78: "Add", 83: "Decimal", 98: "Divide", 96: "Return",
  71: "NumPad7", 72: "NumPad8", 73: "NumPad9", 75: "NumPad4", 76: "NumPad5", 77: "NumPad6", 79: "NumPad1", 80: "NumPad2", 81: "NumPad3", 82: "NumPad0",
};
[..."1234567890"].forEach((d, i) => (KEY_NAMES[2 + i] = `D${d}`));
[..."QWERTYUIOP"].forEach((c, i) => (KEY_NAMES[16 + i] = c));
[..."ASDFGHJKL"].forEach((c, i) => (KEY_NAMES[30 + i] = c));
[..."ZXCVBNM"].forEach((c, i) => (KEY_NAMES[44 + i] = c));
for (let i = 0; i < 10; i++) KEY_NAMES[59 + i] = `F${i + 1}`;
KEY_NAMES[87] = "F11";
KEY_NAMES[88] = "F12";
for (let i = 0; i < 12; i++) KEY_NAMES[183 + i] = `F${i + 13}`;

/** Other names .NET accepts for the same keys. */
const ALIASES: Record<string, string> = {
  enter: "Return", capslock: "Capital", oemsemicolon: "Oem1", oem2: "OemQuestion", oem3: "Oemtilde", oemclosebrackets: "Oem6",
  oem4: "OemOpenBrackets", oempipe: "Oem5", oemquotes: "Oem7", oem102: "OemBackslash", prior: "PageUp", pagedown: "Next",
  snapshot: "PrintScreen",
};

const CODES = new Map<string, number>();
for (const [code, name] of Object.entries(KEY_NAMES)) if (!CODES.has(name.toLowerCase())) CODES.set(name.toLowerCase(), Number(code));

export const KEY_ESC = 1;
export const keyName = (code: number): string | undefined => KEY_NAMES[code];

/** evdev button codes: BTN_MIDDLE, BTN_SIDE/BTN_BACK (back), BTN_EXTRA/BTN_FORWARD (forward). */
export const MOUSE_BUTTONS: Record<number, string> = { 0x112: "MButton", 0x113: "XButton1", 0x116: "XButton1", 0x114: "XButton2", 0x115: "XButton2" };

const CTRL = [29, 97];
const SHIFT = [42, 54];
const ALT = [56, 100];
const WIN = [125, 126];
const MODIFIERS = new Set([...CTRL, ...SHIFT, ...ALT, ...WIN]);
export const isModifier = (code: number) => MODIFIERS.has(code);

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  win: boolean;
}

export function modifiersOf(held: Set<number>): Modifiers {
  const any = (codes: number[]) => codes.some((c) => held.has(c));
  return { ctrl: any(CTRL), alt: any(ALT), shift: any(SHIFT), win: any(WIN) };
}

export const modifierPrefix = (m: Modifiers) => (m.ctrl ? "Ctrl+" : "") + (m.alt ? "Alt+" : "") + (m.shift ? "Shift+" : "") + (m.win ? "Win+" : "");

export interface Trigger extends Modifiers {
  spec: string;
  key?: number;
  mouse?: string;
  /** Held down (between its down and up events). */
  active: boolean;
}

export function parseTrigger(spec: string): Trigger | null {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  const t: Trigger = { spec, ctrl: false, alt: false, shift: false, win: false, active: false };
  for (const m of parts.slice(0, -1)) {
    const k = m.toLowerCase();
    if (k !== "ctrl" && k !== "alt" && k !== "shift" && k !== "win") return null;
    t[k] = true;
  }
  const last = parts.at(-1)!.toLowerCase();
  const mouse = Object.values(MOUSE_BUTTONS).find((b) => b.toLowerCase() === last);
  if (mouse) return { ...t, mouse };
  const key = CODES.get(ALIASES[last]?.toLowerCase() ?? last);
  return key === undefined ? null : { ...t, key };
}

/** A bare modifier like Right Ctrl. */
export const isLoneModifier = (t: Trigger) => t.key !== undefined && isModifier(t.key) && !t.ctrl && !t.alt && !t.shift && !t.win;

/** Exactly the required modifiers are down (so Ctrl+Space doesn't fire on Ctrl+Shift+Space). */
export const modifiersMatch = (t: Trigger, now: Modifiers) =>
  isLoneModifier(t) || (now.ctrl === t.ctrl && now.alt === t.alt && now.shift === t.shift && now.win === t.win);
