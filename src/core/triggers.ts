// Human-readable names for dictation triggers ("RControlKey", "Ctrl+Alt+Space", "MButton", …)
// and Electron accelerators ("Alt+Shift+Z"). The trigger syntax is defined by the native helper
// (native/win-input/Triggers.cs): "+"-separated modifiers, then a .NET Keys name or mouse button.

const TRIGGER_NAMES: Record<string, string> = {
  RControlKey: "Правый Ctrl",
  LControlKey: "Левый Ctrl",
  RMenu: "Правый Alt",
  LMenu: "Левый Alt",
  RShiftKey: "Правый Shift",
  LShiftKey: "Левый Shift",
  LWin: "Win",
  RWin: "Правый Win",
  MButton: "Колёсико мыши",
  XButton1: "Боковая кнопка «назад»",
  XButton2: "Боковая кнопка «вперёд»",
  Space: "Пробел",
  Capital: "Caps Lock",
  CapsLock: "Caps Lock",
  Return: "Enter",
  Enter: "Enter",
  Oemtilde: "`",
  Oem3: "`",
  Scroll: "Scroll Lock",
  Pause: "Pause",
  Apps: "Меню",
};

/** Each part is rendered as its own key cap. */
export function triggerParts(spec: string): string[] {
  return spec.split("+").map((p) => TRIGGER_NAMES[p] ?? p.replace(/^D(\d)$/, "$1").replace(/^NumPad/, "Num "));
}

export const isMouseTrigger = (spec: string) => /(^|\+)(MButton|XButton1|XButton2)$/.test(spec);

// ── Electron accelerators (used for "paste last") ─────────────────────────

const CODE_TO_ACCELERATOR: Record<string, string> = {
  Space: "Space", Enter: "Enter", Tab: "Tab", Backspace: "Backspace", Delete: "Delete", Insert: "Insert",
  Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown",
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
};

/** Builds an accelerator from a DOM key event; null until a non-modifier key with a modifier is pressed. */
export function acceleratorFromEvent(e: { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string | null {
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else key = CODE_TO_ACCELERATOR[e.code];
  if (!key) return null;
  const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean) as string[];
  if (!mods.length && !/^F\d/.test(key)) return null; // a bare letter would hijack typing
  return [...mods, key].join("+");
}

export function acceleratorParts(accelerator: string): string[] {
  return accelerator.split("+").map((p) => (p === "Super" ? "Win" : p === "Space" ? "Пробел" : p));
}
