import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app, net } from "electron";

// Anonymous usage counts, so we know how many people use Ciao and how much.
// Events carry a random install id and coarse facts (version, OS, a few on/off settings, how long
// a dictation was) — never text, audio, window titles or keys. See README → Telemetry.
// Same approach as T3 Code: PostHog's HTTP batch API, public project key, no SDK.

// A PostHog project key is public by design: it can only send events, not read them.
const KEY = process.env.CIAO_POSTHOG_KEY ?? "phc_v7UzA6jJYZNZa7e2RPbQJspyqUfQ6vAWmuLJCQ4hr2rV";
const HOST = process.env.CIAO_POSTHOG_HOST ?? "https://eu.i.posthog.com";
const FLUSH_MS = 5 * 60_000;
const MAX_QUEUED = 200;
const TIMEOUT_MS = 15_000;

interface Event {
  /** Lets PostHog drop a resent copy when a batch arrived but its response did not. */
  uuid: string;
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
    // Counts only: no person profiles in PostHog, just one anonymous id per install,
    // and no location looked up from the IP (the project also discards IPs).
    $process_person_profile: false,
    $geoip_disable: true,
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
    this.queue.push({ uuid: crypto.randomUUID(), event, timestamp: new Date().toISOString(), properties: { ...this.common, ...properties } });
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
    let sent = false;
    try {
      const res = await net.fetch(`${HOST}/batch/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: KEY, batch: batch.map((e) => ({ ...e, distinct_id })) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      await res.body?.cancel();
      // A 4xx other than 429 (a wrong key, a malformed event) won't get better on retry: drop the batch.
      if (res.status === 429 || res.status >= 500) this.requeue(batch);
      else if (!res.ok) console.warn(`telemetry: HTTP ${res.status}, dropped ${batch.length} events`);
      else sent = true;
    } catch {
      // Offline, blocked or timed out.
      this.requeue(batch);
    } finally {
      this.sending = false;
    }
    // Events captured while this batch was in flight; after a failure they wait for the timer.
    if (sent) void this.flush();
  }

  /** Keep the events for the next attempt, every FLUSH_MS or on the next event (bounded by MAX_QUEUED). */
  private requeue(batch: Event[]): void {
    this.queue.unshift(...batch);
    this.queue.splice(0, Math.max(0, this.queue.length - MAX_QUEUED));
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
