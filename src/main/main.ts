import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, protocol, session, shell, Tray } from "electron";
import { DELAYS, type HistoryEntry, type RetryMode, type Settings, type UpdateState } from "../core/types";
import { costUsd } from "../core/cost";
import { DictationController } from "./dictation";
import { HistoryStore, WavWriter } from "./history";
import { OverlayWindow } from "./overlayWindow";
import { loadApiKey, loadSettings, saveSettings } from "./settings";
import { SessionPool, transcribeFile, transcribeLive } from "./transcribe";
import { REPO, Updater } from "./updater";
import { WakeWord } from "./wakeWord";
import { WinInput } from "./winInput";

// A second launch only forwards its arguments to the running instance (see "second-instance").
if (!app.requestSingleInstanceLock()) app.exit(0);

// Mirror console output into userData/ciao.log — the only way to see what happened on someone's machine.
{
  const logFile = path.join(app.getPath("userData"), "ciao.log");
  try {
    if (fs.statSync(logFile).size > 2_000_000) fs.renameSync(logFile, `${logFile}.old`);
  } catch {
    // No log yet.
  }
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      const line = args.map((a) => (a instanceof Error ? a.stack : typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      fs.appendFile(logFile, `${new Date().toISOString()} ${level} ${line}\n`, () => {});
    };
  }
  process.on("uncaughtException", (e) => console.error("uncaught", e));
  process.on("unhandledRejection", (e) => console.error("unhandled rejection", e));
}

protocol.registerSchemesAsPrivileged([
  { scheme: "ciao-audio", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const DIST = path.join(__dirname, "..");
const PRELOAD = path.join(DIST, "preload", "preload.js");
const RENDERER = path.join(DIST, "renderer");
const ASSETS = app.isPackaged ? path.join(process.resourcesPath, "assets") : path.join(app.getAppPath(), "assets");

let settings: Settings;
let store: HistoryStore;
let pool: SessionPool;
let input: WinInput;
let overlay: OverlayWindow;
let dictation: DictationController;
const wake = new WakeWord();
let historyWin: BrowserWindow | null = null;
let tray: Tray | null = null;
const updater = new Updater((state) => {
  historyWin?.webContents.send("update:state", state);
  buildTrayMenu();
});

function notifyChanged(entry: HistoryEntry): void {
  historyWin?.webContents.send("history:changed", entry);
}

/** Window chrome colours for the current theme (the page itself follows prefers-color-scheme). */
function chrome(): { background: string; symbols: string } {
  return nativeTheme.shouldUseDarkColors ? { background: "#111114", symbols: "#a1a1aa" } : { background: "#f4f4f6", symbols: "#52525b" };
}

function openHistory(tab?: "settings"): void {
  if (historyWin && !historyWin.isDestroyed()) {
    historyWin.show();
    historyWin.focus();
    return;
  }
  historyWin = new BrowserWindow({
    width: 1040,
    height: 740,
    minWidth: 720,
    minHeight: 480,
    title: "Ciao",
    icon: path.join(ASSETS, "icon.png"),
    backgroundColor: chrome().background,
    titleBarStyle: "hidden",
    titleBarOverlay: { color: chrome().background, symbolColor: chrome().symbols, height: 44 },
    webPreferences: { preload: PRELOAD },
  });
  void historyWin.loadFile(path.join(RENDERER, "history.html"), { hash: tab ?? "" });
  historyWin.on("closed", () => (historyWin = null));
}

function applySettings(next: Settings): void {
  const prev = settings;
  settings = next;
  nativeTheme.themeSource = next.theme;
  saveSettings(next);
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: next.openAtLogin });
  if (!prev || prev.pasteLastHotkey !== next.pasteLastHotkey) registerPasteLast(prev?.pasteLastHotkey);
  if (prev && prev.triggers.join("|") !== next.triggers.join("|")) input.setTriggers(next.triggers);
  wake.setEnabled(next.wakeWord);
  overlay.setWake(next.wakeWord);
  buildTrayMenu();
}

function registerPasteLast(previous?: string): void {
  if (previous) globalShortcut.unregister(previous);
  try {
    if (!globalShortcut.register(settings.pasteLastHotkey, () => void dictation.pasteLast()))
      console.warn(`paste-last hotkey ${settings.pasteLastHotkey} is taken by another app`);
  } catch (e) {
    console.warn("paste-last hotkey:", e);
  }
}

function updateMenuItem(state: UpdateState): Electron.MenuItemConstructorOptions[] {
  switch (state.phase) {
    case "available":
      return [{ label: `Обновить до ${state.version}`, click: () => void updater.install() }];
    case "downloading":
      return [{ label: `Обновление ${state.version}: ${state.percent}%`, enabled: false }];
    case "installing":
      return [{ label: `Устанавливается ${state.version}…`, enabled: false }];
    case "error":
      return state.version ? [{ label: `Повторить обновление до ${state.version}`, click: () => void updater.install() }] : [];
    default:
      return [];
  }
}

function buildTrayMenu(): void {
  if (!tray) return;
  const update = updateMenuItem(updater.get());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...update,
      ...(update.length ? [{ type: "separator" as const }] : []),
      { label: "История и настройки", click: () => openHistory() },
      { label: `Вставить последнее  (${settings.pasteLastHotkey})`, click: () => void dictation.pasteLast() },
      { type: "separator" },
      ...(settings.showDelay
        ? [{
            label: `Задержка: ${settings.delay}`,
            submenu: DELAYS.map((d) => ({ label: d, type: "radio" as const, checked: settings.delay === d, click: () => applySettings({ ...settings, delay: d }) })),
          }]
        : []),
      { label: "Показывать стоимость", type: "checkbox", checked: settings.showCost, click: () => applySettings({ ...settings, showCost: !settings.showCost }) },
      { type: "separator" },
      { label: "Выход", click: () => app.quit() },
    ]),
  );
}

