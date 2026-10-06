import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, nativeImage, nativeTheme, net, powerMonitor, protocol, session, shell, systemPreferences, Tray } from "electron";
import { DELAYS, type HistoryEntry, type Provider, type RetryMode, type Settings, type UpdateState } from "../core/types";
import { costUsd } from "../core/cost";
import { models, PROVIDERS } from "../core/providers";
import { setLang, t } from "../core/i18n";
import { arrangeTerms, termsOf, type Local } from "../core/sync";
import { acceleratorParts } from "../core/triggers";
import { setAutostart } from "./autostart";
import { DictationController } from "./dictation";
import { HistoryStore, WavWriter } from "./history";
import { InputHelper } from "./input";
import { OverlayWindow } from "./overlayWindow";
import { loadApiKey, loadKeyFile, loadSettings, saveKeyFile, saveSettings } from "./settings";
import { GoogleSync } from "./sync";
import { SessionPool, transcribeFile, transcribeLive } from "./transcribe";
import { Telemetry } from "./telemetry";
import { REPO, Updater } from "./updater";
import { WakeWord } from "./wakeWord";

// Run as an X11 app on Linux, through XWayland on a Wayland desktop: only X11 lets the card sit at
// the bottom of the screen above everything, and lets Ciao grab Esc during a dictation. Electron
// picks Wayland before this file runs (and writes it into --ozone-platform); switching here would
// reach only the child processes (the GPU process then crashes on Wayland window handles), so start
// over with the flag. Not when the user chose a platform themselves, or there's no XWayland.
//
// Through the AppImage itself, if this is one: its copy unpacked for this run goes away when this
// process exits. APPIMAGE alone may be inherited from another AppImage app that started us.
const { APPIMAGE, APPDIR } = process.env;
const inAppImage = !!APPIMAGE && !!APPDIR && process.execPath.startsWith(`${APPDIR}/`);
const x11Target = inAppImage ? APPIMAGE : process.execPath;
const relaunchOnX11 =
  process.platform === "linux" &&
  app.commandLine.getSwitchValue("ozone-platform") === "wayland" &&
  !process.argv.some((a) => a === "--ozone-platform" || a.startsWith("--ozone-platform=")) &&
  !!process.env.DISPLAY &&
  isExecutable(x11Target); // a spawn error would only arrive after this process is gone
