import { clipboard } from "electron";
import { level } from "../core/audio";
import { costUsd, pricePerMinute } from "../core/cost";
import { t } from "../core/i18n";
import type { RealtimeSession } from "../core/realtime";
import type { Delivery, DictationOutcome, HistoryEntry, OverlayPhase, OverlayState, Settings, Transcript, TranscriptSource } from "../core/types";
import { WavWriter, type HistoryStore } from "./history";
import { pasteText } from "./paste";
import { transcribeFile, type SessionPool } from "./transcribe";
import type { ForegroundWindow, InputHelper, PasteMiss } from "./input";
import { endsWithStopPhrase, stripStopPhrase, stripWakeWord } from "../core/voiceCommands";
import { applyLayout, layout, PARAGRAPH_PAUSE_MS, type Pause } from "../core/liveLayout";
import { appLabel } from "../core/apps";

/** What the controller needs from the overlay window. */
export interface OverlayPort {
  state(s: OverlayState): void;
  /** gapMs: time since the previous delta (a long gap = the speaker paused). */
  delta(seq: number, text: string, gapMs: number): void;
  final(seq: number, text: string): void;
  startCapture(seq: number): void;
  stopCapture(seq: number): void;
}

const TAP_MS = 350; // a shorter press is a tap: switch to hands-free
const SHOW_AFTER_MS = 150; // don't flash the overlay for Ctrl+C-style shortcuts
const SHORTCUT_WINDOW_MS = 1000; // another key within this time = it was a shortcut, drop the recording
const COMPLETION_TIMEOUT_MS = 6000;
const VOICE_LEVEL = 600;

/**
 * One finished dictation as sent to anonymous usage counts (see README → Telemetry):
 * how it went, never what was said or which window titles were involved.
 */
export interface DictationReport {
  outcome: DictationOutcome;
  duration_s: number;
  /** The trigger spec that started it ("RControlKey", "MButton", "Ctrl+Alt+Space") or "wake_word". */
  trigger: string;
  ended_by: "release" | "press" | "stop_phrase" | "escape" | "mic_error";
  hands_free: boolean;
  /** "live" = the streaming transcript, "file" = the saved audio re-sent after the live one failed, "none" = no transcript (Esc, mic error). */
  transcribed_by: "live" | "file" | "none";
  voice_onset_ms?: number;
  first_text_ms?: number;
  final_after_release_ms?: number;
  cost_usd: number;
  /** The app it was meant for, from a closed list (core/apps.ts): "terminal", "vscode", … or "other". */
  target_app?: string;
  /** Why it was not pasted: "focus-changed", "no-target", "auto-paste-off", "no-injector" (Wayland without access to /dev/uinput),
   * "no-permission" (macOS: no Accessibility), or "no-helper" / "timeout" / "unknown" (helper failed). */
  paste_miss?: string;
  /** focus-changed: the app in front instead, whether the target window was closed or left on another desktop. */
  switched_to_app?: string;
  target_closed?: boolean;
  target_on_other_desktop?: boolean;
}

interface Active {
  seq: number;
  entry: HistoryEntry;
  wav: WavWriter;
  session: RealtimeSession;
  settings: Settings;
  apiKey: string;
  startedAt: number;
  releasedAt?: number;
  target: Promise<ForegroundWindow | null>;
  phase: "recording" | "finishing";
  shown: boolean;
  liveText: string;
  final?: string;
  completedAt?: number;
  offline: string | null;
  /** Started by the wake word; its audio (with "чао") was prepended. */
  wakeStarted?: boolean;
  /** Finished by saying "чао-чао"; strip it from the text. */
  stoppedByPhrase?: boolean;
  /** Fed from a file by --replay: no mic, nothing pasted. */
  replay: boolean;
  /** Was in hands-free mode when it stopped (the controller's flag moves on to the next dictation). */
  handsFree?: boolean;
  /** What started it: a trigger spec or "wake_word". */
  trigger: string;
  endedBy?: DictationReport["ended_by"];
  miss?: PasteMiss;
  /** The mic failed after the key was released (it was still opening); finish() reports it. */
  micError?: string;
  /** The renderer's capture ended (or failed): the WAV is closed and finish() has started. */
  captureEnded?: boolean;
  voiceOnsetAt?: number;
  firstTextAt?: number;
  lastDeltaAt?: number;
  /** Where the speaker paused, as offsets in liveText. */
  pauses: Pause[];
  settle?: () => void;
}

