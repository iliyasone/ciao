import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { app } from "electron";

export interface ForegroundWindow {
  hwnd: number;
  title: string;
  process: string;
}

type InputEvents = {
  trigger: [down: boolean];
  escape: [];
  other: [];
};

/**
 * Talks to native/win-input (Ciao.Input.exe): global keyboard and mouse hooks for the dictation
 * triggers (and for swallowing Esc), shortcut capture, foreground-window lookup and Ctrl+V
 * injection. Restarted if it dies.
 */
export class WinInput extends EventEmitter<InputEvents> {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, (reply: Record<string, unknown>) => void>();
  private stopped = false;
  private captureResolve: ((spec: string | null) => void) | null = null;

  constructor(private triggers: string[]) {
    super();
  }

  static exePath(): string {
    return app.isPackaged
      ? path.join(process.resourcesPath, "win-input", "Ciao.Input.exe")
      : path.join(app.getAppPath(), "build", "win-input", "Ciao.Input.exe");
  }

  start(): void {
    const exe = WinInput.exePath();
    if (process.platform !== "win32" || !fs.existsSync(exe)) {
      console.warn("win-input helper unavailable:", exe);
      return;
    }
    const args = this.triggers.flatMap((t) => ["--trigger", t]);
    const child = spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
  }

  setTriggers(triggers: string[]): void {
    this.triggers = triggers;
    this.send({ cmd: "triggers", list: triggers });
  }

  /** Resolves with the next key, combo or mouse button the user presses (null: Esc or timeout). */
  capture(): Promise<string | null> {
    this.captureResolve?.(null);
    if (!this.child) return Promise.resolve(null);
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
    return typeof r.hwnd === "number" ? { hwnd: r.hwnd, title: String(r.title ?? ""), process: String(r.process ?? "") } : null;
  }

  /** Ctrl+V into `hwnd` if it is still in front (0 = whatever is in front). */
  async paste(hwnd: number): Promise<{ ok: boolean; reason?: string }> {
    const r = await this.request({ cmd: "paste", hwnd });
    return { ok: r.ok === true, reason: typeof r.reason === "string" ? r.reason : undefined };
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
        this.emit("trigger", msg.down === true);
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
    }
  }
}