async function retry(id: string, mode: RetryMode): Promise<HistoryEntry> {
  const key = loadApiKey();
  const entry = store.get(id);
  if (!key) throw new Error("Нет API-ключа");
  if (!entry) throw new Error("Запись не найдена");
  const pcm = WavWriter.readPcm(store.audioPath(id));
  const model = mode === "file" ? settings.fileModel : settings.liveModel;
  const text = (mode === "file" ? await transcribeFile(key, pcm, settings) : await transcribeLive(key, pcm, settings)).trim();
  // Re-read: the entry may have changed while we waited.
  const fresh = store.get(id) ?? entry;
  fresh.transcripts.push({
    id: `t${fresh.transcripts.length + 1}`,
    source: mode === "file" ? "retry-file" : "retry-live",
    model,
    delay: mode === "live" ? "high" : undefined,
    text,
    createdAt: new Date().toISOString(),
    costUsd: costUsd(model, fresh.durationMs),
  });
  fresh.status = "done";
  fresh.error = undefined;
  store.save(fresh);
  notifyChanged(fresh);
  return fresh;
}

/**
 * A dictation cut short by a restart (an update, a crash): transcribe its saved audio and show it,
 * so nothing said is silently lost. Only the latest recent one is surfaced; all stay in history.
 */
async function showRecovered(entries: HistoryEntry[]): Promise<void> {
  const recent = entries
    .filter((e) => e.durationMs > 1500 && Date.now() - Date.parse(e.createdAt) < 60 * 60_000)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!recent) return;
  await new Promise((r) => setTimeout(r, 1500)); // let the overlay page load
  const seq = dictation.nextSeq();
  const started = Date.parse(recent.createdAt);
  const base = { seq, handsFree: false, startedAt: started, endedAt: started + recent.durationMs, showCost: false, costPerMinuteUsd: 0, offline: false };
  let text: string | null = null;
  try {
    const key = loadApiKey();
    if (key) text = (await retry(recent.id, "file")).transcripts.at(-1)?.text ?? null;
  } catch (e) {
    console.warn("recovering", recent.id, e);
  }
  if (text) {
    overlay.state({ ...base, phase: "recovered", message: "Запись прервалась при перезапуске — вот что ты сказал" });
    overlay.final(seq, text);
  } else {
    overlay.state({ ...base, phase: "saved", message: "Запись прервалась при перезапуске — аудио сохранено в истории" });
  }
}