export class DictationController {
  private active: Active | null = null;
  private seq = 0;
  private handsFree = false;
  private hotkeyDown = false;
  private pressedAt = 0;
  private lastText: string | null = null;

  constructor(
    private readonly deps: {
      store: HistoryStore;
      pool: SessionPool;
      input: InputHelper;
      overlay: OverlayPort;
      settings: () => Settings;
      apiKey: () => string | null;
      changed: (entry: HistoryEntry) => void;
      /** A dictation ended (the wake-word detector starts afresh). */
      idle: () => void;
      /** A dictation that was kept in history ended; for anonymous usage counts. */
      ended: (report: DictationReport) => void;
    },
  ) {}

  // ── Keyboard and mouse ──────────────────────────────────────────────────
  // Right Ctrl and the middle mouse button share one state machine:
  // hold = push-to-talk, a short press = hands-free until the next press.

  onHotkey(down: boolean, spec = ""): void {
    const now = Date.now();
    if (down) {
      if (this.hotkeyDown) return;
      this.hotkeyDown = true;
      this.pressedAt = now;
      if (!this.active) this.start(false, spec);
      else if (this.active.phase === "recording" && this.handsFree) this.stop();
      return;
    }
    this.hotkeyDown = false;
    const a = this.active;
    if (a?.phase !== "recording" || this.handsFree) return;
    if (now - this.pressedAt < TAP_MS) {
      this.handsFree = true;
      this.push(a);
    } else {
      this.stop();
    }
  }

  onEscape(): void {
    if (this.active?.phase === "recording") this.cancel(true);
  }

  onOtherKey(): void {
    const a = this.active;
    if (a?.phase === "recording" && this.hotkeyDown && !this.handsFree && Date.now() - a.startedAt < SHORTCUT_WINDOW_MS) this.cancel(false);
  }

  // ── Audio from the overlay renderer ─────────────────────────────────────

  onChunk(seq: number, pcm: Uint8Array): void {
    const a = this.active;
    if (!a || a.seq !== seq) return;
    a.wav.write(pcm); // disk first: the recording survives any failure below
    if (!a.offline) a.session.append(pcm);
    if (a.voiceOnsetAt === undefined && level(pcm) > VOICE_LEVEL) a.voiceOnsetAt = Date.now();
  }

  onCaptureStopped(seq: number): void {
    const a = this.active;
    if (a?.seq === seq && a.phase === "finishing") this.captureEnded(a);
  }

  /** Runs once per dictation, on capture:stopped or on a mic error after release, whichever comes first. */
  private captureEnded(a: Active): void {
    if (a.captureEnded) return;
    a.captureEnded = true;
    a.wav.close();
    a.entry.durationMs = Math.round(a.wav.bytes / 48);
    if (!a.offline) a.session.commit();
    void this.finish(a);
  }

  onCaptureError(seq: number, message: string): void {
    const a = this.active;
    if (!a || a.seq !== seq) return;
    if (a.phase === "finishing") {
      // A slow mic can fail after the key was already released. If the renderer had not reported
      // capture:stopped yet, it never will (the failed capture is no longer active there).
      // An error arriving after finish() has passed its check is not shown.
      a.micError = message;
      this.captureEnded(a);
      return;
    }
    this.deps.overlay.state({ ...this.baseState(a), phase: "saved", message: t().errors.microphone(message) });
    this.cancel(true, t().errors.microphone(message));
  }

  /** The wake word was heard: start hands-free, beginning with the audio since the word. */
  onWake(preRoll: Uint8Array): void {
    if (this.active) return;
    this.start(false, "wake_word");
    const a = this.current();
    if (!a) return;
    a.wakeStarted = true;
    this.handsFree = true;
    if (preRoll.byteLength) this.onChunk(a.seq, preRoll);
    // No shortcut to rule out here (the 150 ms guard is for Ctrl+C-style key combos): show at once.
    a.shown = true;
    this.push(a);
  }

