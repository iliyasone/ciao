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
  overlayPosition: null,
  overlayWidth: 640,
  showDelay: false,
  stopPhrase: true,
  wakeWord: false,
  formatText: true,
  telemetry: true,
  syncKeys: true,
};

const file = () => path.join(app.getPath("userData"), "config.json");

/** Russian if the OS is in Russian, English otherwise. Call after app "ready". */
function systemLanguage(): Settings["language"] {
  return langFromLocale(app.getPreferredSystemLanguages()[0] ?? app.getSystemLocale());
}

export function loadSettings(): Settings {
  let raw: Partial<Settings> & { hotkey?: string; middleClick?: boolean };
  try {
    raw = JSON.parse(fs.readFileSync(file(), "utf8"));
  } catch {
    return { ...DEFAULT_SETTINGS, language: systemLanguage() };
  }
  if (raw.language !== "ru" && raw.language !== "en") raw.language = systemLanguage();
  if (!raw.provider || !Object.hasOwn(PROVIDERS, raw.provider)) raw.provider = DEFAULT_SETTINGS.provider;
  // Older configs had a single `hotkey` plus a `middleClick` switch.
  if (!raw.triggers && (raw.hotkey || raw.middleClick !== undefined)) {
    raw.triggers = [raw.hotkey ?? "RControlKey", ...(raw.middleClick === false ? [] : ["MButton"])];
  }
  delete raw.hotkey;
  delete raw.middleClick;
  return { ...DEFAULT_SETTINGS, ...raw };
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
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
    return fs.readFileSync(keyPath(provider), "utf8").trim();
  } catch {
    return "";
  }
}

/** Saves the key ("" removes it). */
export function saveKeyFile(provider: Provider, key: string): void {
  if (key.trim()) fs.writeFileSync(keyPath(provider), key.trim(), { mode: 0o600 });
  else fs.rmSync(keyPath(provider), { force: true });
}