if (relaunchOnX11) {
  if (inAppImage) closeAppImageFds(APPIMAGE, APPDIR);
  // Started with --appimage-extract-and-run (no FUSE here, maybe): the runtime took the flag out of
  // our arguments, so ask for the same through the environment.
  const extracted = inAppImage && path.basename(APPDIR).startsWith("appimage_extracted_");
  const env = extracted ? { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" } : process.env;
  spawn(x11Target, ["--ozone-platform=x11", ...process.argv.slice(1)], { stdio: "inherit", env }).unref();
  app.exit(0);
}
// A second launch only forwards its arguments to the running instance (see "second-instance").
else if (!app.requestSingleInstanceLock()) app.exit(0);

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the copy started next from inheriting what ties this process to its AppImage mount: that
 * would keep the mount and its FUSE process alive for the whole session. Files inside the mount
 * are closed. The pipe the AppImage runtime waits on to unmount must stay open until this process
 * exits (its code runs from the mount), so it is reopened close-on-exec instead.
 */
function closeAppImageFds(appImage: string, appDir: string): void {
  // The runtime serves the mount from the image: it has both open (its exe may be a launcher).
  const runtimePipes = new Set<string>();
  for (const pid of fs.readdirSync("/proc")) {
    try {
      const files = fs.readdirSync(`/proc/${pid}/fd`).map((fd) => fs.readlinkSync(`/proc/${pid}/fd/${fd}`));
      if (!files.includes("/dev/fuse") || !files.includes(appImage)) continue;
      for (const f of files) if (f.startsWith("pipe:")) runtimePipes.add(f);
    } catch {
      // Not a process, gone, or not ours.
    }
  }
  for (const fd of fs.readdirSync("/proc/self/fd")) {
    if (Number(fd) <= 2) continue; // stdio is passed on on purpose
    try {
      const file = fs.readlinkSync(`/proc/self/fd/${fd}`);
      if (file.startsWith("pipe:") && runtimePipes.has(file)) {
        const flags = parseInt(/flags:\s*(\d+)/.exec(fs.readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1] ?? "0", 8);
        const access = (flags & 3) === fs.constants.O_WRONLY ? fs.constants.O_WRONLY : fs.constants.O_RDONLY;
        fs.openSync(`/proc/self/fd/${fd}`, access | fs.constants.O_NONBLOCK); // libuv opens close-on-exec
        fs.closeSync(Number(fd));
      } else if (file === appDir || file.startsWith(`${appDir}/`)) {
        fs.closeSync(Number(fd));
      }
    } catch {
      // Gone already (the directory listing's own descriptor).
    }
  }
}

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
const MAC = process.platform === "darwin";

let settings: Settings;
let store: HistoryStore;
let pool: SessionPool;
let input: InputHelper;
let overlay: OverlayWindow;
let dictation: DictationController;
let sync: GoogleSync;
const wake = new WakeWord();
const telemetry = new Telemetry(() => Telemetry.allowed() && settings?.telemetry !== false);
let historyWin: BrowserWindow | null = null;
let tray: Tray | null = null;
/** macOS: the input helper has the Accessibility permission (always true elsewhere). */
let accessibility = !MAC;
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
    // macOS keeps its traffic lights (centred in the 44 px header); Windows draws its buttons over the page.
    ...(MAC
      ? { trafficLightPosition: { x: 16, y: 15 } }
      : { titleBarOverlay: { color: chrome().background, symbolColor: chrome().symbols, height: 44 } }),
    webPreferences: { preload: PRELOAD },
  });
  void historyWin.loadFile(path.join(RENDERER, "history.html"), { hash: tab ?? "" });
  historyWin.on("closed", () => (historyWin = null));
  // Terms edited on another device show up when you come back to the window.
  historyWin.on("focus", () => sync.syncSoon(0));
}

/** What Google sync compares with its history: the settings it syncs and the saved keys. */
function local(): Local {
  const keys = Object.fromEntries((Object.keys(PROVIDERS) as Provider[]).map((p) => [p, loadKeyFile(p)]));
  return { keywords: settings.keywords, prompt: settings.prompt, keys, syncKeys: settings.syncKeys };
}

/** A key was saved here or arrived through sync: the spare session was opened with the old one. */
function keysChanged(): void {
  pool.close();
  pool.refill();
  historyWin?.webContents.send("settings:keys");
}

function applySettings(next: Settings): void {
  const prev = settings;
  settings = next;
  setLang(next.language);
  nativeTheme.themeSource = next.theme;
  saveSettings(next);
  sync?.noteLocal(local());
  setAutostart(next.openAtLogin);
  if (prev.pasteLastHotkey !== next.pasteLastHotkey) registerPasteLast(prev.pasteLastHotkey);
  if (prev.triggers.join("|") !== next.triggers.join("|")) input.setTriggers(next.triggers);
  if (prev.provider !== next.provider) pool.refill();
  // No detector in this build (macOS for now): keep the mic closed rather than listen for nothing.
  const wakeWord = next.wakeWord && WakeWord.available();
  wake.setEnabled(wakeWord);
  overlay.setWake(wakeWord);
  tray?.setToolTip(t().tray.tooltip);
  buildTrayMenu();
  // Open windows re-render in the new language right away.
  for (const win of [historyWin, overlay.win]) if (win && !win.isDestroyed()) win.webContents.send("settings:changed", next);
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
      return [{ label: t().tray.updateTo(state.version), click: () => void updater.install() }];
    case "downloading":
      return [{ label: t().tray.updating(state.version, state.percent), enabled: false }];
    case "installing":
      return [{ label: t().tray.installing(state.version), enabled: false }];
    case "error":
      return state.version ? [{ label: t().tray.retryUpdate(state.version), click: () => void updater.install() }] : [];
    default:
      return [];
  }
}