  // ── Paste the last transcript again (Alt+Shift+Z) ───────────────────────

  async pasteLast(): Promise<void> {
    const text = this.lastText ?? this.deps.store.list().find((e) => e.transcripts.length)?.transcripts.at(-1)?.text ?? null;
    if (!text) return;
    // Whatever is in front, unless there is nothing to paste into (see InputHelper.foreground).
    const target = await this.deps.input.foreground();
    const r = target ? await pasteText(this.deps.input, text, target.hwnd, this.deps.settings().restoreClipboard) : null;
    if (r?.delivery !== "pasted") await clipboard.writeText(text);
  }

  /** Test hook: plays a recording through the whole pipeline in real time (no mic, no paste). */
  async replay(pcm: Buffer): Promise<void> {
    if (this.active) return;
    this.start(true);
    const a = this.current();
    if (!a) return;
    const chunk = 1920; // 40 ms
    const t0 = Date.now();
    for (let i = 0; i < pcm.byteLength && this.current() === a; i += chunk) {
      this.onChunk(a.seq, pcm.subarray(i, i + chunk));
      await new Promise((r) => setTimeout(r, Math.max(0, t0 + ((i + chunk) / chunk) * 40 - Date.now())));
    }
    if (this.current() !== a) return;
    this.stop();
    this.onCaptureStopped(a.seq);
  }

