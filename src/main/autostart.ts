import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

/**
 * Start Ciao when the user signs in. Electron does this on Windows; on Linux it is an XDG autostart
 * entry, which every desktop reads. It points at the AppImage when running from one (the mounted
 * copy inside it moves every run), otherwise at the installed binary.
 */
export function setAutostart(on: boolean): void {
  if (!app.isPackaged) return;
  if (process.platform !== "linux") {
    app.setLoginItemSettings({ openAtLogin: on });
    return;
  }
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "autostart");
  const file = path.join(dir, "ciao.desktop");
  try {
    if (!on) {
      fs.rmSync(file, { force: true });
      return;
    }
    const exec = process.env.APPIMAGE ?? process.execPath;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Ciao\nExec="${exec}"\nIcon=ciao\nX-GNOME-Autostart-enabled=true\n`);
  } catch (e) {
    console.warn("autostart:", e);
  }
}
