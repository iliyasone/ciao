import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateState } from "../core/types";

export const REPO = { owner: "iliyasone", repo: "ciao" };
const CHECK_EVERY_MS = 4 * 60 * 60_000;
const FIRST_CHECK_AFTER_MS = 15_000;

/**
 * Checks GitHub Releases for a newer version and, when asked, downloads its installer and restarts
 * into it. Nothing is downloaded on its own: a found update only lights up the "Обновить" buttons.
 *
 * Installed builds (the NSIS installer) carry resources/app-update.yml. A portable copy (the
 * `dist:win` folder) does not; it gets the same feed from a file in userData, so its update runs
 * the installer and moves it to an installed copy.
 */
export class Updater {
  private state: UpdateState;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly changed: (s: UpdateState) => void) {
    const current = app.getVersion();
    this.state = app.isPackaged ? { phase: "idle", current } : { phase: "disabled", current };
  }

  get(): UpdateState {
    return this.state;
  }

  start(): void {
    if (this.state.phase === "disabled") return;
    autoUpdater.logger = { info: (m) => console.log("updater:", m), warn: (m) => console.warn("updater:", m), error: (m) => console.error("updater:", m) };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.disableWebInstaller = true;
    if (!fs.existsSync(path.join(process.resourcesPath, "app-update.yml"))) {
      const file = path.join(app.getPath("userData"), "app-update.yml");
      fs.writeFileSync(file, `provider: github\nowner: ${REPO.owner}\nrepo: ${REPO.repo}\nupdaterCacheDirName: ciao-updater\n`);
      autoUpdater.updateConfigPath = file;
    }
    autoUpdater.on("download-progress", (p) => {
      if (this.state.phase === "downloading") this.set({ ...this.state, percent: Math.floor(p.percent) });
    });
    autoUpdater.on("error", (e) => {
      // quitAndInstall reports a failed installer launch only through this event.
      if (this.state.phase === "installing") this.set({ phase: "error", current: this.state.current, version: this.state.version, message: describe(e) });
    });
    setTimeout(() => void this.check(false), FIRST_CHECK_AFTER_MS);
    this.timer = setInterval(() => void this.check(false), CHECK_EVERY_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * `manual`: the user pressed "Проверить" — only then is a failure shown (offline is normal in the
   * background). A background check leaves an already found version alone, so its button stays.
   */
  async check(manual = true): Promise<void> {
    const before = this.state;
    const { phase, current } = before;
    if (phase === "disabled" || phase === "checking" || phase === "downloading" || phase === "installing") return;
    const known = before.phase === "available" || before.phase === "error" ? before.version : undefined;
    if (!manual && known) return;
    this.set({ phase: "checking", current });
    try {
      const result = await autoUpdater.checkForUpdates();
      const version = result?.updateInfo.version;
      if (result?.isUpdateAvailable && version) this.set({ phase: "available", current, version });
      else this.set({ phase: "latest", current, checkedAt: Date.now() });
    } catch (e) {
      console.warn("update check failed:", e);
      if (manual) this.set({ phase: "error", current, message: describe(e), version: known });
      else this.set(before.phase === "error" ? { phase: "idle", current } : before);
    }
  }

  /** Download the found version, then quit and let its installer start the new one. */
  async install(): Promise<void> {
    const s = this.state;
    const version = s.phase === "available" || s.phase === "error" ? s.version : undefined;
    if (!version) return;
    this.set({ phase: "downloading", current: s.current, version, percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
    } catch (e) {
      console.warn("update download failed:", e);
      this.set({ phase: "error", current: s.current, version, message: describe(e) });
      return;
    }
    this.set({ phase: "installing", current: s.current, version });
    console.log(`installing ${version}`);
    // Silent install, then the installer starts the new version.
    setTimeout(() => autoUpdater.quitAndInstall(true, true), 500);
  }

  private set(next: UpdateState): void {
    this.state = next;
    this.changed(next);
  }
}

/** electron-updater errors can carry whole HTTP responses; keep the first line. */
function describe(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === "ERR_UPDATER_NO_PUBLISHED_VERSIONS" || code === "ERR_UPDATER_LATEST_VERSION_NOT_FOUND") return "На GitHub пока нет опубликованных версий";
  if (code === "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND") return "Последний релиз на GitHub собран не до конца — в нём нет latest.yml";
  const text = e instanceof Error ? e.message : String(e);
  if (/net::ERR_INTERNET_DISCONNECTED|ENOTFOUND|ERR_NAME_NOT_RESOLVED/.test(text)) return "Нет интернета";
  const line = text.split("\n")[0]!.trim();
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
