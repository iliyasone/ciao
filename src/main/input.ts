import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app, BrowserWindow, globalShortcut } from "electron";
import { WakeWord } from "./wakeWord";

/** Why a paste into the dictation's window did not happen. */
export interface PasteMiss {
  reason: string;
  /** The app in front instead (process name, no title). */
  foregroundProcess?: string;
  /** false = the window was closed. */
  targetExists?: boolean;
  /** false = the window is on another virtual desktop; undefined = the system could not tell. */
  targetOnCurrentDesktop?: boolean;
}

export interface ForegroundWindow {
  /** HWND on Windows, X11 window id on Linux, the app's process id on macOS; 0 = unknown (Wayland). */
  hwnd: number;
  title: string;
  process: string;
}

type InputEvents = {
  trigger: [down: boolean, spec: string];
  escape: [];
  other: [];
  /** Linux: keyboards and mice the helper reads, and ones it may not open (not in the "input" group). */
  devices: [reading: number, denied: number];
  /** macOS: whether Ciao has the Accessibility permission the helper needs. */
  permission: [accessibility: boolean];
};

/**
 * Talks to the input helper: native/win-input (Ciao.Input.exe) on Windows, native/mac-input
 * (Swift) on macOS, src/linux-input run as plain Node on Linux. It reports the dictation triggers (and Esc), captures shortcuts, looks up
 * the foreground window and types Ctrl+V. Restarted if it dies.
 */
export class InputHelper extends EventEmitter<InputEvents> {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, (reply: Record<string, unknown>) => void>();
  private stopped = false;
  private captureResolve: ((spec: string | null) => void) | null = null;
  /** macOS: false until the helper has the Accessibility permission (it hears no keys before). */
  private canHear = true;

  constructor(private triggers: string[]) {
    super();
  }

  /** How to run the helper on this system; null where there is none. */
  private static command(): { file: string; args: string[]; env?: NodeJS.ProcessEnv } | null {
    if (process.platform === "win32") {
      const exe = app.isPackaged
        ? path.join(process.resourcesPath, "win-input", "Ciao.Input.exe")
        : path.join(app.getAppPath(), "build", "win-input", "Ciao.Input.exe");
      return fs.existsSync(exe) ? { file: exe, args: [] } : null;
    }
    if (process.platform === "darwin") {
      const exe = app.isPackaged
        ? path.join(process.resourcesPath, "mac-input", "Ciao.Input")
        : path.join(app.getAppPath(), "build", "mac-input", "Ciao.Input");
      return fs.existsSync(exe) ? { file: exe, args: [] } : null;
    }
    if (process.platform === "linux") {
      const koffi = path.join(WakeWord.dir(), "koffi");
      if (!fs.existsSync(koffi)) return null;
      // Every keyboard and mouse is a blocking read on a libuv thread (4 by default).
      const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "64" };
      return { file: process.execPath, args: [path.join(__dirname, "linux-input.js"), "--koffi", koffi], env };
    }
    return null;
  }

  start(): void {
    const command = InputHelper.command();
    if (!command) {
      console.warn("input helper unavailable on", process.platform);
      return;
    }
    const args = [...command.args, ...this.triggers.flatMap((t) => ["--trigger", t])];
    const child = spawn(command.file, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: command.env });
    readline.createInterface({ input: child.stderr! }).on("line", (line) => console.error("input stderr:", line));
    this.child = child;
    readline.createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("exit", () => {
      this.child = null;
      for (const resolve of this.pending.values()) resolve({ ok: false, reason: "helper-exited" });
      this.pending.clear();
      if (!this.stopped) setTimeout(() => this.start(), 1000);
    });
  }

  stop(): void {
    this.stopped = true;
    this.child?.kill();
  }

  arm(on: boolean): void {
    this.send({ cmd: "arm", on });
    // The Linux helper only listens, so Esc would also reach the app in front. On X11 a global
    // shortcut grabs it while armed (on Wayland the grab only covers X11 apps).
    if (process.platform !== "linux") return;
    try {
      if (on) globalShortcut.register("Escape", () => {}); // the helper reports the press itself
      else globalShortcut.unregister("Escape");
    } catch {
      // Taken by another app.
    }
  }

  setTriggers(triggers: string[]): void {
    this.triggers = triggers;
    this.send({ cmd: "triggers", list: triggers });
  }

  /** Resolves with the next key, combo or mouse button the user presses (null: Esc or timeout). */
  capture(): Promise<string | null> {
    this.captureResolve?.(null);
    if (!this.child || !this.canHear) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.send({ cmd: "capture", on: false });
        finish(null);
      }, 20_000);
      const finish = (spec: string | null) => {
        clearTimeout(timer);
        this.captureResolve = null;
        resolve(spec);
      };
      this.captureResolve = finish;
      this.send({ cmd: "capture", on: true });
    });
  }

  async foreground(): Promise<ForegroundWindow | null> {
    const r = await this.request({ cmd: "foreground" });
    if (typeof r.hwnd !== "number") return null;
    // macOS names apps, not windows: Ciao in front with none of its windows focused means its
    // window was just closed and macOS left Ciao active. ⌘V would go nowhere; no target instead.
    if (process.platform === "darwin" && r.hwnd === process.pid && !BrowserWindow.getFocusedWindow()) return null;
    return { hwnd: r.hwnd, title: String(r.title ?? ""), process: String(r.process ?? "") };
  }

  /** Ctrl+V (⌘V on macOS) into `hwnd` if it is still in front (0 = whatever is in front). */
  async paste(hwnd: number): Promise<{ ok: true } | ({ ok: false } & PasteMiss)> {
    const r = await this.request({ cmd: "paste", hwnd });
    if (r.ok === true) return { ok: true };
    return {
      ok: false,
      reason: typeof r.reason === "string" ? r.reason : "unknown",
      foregroundProcess: typeof r.foregroundProcess === "string" ? r.foregroundProcess : undefined,
      targetExists: typeof r.targetExists === "boolean" ? r.targetExists : undefined,
      targetOnCurrentDesktop: typeof r.targetOnCurrentDesktop === "boolean" ? r.targetOnCurrentDesktop : undefined,
    };
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.child) return Promise.resolve({ ok: false, reason: "no-helper" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, reason: "timeout" });
      }, 2000);
      this.pending.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      this.send({ ...msg, id });
    });
  }

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin?.write(`${JSON.stringify(msg)}\n`);
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      this.pending.get(msg.id)?.(msg);
      this.pending.delete(msg.id);
      return;
    }
    if (msg.type !== "trigger") console.log("input:", line); // trigger presses are too chatty to log
    switch (msg.type) {
      case "trigger":
        this.emit("trigger", msg.down === true, String(msg.spec ?? ""));
        break;
      case "captured":
        this.captureResolve?.(typeof msg.spec === "string" ? msg.spec : null);
        break;
      case "escape":
        this.emit("escape");
        break;
      case "other":
        this.emit("other");
        break;
      case "status":
        this.emit("devices", Number(msg.reading), Number(msg.denied));
        break;
      case "permission":
        this.canHear = msg.accessibility === true;
        this.emit("permission", this.canHear);
        break;
    }
  }
}