function buildTrayMenu(): void {
  if (!tray) return;
  const update = updateMenuItem(updater.get());
  const s = t().tray;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      ...update,
      ...(update.length ? [{ type: "separator" as const }] : []),
      { label: s.historyAndSettings, click: () => openHistory() },
      { label: s.pasteLast(acceleratorParts(settings.pasteLastHotkey, t().keyNames).join("+")), click: () => void dictation.pasteLast() },
      { type: "separator" },
      ...(settings.showDelay && settings.provider === "openai"
        ? [{
            label: s.delay(settings.delay),
            submenu: DELAYS.map((d) => ({ label: d, type: "radio" as const, checked: settings.delay === d, click: () => applySettings({ ...settings, delay: d }) })),
          }]
        : []),
      { label: s.showCost, type: "checkbox", checked: settings.showCost, click: () => applySettings({ ...settings, showCost: !settings.showCost }) },
      { type: "separator" },
      { label: s.quit, click: () => app.quit() },
    ]),
  );
}

/** The key for the provider in use. */
const currentKey = () => loadApiKey(settings.provider);

async function retry(id: string, mode: RetryMode): Promise<HistoryEntry> {
  const key = currentKey();
  const entry = store.get(id);
  if (!key) throw new Error(t().errors.noApiKey);
  if (!entry) throw new Error(t().errors.entryNotFound);
  const pcm = WavWriter.readPcm(store.audioPath(id));
  const model = mode === "file" ? models(settings).file : models(settings).live;
  const text = (mode === "file" ? await transcribeFile(key, pcm, settings) : await transcribeLive(key, pcm, settings)).trim();
  // Re-read: the entry may have changed while we waited.
  const fresh = store.get(id) ?? entry;
  fresh.transcripts.push({
    id: `t${fresh.transcripts.length + 1}`,
    source: mode === "file" ? "retry-file" : "retry-live",
    model,
    delay: mode === "live" && settings.provider === "openai" ? "high" : undefined,
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

/** Linux: the helper may not read /dev/input, so no key starts a dictation until that is fixed. */
async function explainInputGroup(): Promise<void> {
  const s = t().linuxInput;
  const { response } = await dialog.showMessageBox({ type: "warning", title: "Ciao", message: s.title, detail: s.message, buttons: [s.copy, s.ok], defaultId: 0 });
  if (response === 0) clipboard.writeText("sudo usermod -aG input $USER");
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
    const key = currentKey();
    if (key) text = (await retry(recent.id, "file")).transcripts.at(-1)?.text ?? null;
  } catch (e) {
    console.warn("recovering", recent.id, e);
  }
  if (text) {
    overlay.state({ ...base, phase: "recovered", message: t().overlay.recovered });
    overlay.final(seq, text);
  } else {
    overlay.state({ ...base, phase: "saved", message: t().overlay.recoveredSaved });
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
  ipcMain.handle("settings:has-key", (_e, provider: Settings["provider"]) => loadApiKey(provider) !== null);
  ipcMain.handle("settings:wake-available", () => WakeWord.available());
  ipcMain.handle("settings:capture-trigger", () => input.capture());
  ipcMain.handle("settings:accessibility", () => (MAC ? accessibility : null));
  ipcMain.handle("settings:open-accessibility", () => {
    // Asking (again) puts Ciao back on the list if the user removed it there.
    systemPreferences.isTrustedAccessibilityClient(true);
    return shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  });
  ipcMain.handle("settings:set-key", (_e, provider: Settings["provider"], key: string) => {
    if (!Object.hasOwn(PROVIDERS, provider)) return;
    saveKeyFile(provider, key);
    keysChanged();
    sync.noteLocal(local());
  });

  ipcMain.handle("sync:get", () => sync.get());
  ipcMain.handle("sync:sign-in", () => sync.signIn());
  ipcMain.handle("sync:sign-out", () => sync.signOut());

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
// macOS: opening Ciao again (Finder, Spotlight) reaches the running copy as "activate", not a second launch.
app.on("activate", () => {
  if (store) openHistory();
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
  setLang(settings.language); // before store.recover(), which writes user-facing errors
  if (process.platform === "win32") app.setAppUserModelId("dev.iliyasone.ciao");

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "media"));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === "media");

  store = new HistoryStore(path.join(app.getPath("userData"), "history"));
  const recovered = store.recover();
  if (process.platform === "win32") store.importLegacy(path.join(process.env.LOCALAPPDATA ?? "", "VoicePreview", "sessions"));
  protocol.handle("ciao-audio", (req) => {
    const id = decodeURIComponent(new URL(req.url).pathname.slice(1));
    return net.fetch(pathToFileURL(store.audioPath(id)).toString());
  });

  pool = new SessionPool(() => settings.provider, loadApiKey);
  pool.refill();
  setInterval(() => pool.refill(), 30_000);

  overlay = new OverlayWindow(
    PRELOAD,
    RENDERER,
    () => ({ position: settings.overlayPosition, cardWidth: settings.overlayWidth }),
    (p) => applySettings({ ...settings, overlayPosition: p.position, overlayWidth: p.cardWidth }),
  );
  input = new InputHelper(settings.triggers);
  dictation = new DictationController({
    store,
    pool,
    input,
    overlay,
    settings: () => settings,
    apiKey: currentKey,
    changed: notifyChanged,
    idle: () => wake.reset(),
    ended: (report) => telemetry.capture("dictation", { ...report }),
  });
  wake.on("wake", (preRoll) => dictation.onWake(preRoll));
  input.on("trigger", (down, spec) => dictation.onHotkey(down, spec));
  input.on("escape", () => dictation.onEscape());
  input.on("other", () => dictation.onOtherKey());
  input.once("devices", (reading, denied) => {
    if (reading === 0 && denied > 0) void explainInputGroup();
  });
  input.on("permission", (granted) => {
    console.log("accessibility permission:", granted);
    accessibility = granted;
    historyWin?.webContents.send("settings:accessibility", granted);
  });
  input.start();
  if (MAC) {
    // The microphone is asked once; the Accessibility dialog shows at every start until it is granted.
    void systemPreferences.askForMediaAccess("microphone").then((ok) => console.log("microphone access:", ok));
    if (!systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
  }

  sync = new GoogleSync(
    app.getPath("userData"),
    local(),
    (state) => {
      // Keys first: applySettings reads them back as this device's own.
      let keys = false;
      for (const provider of Object.keys(PROVIDERS) as Provider[]) {
        const key = state.keys[provider]?.value;
        if (key === undefined || key === loadKeyFile(provider)) continue;
        saveKeyFile(provider, key);
        keys = true;
      }
      if (keys) keysChanged();
      applySettings({ ...settings, keywords: arrangeTerms(settings.keywords, termsOf(state)), prompt: state.prompt.value, syncKeys: state.syncKeys.value });
      historyWin?.webContents.send("settings:synced", settings);
    },
    (status) => historyWin?.webContents.send("sync:status", status),
  );
  powerMonitor.on("resume", () => sync.syncSoon(5_000)); // the network needs a moment after sleep

  registerIpc();
  const trayPng = path.join(ASSETS, "tray.png");
  // The macOS menu bar is 22 pt tall: the 32 px icon goes in as 16 pt at 2x, sharp on Retina.
  tray = new Tray(MAC ? nativeImage.createFromBuffer(fs.readFileSync(trayPng), { scaleFactor: 2 }) : nativeImage.createFromPath(trayPng));
  // On macOS a click opens the menu (which has "History and settings"); Windows opens the window.
  if (!MAC) tray.on("click", () => openHistory());
  // applySettings only re-registers the hotkey when it changes, and here prev === next.
  registerPasteLast();
  applySettings(settings);
  nativeTheme.on("updated", () => {
    if (!historyWin || historyWin.isDestroyed()) return;
    const c = chrome();
    historyWin.setBackgroundColor(c.background);
    if (!MAC) historyWin.setTitleBarOverlay({ color: c.background, symbolColor: c.symbols, height: 44 });
  });

  console.log(`Ciao ${app.getVersion()} started; history: ${store.list().length} entries`);
  telemetry.capture("app_started", { has_api_key: currentKey() !== null, provider: settings.provider, wake_word_enabled: settings.wakeWord, format_text_enabled: settings.formatText });
  updater.start();
  void showRecovered(recovered);
  if (!currentKey()) openHistory("settings");
});
