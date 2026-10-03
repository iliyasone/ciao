import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, net } from "electron";

// Anonymous usage counts, so we know how many people use Ciao and how much.
// Events carry a random install id and coarse facts (version, OS, how long a dictation was) —
// never text, audio, window titles, keys or settings content. See README → Telemetry.
// Same approach as T3 Code: PostHog's HTTP batch API, public project key, no SDK.

// A PostHog project key is public by design: it can only send events, not read them.
const KEY = process.env.CIAO_POSTHOG_KEY ?? "phc_REPLACE_ME";
const HOST = process.env.CIAO_POSTHOG_HOST ?? "https://eu.i.posthog.com";
const FLUSH_MS = 5 * 60_000;
const MAX_QUEUED = 200;

interface Event {
  event: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export class Telemetry {
  private queue: Event[] = [];
  private sending = false;
  private id: string | null = null;
  private readonly common = {
    $lib: "ciao",
    app_version: app.getVersion(),
    os: process.platform,
    os_version: os.release(),
    arch: process.arch,
    // Counts only: no person profiles in PostHog, just one anonymous id per install.
    $process_person_profile: false,
  };

  /** enabled() is read on every event, so turning it off in Settings takes effect at once. */
  constructor(private readonly enabled: () => boolean) {
    setInterval(() => void this.flush(), FLUSH_MS).unref();
  }

  /** Off when developing from source (unless CIAO_TELEMETRY=1) and whenever CIAO_TELEMETRY=0. */
  static allowed(): boolean {
    const env = process.env.CIAO_TELEMETRY;
    if (env === "0" || env === "false") return false;
    return app.isPackaged || env === "1" || env === "true";
  }

  capture(event: string, properties: Record<string, unknown> = {}): void {
    if (!this.enabled()) return;
    this.queue.push({ event, timestamp: new Date().toISOString(), properties: { ...this.common, ...properties } });
    if (this.queue.length > MAX_QUEUED) this.queue.splice(0, this.queue.length - MAX_QUEUED);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.sending || !this.queue.length) return;
    if (!this.enabled()) {
      this.queue = [];
      return;
    }
    this.sending = true;
    const batch = this.queue.splice(0);
    const distinct_id = this.installId();
    try {
      const res = await net.fetch(`${HOST}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: KEY, batch: batch.map((e) => ({ ...e, distinct_id })) }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch {
      // Offline or blocked: keep the events for the next attempt (bounded by MAX_QUEUED).
      this.queue.unshift(...batch);
      this.queue.splice(0, Math.max(0, this.queue.length - MAX_QUEUED));
    } finally {
      this.sending = false;
    }
  }

  /** A random UUID made on first use and kept in userData; it says nothing about the machine or person. */
  private installId(): string {
    if (this.id) return this.id;
    const file = path.join(app.getPath("userData"), "telemetry-id");
    try {
      this.id = fs.readFileSync(file, "utf8").trim() || null;
    } catch {
      // First run.
    }
    if (!this.id) {
      this.id = crypto.randomUUID();
      try {
        fs.writeFileSync(file, this.id);
      } catch (e) {
        console.warn("telemetry id:", e);
      }
    }
    return this.id;
  }
}