function registerIpc(): void {
  ipcMain.on("wake:chunk", (_e, pcm: ArrayBuffer) => wake.feed(new Uint8Array(pcm)));
  ipcMain.on("capture:chunk", (_e, seq: number, pcm: ArrayBuffer) => dictation.onChunk(seq, new Uint8Array(pcm)));
  ipcMain.on("capture:stopped", (_e, seq: number) => dictation.onCaptureStopped(seq));
  ipcMain.on("capture:error", (_e, seq: number, message: string) => dictation.onCaptureError(seq, message));
  ipcMain.on("overlay:interactive", (_e, on: boolean) => overlay.setInteractive(on));
  ipcMain.on("overlay:hidden", (_e, seq: number) => overlay.hidden(seq));
  ipcMain.on("overlay:drag-start", () => overlay.dragStart());
  ipcMain.on("overlay:drag", (_e, mode: "move" | "resize", dx: number, dy: number) => overlay.drag(mode, dx, dy));
  ipcMain.on("overlay:drag-end", () => overlay.dragEnd());
  ipcMain.on("overlay:reset-placement", () => overlay.resetPlacement());
  ipcMain.handle("overlay:copy", (_e, text: string) => clipboard.writeText(text));
  ipcMain.on("overlay:open-history", () => openHistory());

  ipcMain.handle("history:list", () => store.list());
  ipcMain.handle("history:remove", (_e, id: string) => store.delete(id));
  ipcMain.handle("history:retry", (_e, id: string, mode: RetryMode) => retry(id, mode));
  ipcMain.handle("history:copy", (_e, text: string) => clipboard.writeText(text));
  ipcMain.handle("history:open-folder", (_e, id?: string) => shell.openPath(id ? path.dirname(store.audioPath(id)) : store.dir));

  ipcMain.handle("settings:get", () => settings);
  ipcMain.handle("settings:set", (_e, next: Settings) => {
    applySettings({ ...settings, ...next });
    return settings;
  });
  ipcMain.handle("settings:has-key", () => loadApiKey() !== null);
  ipcMain.handle("settings:wake-available", () => WakeWord.available());
  ipcMain.handle("settings:capture-trigger", () => input.capture());
  ipcMain.handle("settings:set-key", (_e, key: string) => {
    fs.writeFileSync(path.join(app.getPath("userData"), "openai-key.txt"), key.trim());
    pool.refill();
  });

  ipcMain.handle("update:get", () => updater.get());
  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:install", () => updater.install());
  ipcMain.handle("update:open-notes", (_e, version: string) =>
    shell.openExternal(`https://github.com/${REPO.owner}/${REPO.repo}/releases/tag/v${encodeURIComponent(version)}`),
  );
}

/** `Ciao.exe --replay=file.wav` (24 kHz mono PCM16) sends a recording through the running app. */
function replayArg(argv: string[]): string | null {
  // Chromium reorders switches, so the value must be attached with "=".
  return argv.find((a) => a.startsWith("--replay="))?.slice("--replay=".length) ?? null;
}

app.on("second-instance", (_e, argv) => {
  const file = replayArg(argv);
  if (file) void dictation.replay(WavWriter.readPcm(file));
  else openHistory();
});
app.on("window-all-closed", () => {
  // Keep running in the tray.
});
app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  updater.stop();
  input?.stop();
  pool?.close();
});

void app.whenReady().then(() => {
  settings = loadSettings();
  if (process.platform === "win32") app.setAppUserModelId("dev.iliyasone.ciao");

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

  store = new HistoryStore(path.join(app.getPath("userData"), "history"));
  const recovered = store.recover();
  store.importLegacy(path.join(process.env.LOCALAPPDATA ?? "", "VoicePreview", "sessions"));
  protocol.handle("ciao-audio", (req) => {
    const id = decodeURIComponent(new URL(req.url).pathname.slice(1));
    return net.fetch(pathToFileURL(store.audioPath(id)).toString());
  });

  pool = new SessionPool(loadApiKey);
  pool.refill();
  setInterval(() => pool.refill(), 30_000);

  overlay = new OverlayWindow(
    PRELOAD,
    RENDERER,
    () => ({ position: settings.overlayPosition, cardWidth: settings.overlayWidth }),
    (p) => applySettings({ ...settings, overlayPosition: p.position, overlayWidth: p.cardWidth }),
  );
  input = new WinInput(settings.triggers);
  dictation = new DictationController({ store, pool, input, overlay, settings: () => settings, apiKey: loadApiKey, changed: notifyChanged, idle: () => wake.reset() });
  wake.on("wake", (preRoll) => dictation.onWake(preRoll));
  input.on("trigger", (down) => dictation.onHotkey(down));
  input.on("escape", () => dictation.onEscape());
  input.on("other", () => dictation.onOtherKey());
  input.start();

  registerIpc();
  tray = new Tray(nativeImage.createFromPath(path.join(ASSETS, "tray.png")));
  tray.setToolTip("Ciao — диктовка с живым превью");
  tray.on("click", () => openHistory());
  applySettings(settings);
  nativeTheme.on("updated", () => {
    if (!historyWin || historyWin.isDestroyed()) return;
    const c = chrome();
    historyWin.setBackgroundColor(c.background);
    historyWin.setTitleBarOverlay({ color: c.background, symbolColor: c.symbols, height: 44 });
  });

  console.log(`Ciao ${app.getVersion()} started; history: ${store.list().length} entries`);
  updater.start();
  void showRecovered(recovered);
  if (!loadApiKey()) openHistory("settings");
});
