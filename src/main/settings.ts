import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { Settings } from "../core/types";

export const DEFAULT_SETTINGS: Settings = {
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
  hotkey: "RControlKey",
  pasteLastHotkey: "Alt+Shift+Z",
  autoPaste: true,
  restoreClipboard: true,
  showCost: true,
  openAtLogin: true,
};

const file = () => path.join(app.getPath("userData"), "config.json");

export function loadSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(file(), "utf8")) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2));
}

/** OPENAI_API_KEY, or openai-key.txt next to the settings. */
export function loadApiKey(): string | null {
  const env = process.env.OPENAI_API_KEY?.trim();
  if (env) return env;
  try {
    return fs.readFileSync(path.join(app.getPath("userData"), "openai-key.txt"), "utf8").trim() || null;
  } catch {
    return null;
  }
}
