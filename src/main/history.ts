import fs from "node:fs";
import path from "node:path";
import { wavHeader } from "../core/audio";
import type { HistoryEntry } from "../core/types";

/**
 * Every dictation lives in its own folder: history/<id>/{audio.wav, entry.json}.
 * Audio is appended to disk as it is captured, so nothing said is lost even if the
 * app, the network or the API fails mid-sentence.
 */
export class HistoryStore {
  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  audioPath(id: string): string {
    return path.join(this.dir, id, "audio.wav");
  }

  create(): { entry: HistoryEntry; wav: WavWriter } {
    const now = new Date();
    const id = `${now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}`;
    fs.mkdirSync(path.join(this.dir, id), { recursive: true });
    const entry: HistoryEntry = { id, createdAt: now.toISOString(), durationMs: 0, status: "recording", transcripts: [] };
    this.save(entry);
    return { entry, wav: new WavWriter(this.audioPath(id)) };
  }

  save(entry: HistoryEntry): void {
    const target = path.join(this.dir, entry.id, "entry.json");
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
    fs.renameSync(tmp, target); // atomic: a crash never leaves a half-written entry
  }

  get(id: string): HistoryEntry | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dir, id, "entry.json"), "utf8"));
    } catch {
      return null;
    }
  }

  list(): HistoryEntry[] {
    const out: HistoryEntry[] = [];
    for (const id of fs.readdirSync(this.dir)) {
      const e = this.get(id);
      if (e) out.push(e);
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  delete(id: string): void {
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
  }

  /** Entries left mid-flight by a crash or restart: fix the WAV header and mark them for a retry. */
  recover(): HistoryEntry[] {
    const recovered: HistoryEntry[] = [];
    for (const e of this.list()) {
      if (e.status !== "recording" && e.status !== "transcribing") continue;
      const bytes = WavWriter.repair(this.audioPath(e.id));
      e.durationMs = Math.round(bytes / 48);
      e.status = "failed";
      e.error = "Приложение закрылось до конца распознавания — аудио сохранено, можно распознать заново";
      this.save(e);
      recovered.push(e);
    }
    return recovered;
  }

  /** One-time import of recordings made by the first (WinForms) prototype. */
  importLegacy(legacyDir: string): number {
    const marker = path.join(this.dir, ".legacy-imported");
    if (fs.existsSync(marker) || !fs.existsSync(legacyDir)) return 0;
    let n = 0;
    for (const name of fs.readdirSync(legacyDir).filter((f) => f.endsWith(".json"))) {
      try {
        const old = JSON.parse(fs.readFileSync(path.join(legacyDir, name), "utf8"));
        if (old.outcome === "replay") continue; // synthetic test runs
        const base = name.replace(/\.json$/, "");
        const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(base);
        if (!m) continue;
        const created = new Date(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
        const text: string = old.delivered ?? old.final ?? old.live ?? "";
        const durationMs: number = old.release_ms ?? 0;
        if (!text.trim() && durationMs < 1500) continue; // accidental taps
        const id = `${base}-v1`;
        fs.mkdirSync(path.join(this.dir, id), { recursive: true });
        const wav = path.join(legacyDir, `${base}.wav`);
        if (fs.existsSync(wav)) fs.copyFileSync(wav, this.audioPath(id));
        const [proc, ...title] = String(old.target ?? "").split(": ");
        this.save({
          id,
          createdAt: created.toISOString(),
          durationMs,
          status: text ? "done" : "failed",
          delivery: old.outcome === "pasted" ? "pasted" : old.outcome === "clipboard" ? "clipboard" : "none",
          target: { process: proc ?? "", title: title.join(": ") },
          error: old.error ?? undefined,
          transcripts: text
            ? [{ id: "t1", source: "live", model: old.model, delay: old.delay, text, createdAt: created.toISOString(), costUsd: (0.017 * durationMs) / 60000 }]
            : [],
          timings: {
            voiceOnsetMs: old.voice_onset_ms ?? undefined,
            firstTextMs: old.first_text_ms ?? undefined,
            finalAfterReleaseMs: old.completed_ms && old.release_ms ? old.completed_ms - old.release_ms : undefined,
          },
        });
        n++;
      } catch {
        // Skip unreadable leftovers.
      }
    }
    fs.writeFileSync(marker, new Date().toISOString());
    return n;
  }
}

/** Streams PCM16 into a WAV file; the header sizes are patched on close (or by repair after a crash). */
export class WavWriter {
  private fd: number;
  bytes = 0;

  constructor(readonly file: string) {
    this.fd = fs.openSync(file, "w");
    fs.writeSync(this.fd, wavHeader(0));
  }

  write(pcm: Uint8Array): void {
    if (this.fd < 0) return;
    fs.writeSync(this.fd, pcm);
    this.bytes += pcm.byteLength;
  }

  close(): void {
    if (this.fd < 0) return;
    fs.writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0);
    fs.closeSync(this.fd);
    this.fd = -1;
  }

  /** Rewrites the header from the actual file size; returns the PCM byte count. */
  static repair(file: string): number {
    try {
      const size = fs.statSync(file).size;
      const bytes = Math.max(0, size - 44);
      const fd = fs.openSync(file, "r+");
      fs.writeSync(fd, wavHeader(bytes), 0, 44, 0);
      fs.closeSync(fd);
      return bytes;
    } catch {
      return 0;
    }
  }

  /** Raw PCM of a saved recording (header skipped). */
  static readPcm(file: string): Buffer {
    return fs.readFileSync(file).subarray(44);
  }
}
