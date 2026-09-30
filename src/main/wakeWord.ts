import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { app, utilityProcess, type UtilityProcess } from "electron";
import { BYTES_PER_MS } from "../core/audio";

const PRE_ROLL_MS = 1000; // the detector fires ~0.2 s after the word; keep the word and what came after

/**
 * Listens for the wake word in a utility process (src/main/wakeProcess.ts). Audio comes from the
 * always-on mic in the overlay renderer while no dictation is running; the last second of it is
 * kept, so words said right after "чао" can be handed to the dictation it starts.
 */
export class WakeWord extends EventEmitter<{ wake: [preRoll: Uint8Array] }> {
  private child: UtilityProcess | null = null;
  private enabled = false;
  private recent: Uint8Array[] = [];
  private recentBytes = 0;

  static dir(): string {
    return app.isPackaged ? path.join(process.resourcesPath, "kws") : path.join(app.getAppPath(), "build", "kws");
  }

  static available(): boolean {
    return fs.existsSync(path.join(WakeWord.dir(), "model", "tokens.txt"));
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.child) this.spawn();
    if (!on) {
      this.child?.kill();
      this.child = null;
      this.recent = [];
      this.recentBytes = 0;
    }
  }

  feed(pcm: Uint8Array): void {
    if (!this.child) return;
    this.recent.push(pcm);
    this.recentBytes += pcm.byteLength;
    while (this.recentBytes - this.recent[0]!.byteLength >= PRE_ROLL_MS * BYTES_PER_MS) this.recentBytes -= this.recent.shift()!.byteLength;
    this.child.postMessage({ type: "pcm", pcm });
  }

  /** Start fresh after a dictation, so audio from before it can't trigger anything. */
  reset(): void {
    this.recent = [];
    this.recentBytes = 0;
    this.child?.postMessage({ type: "reset" });
  }

  private spawn(): void {
    if (!WakeWord.available()) {
      console.warn("wake word: detector not found in", WakeWord.dir());
      return;
    }
    const child = utilityProcess.fork(path.join(__dirname, "wake.js"), [WakeWord.dir()], { serviceName: "Ciao wake word", stdio: "pipe" });
    this.child = child;
    // Known harmless chatter: sherpa announcing its resampler, Vosk missing the Gr.fst we removed on purpose.
    const noise = /Creating a resampler|in_sample_rate|output_sample_rate|Gr\.fst/;
    child.stderr?.on("data", (d) => {
      const lines = String(d).split(/\r?\n/).filter((l) => l.trim() && !noise.test(l));
      if (lines.length) console.warn("wake stderr:", lines.join(" | "));
    });
    child.on("message", (msg: { type: string; keyword?: string; message?: string }) => {
      if (msg.type === "error") console.warn("wake word:", msg.message);
      if (msg.type !== "wake") return;
      console.log("wake word heard:", msg.keyword);
      const preRoll = Buffer.concat(this.recent);
      this.recent = [];
      this.recentBytes = 0;
      this.emit("wake", preRoll);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      console.warn("wake word process exited", code);
      if (this.enabled) setTimeout(() => this.enabled && !this.child && this.spawn(), 3000);
    });
  }
}
