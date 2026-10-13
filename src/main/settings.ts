import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { langFromLocale } from "../core/i18n";
import { PROVIDERS } from "../core/providers";
import type { Provider, Settings } from "../core/types";

export const DEFAULT_SETTINGS: Settings = {
  provider: "openai",
  liveModel: "gpt-live-transcribe",
  delay: "low",
  languages: ["ru", "en"],
  prompt:
    "Диктовка промптов для ИИ-агентов программирования. Русская речь с английскими техническими терминами, названиями библиотек, файлов и команд.",
  keywords: [
    "T3 Code", "Claude", "Claude Code", "Codex", "OpenAI", "GitHub", "WebSocket", "API", "JSON",
    "TypeScript", "Python", "Electron", "React", "commit", "pull request", "Wispr Flow", "Windows",
  ],
  fileModel: "gpt-transcribe",
  smart: true,
  // Linux can't keep a middle click from the app under the pointer (it would paste the selection there).
  // Mac keyboards mostly have no Right Control; Right Option is the spare key there.
  triggers:
    process.platform === "linux" ? ["RControlKey"] : [process.platform === "darwin" ? "RMenu" : "RControlKey", "MButton"],
  pasteLastHotkey: "Alt+Shift+Z",
  autoPaste: true,
  restoreClipboard: true,
  showCost: true,
  openAtLogin: true,
  theme: "system",
  language: "en", // replaced by the OS language while none is saved (loadSettings)
  overlayAnchor: null,
  overlayWidth: 640,
  overlayLines: 6,
  overlayPill: true,
  showDelay: false,
  stopPhrase: true,
  tapHandsFree: true,
  t3Mode: false,
  t3Prefix: "",
  t3Suffix: "",
  t3Forward: true,
  t3Send: false,
  wakeWord: false,
  pauseMedia: false,
  formatText: true,
  telemetry: true,
  syncKeys: true,
  learnCorrections: true,
  dismissedTerms: [],
};

const file = () => path.join(app.getPath("userData"), "config.json");

/** Russian if the OS is in Russian, English otherwise. Call after app "ready". */
function systemLanguage(): Settings["language"] {
  return langFromLocale(app.getPreferredSystemLanguages()[0] ?? app.getSystemLocale());
}

/** The settings file as Ciao last read or wrote it: anything else on disk was edited from outside. */
let known: string | null = null;

export function loadSettings(): Settings {
  let text: string;
  try {
    text = fs.readFileSync(file(), "utf8");
  } catch {
    return { ...DEFAULT_SETTINGS, language: systemLanguage() };
  }
  return parseSettings(text) ?? { ...DEFAULT_SETTINGS, language: systemLanguage() };
}

/** Settings from the file's text, with older formats brought up to date; null if it isn't JSON. */
function parseSettings(text: string): Settings | null {
  let raw: Partial<Settings> & { hotkey?: string; middleClick?: boolean; overlayPosition?: { x: number; y: number } | null };
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  known = text;
  if (raw.language !== "ru" && raw.language !== "en") raw.language = systemLanguage();
  if (!raw.provider || !Object.hasOwn(PROVIDERS, raw.provider)) raw.provider = DEFAULT_SETTINGS.provider;
  if (raw.theme !== "system" && raw.theme !== "light" && raw.theme !== "dark") raw.theme = DEFAULT_SETTINGS.theme;
  // Older configs had a single `hotkey` plus a `middleClick` switch.
  if (!raw.triggers && (raw.hotkey || raw.middleClick !== undefined)) {
    raw.triggers = [raw.hotkey ?? "RControlKey", ...(raw.middleClick === false ? [] : ["MButton"])];
  }
  delete raw.hotkey;
  delete raw.middleClick;
  // Older configs kept the card window's top-left corner (the window was 320 px tall, 80 px wider
  // than the card, its bottom edge 16 px below the card's).
  if (raw.overlayPosition && raw.overlayAnchor === undefined) {
    const width = (raw.overlayWidth ?? DEFAULT_SETTINGS.overlayWidth) + 80;
    raw.overlayAnchor = { x: raw.overlayPosition.x + Math.round(width / 2), y: raw.overlayPosition.y + 320 - 16 };
  }
  delete raw.overlayPosition;
  return { ...DEFAULT_SETTINGS, ...raw };
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  known = JSON.stringify(s, null, 2);
  fs.writeFileSync(file(), known);
}

/**
 * Calls back with the settings when config.json is edited from outside while Ciao runs (another app,
 * an editor), so the next save doesn't put the old ones back over the edit. Checked every 2 s.
 */
export function watchSettings(changed: (s: Settings) => void): void {
  fs.watchFile(file(), { interval: 2000 }, () => {
    let text: string;
    try {
      text = fs.readFileSync(file(), "utf8");
    } catch {
      return;
    }
    if (text === known) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return; // half written: wait for the next change
    }
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return;
    // A value of the wrong kind ("triggers": "XButton2", or null) would break applying it while Ciao runs.
    const wrong = Object.entries(raw).find(([k, v]) => {
      const d = (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[k];
      if (d === undefined) return false;
      if (v === null || d === null) return v !== d && d !== null; // null only where the default is
      return Array.isArray(d) !== Array.isArray(v) || typeof d !== typeof v;
    });
    if (wrong) {
      known = text; // not again until the file changes
      console.warn(`settings: config.json was edited outside Ciao, but "${wrong[0]}" has the wrong kind of value; not reloaded`);
      return;
    }
    const s = parseSettings(text);
    if (s) changed(s);
  });
}

export function keyPath(provider: Provider): string {
  return path.join(app.getPath("userData"), PROVIDERS[provider].keyFile);
}

/** The provider's key: OPENAI_API_KEY / GEMINI_API_KEY, or openai-key.txt / gemini-key.txt next to the settings. */
export function loadApiKey(provider: Provider): string | null {
  return process.env[PROVIDERS[provider].keyEnv]?.trim() || loadKeyFile(provider) || null;
}

/** The key saved in Settings ("" if none), what Google sync sends: not one from the environment. */
export function loadKeyFile(provider: Provider): string {
  try {
    return cleanKey(fs.readFileSync(keyPath(provider), "utf8"));
  } catch {
    return "";
  }
}

/** Saves the key ("" removes it), readable only by this user. */
export function saveKeyFile(provider: Provider, key: string): void {
  const file = keyPath(provider);
  if (cleanKey(key)) {
    fs.writeFileSync(file, cleanKey(key), { mode: 0o600 });
    fs.chmodSync(file, 0o600); // one saved by an older Ciao
  } else {
    fs.rmSync(file, { force: true });
  }
}

/**
 * Only printable ASCII, as on Android (Prefs.kt): a zero-width space or line break from a copy
 * makes the key invalid, and both ends of sync must see the same key or they'd keep re-saving it.
 */
function cleanKey(key: string): string {
  return key.replace(/[^!-~]/g, "");
}
