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
  hotkey: [down: boolean];
  escape: [];
  other: [];
};

/**
 * Talks to native/win-input (Ciao.Input.exe): a global keyboard hook that can
 * swallow Esc, plus foreground-window lookup and Ctrl+V injection. Restarted if it dies.
 */
export class WinInput extends EventEmitter<InputEvents> {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, (reply: Record<string, unknown>) => void>();
  private stopped = false;

  constructor(private readonly hotkey: string) {
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
    const child = spawn(exe, ["--hotkey", this.hotkey], { stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
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
    switch (msg.type) {
      case "hotkey":
        this.emit("hotkey", msg.down === true);
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