  /** A fresh overlay sequence number for cards that aren't dictations (e.g. a recovered one). */
  nextSeq(): number {
    return ++this.seq;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /** Un-narrowed read of the active dictation (it changes across awaits). */
  private current(): Active | null {
    return this.active;
  }

  private start(replay = false, trigger = "replay"): void {
    const settings = this.deps.settings();
    const apiKey = this.deps.apiKey();
    const seq = ++this.seq;
    if (!apiKey) {
      this.deps.overlay.state({ seq, phase: "saved", handsFree: false, startedAt: Date.now(), showCost: false, costPerMinuteUsd: 0, offline: true, message: t().errors.noApiKeyHint });
      return;
    }
    const session = this.deps.pool.take()!;
    const { entry, wav } = this.deps.store.create();
    const a: Active = {
      seq, entry, wav, session, settings, apiKey,
      startedAt: Date.now(),
      target: this.deps.input.foreground(),
      phase: "recording",
      shown: false,
      liveText: "",
      pauses: [],
      offline: session.failure,
      replay,
      trigger,
    };
    this.active = a;
    this.handsFree = false;

    session.handlers = {
      onDelta: (text) => {
        const now = Date.now();
        const gapMs = a.lastDeltaAt === undefined ? 0 : now - a.lastDeltaAt;
        if (gapMs >= PARAGRAPH_PAUSE_MS && a.liveText.trim()) a.pauses.push({ at: a.liveText.length, ms: gapMs });
        a.lastDeltaAt = now;
        a.liveText += text;
        if (a.firstTextAt === undefined && text.trim()) a.firstTextAt = Date.now();
        this.deps.overlay.delta(a.seq, text, gapMs);
        if (this.handsFree && a.settings.stopPhrase && a.phase === "recording" && endsWithStopPhrase(a.liveText)) {
          a.stoppedByPhrase = true;
          this.stop();
        }
      },
      onCompleted: (text) => {
        a.final = text;
        a.completedAt = Date.now();
        a.settle?.();
      },
      onError: (message) => {
        a.offline = message;
        if (this.active === a) this.push(a);
        a.settle?.();
      },
    };
    session.configure(settings);

    void a.target.then((t) => {
      if (t) a.entry.target = { title: t.title, process: t.process };
    });
    this.deps.input.arm(true);
    if (!replay) this.deps.overlay.startCapture(seq);
    setTimeout(() => {
      if (this.active !== a || a.phase !== "recording") return;
      a.shown = true;
      this.push(a);
    }, SHOW_AFTER_MS);
  }

  private stop(): void {
    const a = this.active;
    if (!a || a.phase !== "recording") return;
    a.phase = "finishing";
    a.releasedAt = Date.now();
    a.handsFree = this.handsFree;
    a.endedBy = a.stoppedByPhrase ? "stop_phrase" : this.handsFree ? "press" : "release";
    a.shown = true;
    this.deps.input.arm(false);
    if (!a.replay) this.deps.overlay.stopCapture(a.seq);
    this.push(a);
  }

  /** keep = true: Esc — the recording stays in history, untranscribed. false: it was a shortcut, drop it. */
  private cancel(keep: boolean, error?: string): void {
    const a = this.active;
    if (!a) return;
    this.active = null;
    this.deps.idle();
    this.deps.input.arm(false);
    this.deps.overlay.stopCapture(a.seq);
    a.session.close();
    a.wav.close();
    if (!keep) {
      this.deps.store.delete(a.entry.id);
      if (a.shown) this.deps.overlay.state({ ...this.baseState(a), phase: "empty" });
      return;
    }
    a.entry.durationMs = Math.round(a.wav.bytes / 48);
    a.entry.status = error ? "failed" : "cancelled";
    a.entry.error = error;
    this.deps.store.save(a.entry);
    this.deps.changed(a.entry);
    a.endedBy = error ? "mic_error" : "escape";
    this.ended(a, error ? "failed" : "cancelled");
    if (!error) this.deps.overlay.state({ ...this.baseState(a), phase: "empty", message: t().overlay.cancelled });
  }

  private waitForFinal(a: Active): Promise<void> {
    if (a.final !== undefined || a.offline) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, COMPLETION_TIMEOUT_MS);
      a.settle = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async finish(a: Active): Promise<void> {
    const { entry, settings } = a;
    entry.status = "transcribing";
    this.deps.store.save(entry);

    await this.waitForFinal(a);
    a.session.close();

    const now = new Date().toISOString();
    const add = (source: TranscriptSource, model: string, text: string) => {
      const t: Transcript = { id: `t${entry.transcripts.length + 1}`, source, model, text, createdAt: now, costUsd: costUsd(model, entry.durationMs) };
      if (source === "live") t.delay = settings.delay;
      entry.transcripts.push(t);
    };

    let live = (a.final ?? a.liveText).trim();
    if (a.stoppedByPhrase) live = stripStopPhrase(live);
    if (a.wakeStarted) live = stripWakeWord(live);
    if (live || a.final !== undefined) add("live", settings.liveModel, live);

    let text: string | null = a.final !== undefined ? live : null;
    if (text === null) {
      // The live transcript never completed: transcribe the saved file instead.
      try {
        text = (await transcribeFile(a.apiKey, WavWriter.readPcm(this.deps.store.audioPath(entry.id)), settings)).trim();
        if (a.stoppedByPhrase) text = stripStopPhrase(text);
        if (a.wakeStarted) text = stripWakeWord(text);
        add("retry-file", settings.fileModel, text);
      } catch (e) {
        entry.error = t().errors.fileFailed(a.offline ?? t().errors.noFinalText, (e as Error).message);
        text = live || null;
      }
    }

    entry.timings = {
      voiceOnsetMs: a.voiceOnsetAt && a.voiceOnsetAt - a.startedAt,
      firstTextMs: a.firstTextAt && a.firstTextAt - a.startedAt,
      finalAfterReleaseMs: a.completedAt && a.releasedAt && a.completedAt - a.releasedAt,
    };

    if (text && settings.formatText) {
      // Same rules as the live card. Pause offsets refer to the live text; they carry over when the
      // final text contains the same words (possibly without a leading "чао" or trailing "чао-чао").
      const lead = a.liveText.length - a.liveText.trimStart().length;
      const shift = a.liveText.trim().toLowerCase().indexOf(text.toLowerCase());
      const pauses = shift < 0 ? [] : a.pauses.map((p) => ({ ...p, at: p.at - lead - shift })).filter((p) => p.at > 0 && p.at < text!.length);
      const laidOut = applyLayout(text, layout(text, pauses));
      if (laidOut !== text) {
        entry.transcripts.push({ id: `t${entry.transcripts.length + 1}`, source: "formatted", model: "rules", text: laidOut, createdAt: now, costUsd: 0 });
        text = laidOut;
      }
    }

    if (a.micError && !text) {
      entry.error = t().errors.microphone(a.micError);
      a.endedBy = "mic_error";
    }

    let phase: OverlayPhase;
    let delivery: Delivery = "none";
    if (!text) {
      if (entry.durationMs < 1500 && !entry.error) {
        this.deps.store.delete(entry.id); // an accidental tap, nothing worth keeping
        this.active = null;
        this.deps.idle();
        this.deps.overlay.state({ ...this.baseState(a), phase: "empty" });
        return;
      }
      entry.status = entry.error ? "failed" : "done";
      phase = entry.error ? "saved" : "empty";
    } else {
      this.lastText = text;
      this.deps.overlay.final(a.seq, text);
      const target = await a.target;
      if (a.replay) {
        delivery = "none";
      } else if (settings.autoPaste && target) {
        const r = await pasteText(this.deps.input, text, target.hwnd, settings.restoreClipboard);
        delivery = r.delivery;
        if (r.delivery === "clipboard") a.miss = r.miss;
      } else {
        await clipboard.writeText(text);
        delivery = "clipboard";
        a.miss = { reason: settings.autoPaste ? "no-target" : "auto-paste-off" };
      }
      entry.status = "done";
      phase = delivery === "clipboard" ? "clipboard" : "done";
    }
    entry.delivery = delivery;
    this.deps.store.save(entry);
    this.deps.changed(entry);
    this.ended(a, entry.status === "failed" ? "failed" : text && delivery !== "none" ? delivery : "empty");
    if (this.active === a) this.active = null;
    this.deps.idle();
    this.deps.overlay.state({
      ...this.baseState(a),
      phase,
      message:
        phase === "clipboard"
          ? a.miss?.reason === "no-permission" ? t().overlay.noPermission : t().overlay.clipboard
          : phase === "saved"
            ? a.micError ? t().errors.microphone(a.micError) : t().overlay.saved
            : undefined,
    });
  }

  private ended(a: Active, outcome: DictationOutcome): void {
    if (a.replay) return;
    const { entry, miss } = a;
    const timings = entry.timings;
    this.deps.ended({
      outcome,
      duration_s: Math.round(entry.durationMs / 1000),
      trigger: a.trigger,
      ended_by: a.endedBy ?? "release",
      hands_free: a.handsFree ?? this.handsFree,
      // A partial live transcript is kept even when the saved file had to be transcribed instead.
      transcribed_by: entry.transcripts.some((x) => x.source === "retry-file") ? "file" : entry.transcripts.length ? "live" : "none",
      // A wake-word start begins with the audio since the word, so its onset is ~0 and means nothing.
      voice_onset_ms: a.wakeStarted ? undefined : timings?.voiceOnsetMs,
      first_text_ms: timings?.firstTextMs,
      final_after_release_ms: timings?.finalAfterReleaseMs,
      cost_usd: Math.round(entry.transcripts.reduce((sum, x) => sum + x.costUsd, 0) * 10_000) / 10_000,
      target_app: entry.target?.process ? appLabel(entry.target.process) : undefined,
      paste_miss: miss?.reason,
      switched_to_app: miss?.foregroundProcess ? appLabel(miss.foregroundProcess) : undefined,
      target_closed: miss?.targetExists === undefined ? undefined : !miss.targetExists,
      target_on_other_desktop: miss?.targetOnCurrentDesktop === undefined ? undefined : !miss.targetOnCurrentDesktop,
    });
  }

  private baseState(a: Active): OverlayState {
    return {
      seq: a.seq,
      phase: a.phase,
      handsFree: this.handsFree,
      startedAt: a.startedAt,
      endedAt: a.releasedAt,
      showCost: a.settings.showCost,
      costPerMinuteUsd: pricePerMinute(a.settings.liveModel),
      offline: a.offline !== null,
      delay: a.settings.showDelay ? a.settings.delay : undefined,
      layout: a.settings.formatText,
    };
  }

  private push(a: Active): void {
    if (a.shown) this.deps.overlay.state(this.baseState(a));
  }
}
