import { clipboard } from "electron";
import { level } from "../core/audio";
import { costUsd, pricePerMinute } from "../core/cost";
import { t } from "../core/i18n";
import { models, PROVIDERS } from "../core/providers";
import type { LiveSession } from "../core/realtime";
import type { Delivery, DictationOutcome, HistoryEntry, OverlayPhase, OverlayState, Settings, Transcript, TranscriptSource } from "../core/types";
import { WavWriter, type HistoryStore } from "./history";
import { cancelRestore, pasteIntoT3, pasteText, type T3Check } from "./paste";
import { transcribeFile, type SessionPool } from "./transcribe";
import type { ForegroundWindow, InputHelper, PasteMiss } from "./input";
import { endsWithStopPhrase, stripStopPhrase, stripWakeWord } from "../core/voiceCommands";
import { applyLayout, layout, PARAGRAPH_PAUSE_MS, type Pause } from "../core/liveLayout";
import { appLabel } from "../core/apps";
import { revisePauses } from "../core/revision";
import { isT3Code, occurrences, T3_PROCESS, t3Prompt } from "../core/t3";
import { isLoneModifierTrigger } from "../core/triggers";

/** What the controller needs from the overlay window. */
export interface OverlayPort {
  state(s: OverlayState): void;
  /** gapMs: time since the previous delta (a long gap = the speaker paused). */
  delta(seq: number, text: string, gapMs: number): void;
  /** The live text so far was revised (Gemini): show this instead. */
  revise(seq: number, text: string, gapMs: number): void;
  final(seq: number, text: string): void;
  startCapture(seq: number): void;
  stopCapture(seq: number): void;
  /** The short sound for "listening now" (start) or "done listening" (stop). */
  sound(kind: "start" | "stop"): void;
}

const TAP_MS = 350; // a shorter press is a tap: switch to hands-free (or drop it, see dropsTaps)
const SHOW_AFTER_MS = 150; // don't flash the overlay for Ctrl+C-style shortcuts
/** The start sound's length plus the mic's delay: the audio arriving meanwhile is silenced, so the sound isn't in the recording. */
const START_SOUND_MUTE_MS = 280;
/** A short press starts nothing (tapHandsFree off); otherwise it starts hands-free, in T3 mode too. */
const dropsTaps = (s: Settings) => !s.tapHandsFree;
/** T3 mode: how long the stop waits for T3 Code, just called forward, to be in front. */
const FORWARD_WAIT_MS = 400;
/** T3 mode, sending: after the text showed up in the box, so the editor has taken it in. */
const SEND_AFTER_MS = 150;
/** After a plain paste, before checking that a field had focus: the app needs a moment to take it in. */
const LANDED_CHECK_MS = 400;
/** T3 mode: when the paste wasn't seen landing, another look this much later. */
const RECHECK_MS = 1000;
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
  /** The trigger spec that started it ("RControlKey", "MButton", "Ctrl+Alt+Space"), "wake_word" or "pill" (a click on it). */
  trigger: string;
  ended_by: "release" | "press" | "stop_phrase" | "escape" | "mic_error";
  hands_free: boolean;
  /** Who transcribed it: "openai" or "gemini" (and with Gemini, whether smart mode was on). */
  provider: string;
  smart?: boolean;
  /** "live" = the streaming transcript, "file" = the saved audio re-sent after the live one failed, "none" = no transcript (Esc, mic error). */
  transcribed_by: "live" | "file" | "none";
  voice_onset_ms?: number;
  first_text_ms?: number;
  final_after_release_ms?: number;
  /**
   * From the stop (release, press, stop phrase) until the text was pasted or put on the clipboard, or Ciao
   * gave up with none: how long the user waited. Also when the saved file had to be transcribed instead.
   */
  ready_after_release_ms?: number;
  cost_usd: number;
  /** The app it was meant for, from a closed list (core/apps.ts): "terminal", "vscode", … or "other". */
  target_app?: string;
  /** Why it was not pasted: "focus-changed", "no-target", "auto-paste-off", "no-injector" (Wayland without access to /dev/uinput),
   * "no-permission" (macOS: no Accessibility), or "no-helper" / "timeout" / "unknown" (helper failed). */
  paste_miss?: string;
  /** focus-changed: the app in front instead, whether the target window was closed or left on another desktop. */
  switched_to_app?: string;
  /** The text went to the window in front when the dictation was stopped, not the one it was started in. */
  target_moved?: boolean;
  target_closed?: boolean;
  target_on_other_desktop?: boolean;
}

interface Active {
  seq: number;
  entry: HistoryEntry;
  wav: WavWriter;
  session: LiveSession;
  settings: Settings;
  apiKey: string;
  startedAt: number;
  releasedAt?: number;
  target: Promise<ForegroundWindow | null>;
  /** The window in front when the dictation was stopped: where the text goes (see stop()). */
  stopTarget?: Promise<ForegroundWindow | null>;
  /** The start sound played (so the stop one plays too). */
  beeped?: boolean;
  /** Mic audio arriving until then is silenced: the start sound playing. */
  muteUntil?: number;
  /** T3 mode, hands-free from a tap: T3 Code comes forward once the first words are transcribed. */
  forwardOnVoice?: boolean;
  /** T3 mode: T3 Code is being called forward; true once a window was. */
  forwarded?: Promise<boolean>;
  targetMoved?: boolean;
  phase: "recording" | "finishing";
  shown: boolean;
  liveText: string;
  final?: string;
  completedAt?: number;
  /** The text was pasted or put on the clipboard. */
  deliveredAt?: number;
  offline: string | null;
  /** Started by the wake word; its audio (with "чао") was prepended. */
  wakeStarted?: boolean;
  /** Finished by saying "чао-чао"; strip it from the text. */
  stoppedByPhrase?: boolean;
  /** Fed from a file by --replay: no mic, nothing pasted. */
  replay: boolean;
  /** The input helper was told to pause the music; it is told to resume it when the recording ends. */
  pausedMedia?: boolean;
  /** Was in hands-free mode when it stopped (the controller's flag moves on to the next dictation). */
  handsFree?: boolean;
  /** What started it: a trigger spec or "wake_word". */
  trigger: string;
  endedBy?: DictationReport["ended_by"];
  miss?: PasteMiss;
  /** T3 mode: the chat box as read before the paste (null: unreadable). */
  boxBefore?: string | null;
  /** T3 mode: how the paste was checked (src/main/paste.ts). */
  check?: T3Check;
  /** T3 mode, Enter pressed: the box gave the text up (false: it stayed; null: the box couldn't be read after). */
  sent?: boolean | null;
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
  /** The card kept with text that may not have landed, until it is closed or used: a dropped dictation brings it back. */
  private kept: { state: OverlayState; text: string } | null = null;

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
      /** The text was pasted into `hwnd`, or (null) left on the clipboard: watch for the user's corrections. */
      delivered: (text: string, hwnd: number | null) => void;
      /** A dictation started (whatever was being watched is done). */
      started: () => void;
      /** Recording or not, hands-free or not, changed (for other apps: state.json). */
      stateChanged: (recording: boolean, handsFree: boolean) => void;
      /** The window is one of Ciao's own (History, Settings). */
      isOwnWindow: (hwnd: number) => boolean;
    },
  ) {}

  // ── Keyboard and mouse ──────────────────────────────────────────────────
  // Right Ctrl and the middle mouse button share one state machine:
  // hold = push-to-talk, a short press = hands-free until the next press (or nothing, see dropsTaps).

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
      // Off: a press too short to be speech (an accidental click) leaves nothing behind.
      if (dropsTaps(a.settings)) return this.cancel(false);
      this.handsFree = true;
      this.push(a);
    } else {
      this.stop();
    }
  }

  /** A click on the pill: start a hands-free dictation, or finish the one running. */
  onPillClick(): void {
    const a = this.active;
    if (!a) {
      this.start(false, "pill");
      const b = this.current();
      if (!b) return;
      this.handsFree = true;
      b.shown = true; // a click is no shortcut to rule out
      this.push(b);
    } else if (a.phase === "recording") {
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

  /** live: from the mic now (not the wake word's pre-roll), so the start sound's moment may be silenced. */
  onChunk(seq: number, pcm: Uint8Array, live = true): void {
    const a = this.active;
    if (!a || a.seq !== seq) return;
    if (live && a.muteUntil !== undefined && Date.now() <= a.muteUntil) pcm = new Uint8Array(pcm.byteLength);
    a.wav.write(pcm); // disk first: the recording survives any failure below
    if (!a.offline) a.session.append(pcm);
    if (a.voiceOnsetAt === undefined && level(pcm) > VOICE_LEVEL) a.voiceOnsetAt = Date.now();
  }

  /** T3 mode, hands-free from a tap: the first words are in (or the final text, if it stopped first), so T3 Code comes forward now. */
  private forwardNow(a: Active): void {
    if (!a.forwardOnVoice) return;
    a.forwardOnVoice = false;
    a.forwarded = this.bringT3Forward(a);
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
    if (preRoll.byteLength) this.onChunk(a.seq, preRoll, false);
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
    if (r?.delivery !== "pasted") {
      await cancelRestore();
      await clipboard.writeText(text);
    }
    this.deps.delivered(text, r?.delivery === "pasted" ? target!.hwnd : null);
  }

  /** The latest dictation's text was edited in History: Paste last pastes that. */
  setLastText(text: string): void {
    this.lastText = text;
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
      this.kept = null;
      this.deps.overlay.state({ seq, phase: "saved", handsFree: false, startedAt: Date.now(), showCost: false, costPerMinuteUsd: 0, offline: true, message: t().errors.noApiKeyHint(PROVIDERS[settings.provider].name) });
      return;
    }
    this.deps.started();
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
        if (a.firstTextAt !== undefined && a.phase === "recording") this.forwardNow(a);
        this.deps.overlay.delta(a.seq, text, gapMs);
        this.checkStopPhrase(a);
      },
      onRevise: (text) => {
        const now = Date.now();
        const gapMs = a.lastDeltaAt === undefined ? 0 : now - a.lastDeltaAt;
        a.pauses = revisePauses(a.liveText, text, a.pauses, gapMs).pauses;
        a.lastDeltaAt = now;
        a.liveText = text;
        if (a.firstTextAt === undefined && text.trim()) a.firstTextAt = now;
        if (a.firstTextAt !== undefined && a.phase === "recording") this.forwardNow(a);
        this.deps.overlay.revise(a.seq, text, gapMs);
        this.checkStopPhrase(a);
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
    // At once, so you hear that it listens; later only where the press may still turn out to be nothing:
    // a tap that is dropped, or a held Ctrl that becomes Ctrl+C (the card waits for the same reason).
    if (!replay && settings.sounds) {
      // The pill and the wake word can't turn out to be a dropped tap or a shortcut.
      const sure = trigger === "pill" || trigger === "wake_word";
      const delay = sure ? 0 : dropsTaps(settings) ? TAP_MS : isLoneModifierTrigger(trigger) ? SHOW_AFTER_MS : 0;
      const beep = () => {
        if (this.active !== a || a.phase !== "recording") return;
        a.beeped = true;
        // Not once you are speaking (after the wake word, or a late sound): no word may be lost to it.
        if (trigger !== "wake_word" && a.voiceOnsetAt === undefined) a.muteUntil = Date.now() + START_SOUND_MUTE_MS;
        this.deps.overlay.sound("start");
      };
      if (delay) setTimeout(beep, delay);
      else beep();
    }
    this.report();
    setTimeout(() => {
      if (this.active !== a || a.phase !== "recording") return;
      a.shown = true;
      this.push(a);
    }, dropsTaps(settings) ? TAP_MS : SHOW_AFTER_MS); // with taps dropped, a tap shows nothing at all
    // Only once it is clearly a dictation: a held Ctrl that turns into Ctrl+C (see onOtherKey), or a tap
    // dropped (see dropsTaps), doesn't stop the music for a moment.
    if (!replay && settings.pauseMedia)
      setTimeout(() => {
        if (this.active !== a || a.phase !== "recording") return;
        a.pausedMedia = true;
        this.deps.input.media(true);
      }, isLoneModifierTrigger(trigger) ? SHORTCUT_WINDOW_MS : TAP_MS);
    // T3 mode is for hands-free dictations (a tap, the wake word, the pill); a hold talks into the window
    // you are in. T3 Code comes forward on the chat it shows, so the text goes there when the dictation
    // ends. Not at once: until then a press may still be a hold, a dropped tap (tapHandsFree off), or a
    // held Ctrl turning into Ctrl+C. After a tap or the wake word, only once words come in (not just
    // noise, like keys clicking, or a false alarm): a stray one must not take the focus from your typing.
    if (!replay && settings.t3Mode && settings.t3Forward)
      setTimeout(() => {
        if (this.active !== a || a.phase !== "recording" || !this.handsFree) return;
        if (trigger !== "pill" && a.firstTextAt === undefined) a.forwardOnVoice = true;
        else a.forwarded = this.bringT3Forward(a);
      }, TAP_MS); // hands-free by then means the key was let go: no shortcut can claim it any more
  }

  /**
   * T3 Code to the front, unless it is there already (another T3 window or tab may be the one in use)
   * or the dictation was cancelled meanwhile. Whether a window was called forward.
   */
  private async bringT3Forward(a: Active): Promise<boolean> {
    const front = await this.deps.input.foreground();
    if ((front && isT3Code(front)) || !this.active || this.active.seq !== a.seq) return false;
    const hwnd = await this.deps.input.activate(T3_PROCESS);
    console.log("t3: brought forward", hwnd || "nothing");
    return hwnd !== 0;
  }

  /**
   * The window in front as the dictation stops. If T3 Code was just called forward, the window manager
   * may not have switched yet: wait for it a moment, so the text doesn't miss it.
   */
  private async stopTarget(a: Active): Promise<ForegroundWindow | null> {
    if (!a.forwarded || !(await a.forwarded)) return this.deps.input.foreground();
    let front = await this.deps.input.foreground();
    for (const until = Date.now() + FORWARD_WAIT_MS; !(front && isT3Code(front)) && Date.now() < until; ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      front = await this.deps.input.foreground();
    }
    return front;
  }

  /** Ciao quits: resume the music this dictation paused. True if there was any to resume. */
  quitting(): boolean {
    const a = this.active;
    if (!a?.pausedMedia) return false;
    this.resumeMedia(a);
    return true;
  }

  private resumeMedia(a: Active): void {
    if (!a.pausedMedia) return;
    a.pausedMedia = false;
    this.deps.input.media(false);
  }

  private checkStopPhrase(a: Active): void {
    if (this.handsFree && a.settings.stopPhrase && a.phase === "recording" && endsWithStopPhrase(a.liveText)) {
      a.stoppedByPhrase = true;
      this.stop();
    }
  }

  private stop(): void {
    const a = this.active;
    if (!a || a.phase !== "recording") return;
    a.phase = "finishing";
    a.releasedAt = Date.now();
    a.handsFree = this.handsFree;
    a.endedBy = a.stoppedByPhrase ? "stop_phrase" : this.handsFree ? "press" : "release";
    a.shown = true;
    // The text goes where you are when you stop, not where you started: people start talking, go to
    // the window the text is for, and stop there (mostly across virtual desktops, by the usage counts).
    a.stopTarget = this.stopTarget(a);
    this.deps.input.arm(false);
    this.resumeMedia(a);
    if (!a.replay) this.deps.overlay.stopCapture(a.seq);
    if (a.beeped) this.deps.overlay.sound("stop");
    this.push(a);
  }

  /** keep = true: Esc — the recording stays in history, untranscribed. false: it was a shortcut, drop it. */
  private cancel(keep: boolean, error?: string): void {
    const a = this.active;
    if (!a) return;
    console.log("dictation", a.entry.id, keep ? "cancelled" : "dropped", error ?? "", `${Date.now() - a.startedAt}ms`);
    if (keep) this.kept = null; // Esc or a mic error put their own card up: a kept one doesn't come back after
    this.active = null;
    this.deps.idle();
    this.deps.input.arm(false);
    this.resumeMedia(a);
    this.deps.overlay.stopCapture(a.seq);
    if (a.beeped) this.deps.overlay.sound("stop");
    this.report();
    a.session.close();
    a.wav.close();
    if (!keep) {
      this.deps.store.delete(a.entry.id);
      if (a.shown) this.emptyOrKept(a);
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
    const model = models(settings);
    entry.status = "transcribing";
    this.deps.store.save(entry);

    await this.waitForFinal(a);
    a.session.close();

    const now = new Date().toISOString();
    const add = (source: TranscriptSource, model: string, text: string) => {
      const t: Transcript = { id: `t${entry.transcripts.length + 1}`, source, model, text, createdAt: now, costUsd: costUsd(model, entry.durationMs) };
      if (source === "live" && settings.provider === "openai") t.delay = settings.delay;
      entry.transcripts.push(t);
    };

    // An empty final with live text shown (Gemini drops a last guess it didn't confirm) keeps the live text.
    let live = (a.final?.trim() ? a.final : a.liveText).trim();
    if (a.stoppedByPhrase) live = stripStopPhrase(live);
    if (a.wakeStarted) live = stripWakeWord(live);
    if (live || a.final !== undefined) add("live", model.live, live);

    let text: string | null = a.final !== undefined ? live : null;
    if (text === null) {
      // The live transcript never completed: transcribe the saved file instead.
      try {
        text = (await transcribeFile(a.apiKey, WavWriter.readPcm(this.deps.store.audioPath(entry.id)), settings)).trim();
        if (a.stoppedByPhrase) text = stripStopPhrase(text);
        if (a.wakeStarted) text = stripWakeWord(text);
        add("retry-file", model.file, text);
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

    // Gemini's smart mode often lays out paragraphs itself; leave its layout alone when it did.
    const laidOutByModel = settings.provider === "gemini" && settings.smart && !!text?.includes("\n");
    if (text && settings.formatText && !laidOutByModel) {
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
    let keep = false;
    let keptText = "";
    let keptHwnd = 0;
    if (!text) {
      if (entry.durationMs < 1500 && !entry.error) {
        console.log("dictation", entry.id, "dropped", "empty", `${entry.durationMs}ms`);
        this.deps.store.delete(entry.id); // an accidental tap, nothing worth keeping
        this.active = null;
        this.deps.idle();
        this.emptyOrKept(a);
        return;
      }
      entry.status = entry.error ? "failed" : "done";
      phase = entry.error ? "saved" : "empty";
    } else {
      this.deps.overlay.final(a.seq, text);
      // Stopped before the first words came in (a short prompt, or an offline session): there are words
      // now, so T3 Code comes forward before the paste looks for it.
      // Hands-free and stopped before the forward timer (0.35 s): forward now, the same way.
      if (settings.t3Mode && settings.t3Forward && a.handsFree && !a.forwarded && !a.replay) a.forwardOnVoice = true;
      if (a.forwardOnVoice) {
        // Nothing came forward (T3 Code isn't running, or is in front already): the window at the stop stands.
        const atStop = a.stopTarget;
        this.forwardNow(a);
        a.stopTarget = a.forwarded!.then((ok) => (ok || !atStop ? this.stopTarget(a) : atStop));
      }
      const target = await this.target(a);
      // A hold pastes where you are, T3 mode or not: T3 mode is for hands-free dictations.
      const t3 = settings.t3Mode && !!a.handsFree;
      /** What went to the window or the clipboard (with T3's prefix and suffix): what a kept card shows. */
      let sent = text;
      // Paste last gives the words alone: the prefix and suffix belong to T3 Code's chat box.
      this.lastText = text;
      if (a.replay) {
        delivery = "none";
      } else if (t3 && settings.autoPaste && target && !isT3Code(target) && !(target.hwnd === 0 && !target.process)) {
        // Never into another app. (A Wayland desktop names no window: there it pastes as usual.)
        const out = t3Prompt(text, settings.t3Prefix, settings.t3Suffix);
        sent = out;
        await cancelRestore();
        await clipboard.writeText(out);
        a.deliveredAt = Date.now();
        delivery = "clipboard";
        a.miss = { reason: "not-t3", foregroundProcess: target.process };
        this.deps.delivered(out, null);
      } else if (t3 && settings.autoPaste && target) {
        const r = await pasteIntoT3(this.deps.input, text, { prefix: settings.t3Prefix, suffix: settings.t3Suffix }, target.hwnd, settings.restoreClipboard);
        a.deliveredAt = r.pastedAt; // not the check that it landed, nor a send's pause
        delivery = r.delivery;
        sent = r.text;
        a.boxBefore = r.before;
        if (r.delivery === "clipboard") a.miss = r.miss;
        else a.check = r.check;
        // Sent only when the text is known to be in the box (never on a guess), into a window Ciao can
        // name (not on Wayland, where Enter would go to whatever is in front), and with no trigger held:
        // a held Right Ctrl would make it Ctrl+Enter, which T3 Code takes as steering the running turn.
        if (r.delivery === "pasted" && r.check === "landed" && settings.t3Send && target.hwnd !== 0 && !this.hotkeyDown) {
          await new Promise((resolve) => setTimeout(resolve, SEND_AFTER_MS));
          if (!this.hotkeyDown && (await this.deps.input.enter(target.hwnd))) {
            // Sent: the box gave the text up. (A T3 window under 640 px takes Enter as a new line.)
            await new Promise((resolve) => setTimeout(resolve, SEND_AFTER_MS));
            const box = await this.deps.input.field(target.hwnd);
            a.sent = box.text === null ? null : occurrences(box.text, r.text) === 0;
          }
        }
        this.deps.delivered(r.text, r.delivery === "pasted" ? target.hwnd : null);
      } else if (settings.autoPaste && target) {
        const r = await pasteText(this.deps.input, text, target.hwnd, settings.restoreClipboard);
        a.deliveredAt = Date.now();
        delivery = r.delivery;
        if (r.delivery === "clipboard") a.miss = r.miss;
        this.deps.delivered(text, r.delivery === "pasted" ? target.hwnd : null);
      } else {
        const out = t3 ? t3Prompt(text, settings.t3Prefix, settings.t3Suffix) : text;
        sent = out;
        await cancelRestore();
        await clipboard.writeText(out);
        a.deliveredAt = Date.now();
        delivery = "clipboard";
        a.miss = { reason: settings.autoPaste ? "no-target" : "auto-paste-off" };
        this.deps.delivered(out, null);
      }
      entry.status = "done";
      phase = delivery === "clipboard" ? "clipboard" : "done";
      // Not seen where it went: the card keeps the text in reach. A T3 paste the check couldn't see land
      // counts; a plain paste is checked after the card shows (checkLanded), so nothing waits on it.
      // Not when the clipboard was asked for (auto-paste off), nor for a T3 window whose box has never
      // read (Linux without accessibility): that would be every dictation.
      const unseen = a.check === "unclear" || (a.check === "unreadable" && !!target && this.deps.input.fieldsReadable(target.hwnd));
      if (!a.replay && ((delivery === "clipboard" && a.miss?.reason !== "auto-paste-off") || (delivery === "pasted" && unseen))) keep = true;
      else if (!a.replay && delivery === "pasted" && !t3 && target) void this.checkLanded(a, target, sent);
      keptText = sent.trim();
      keptHwnd = target?.hwnd ?? 0;
      if (keep && keptText !== text) this.deps.overlay.final(a.seq, keptText);
    }
    entry.delivery = delivery;
    // What happened, without the text: the only way to tell later why a dictation didn't show up.
    console.log("dictation", entry.id, entry.status, delivery, a.miss?.reason ?? a.check ?? "", a.sent === undefined ? "" : a.sent === null ? "enter" : a.sent ? "sent" : "not-sent", entry.target?.process ?? "", `${entry.durationMs}ms`);
    this.deps.store.save(entry);
    this.deps.changed(entry);
    this.ended(a, entry.status === "failed" ? "failed" : text && delivery !== "none" ? delivery : "empty");
    if (this.active === a) this.active = null;
    this.deps.idle();
    // Nothing said: a kept card from before comes back rather than folding away.
    if (phase === "empty" && this.kept) return this.emptyOrKept(a);
    this.kept = null;
    const state: OverlayState = {
      ...this.baseState(a),
      phase,
      keep,
      message:
        phase === "clipboard"
          ? missMessage(a.miss?.reason)
          : keep
            ? t().overlay.unconfirmed
          : phase === "saved"
            ? a.micError ? t().errors.microphone(a.micError) : t().overlay.saved
            : undefined,
    };
    this.deps.overlay.state(state);
    if (keep) {
      this.kept = { state, text: keptText };
      // T3 Code busy (an agent streaming) may take the paste in later than the check waited.
      if (delivery === "pasted" && a.boxBefore != null && keptHwnd) void this.recheckT3(a, keptHwnd, keptText, a.boxBefore);
    }
  }

  /**
   * After a plain paste: if nothing editable had focus (a click had left it on a page, a list, a
   * picture), the text went nowhere you can see. The card comes back with it, unless a new dictation
   * started. Only in windows whose fields have been read before (see InputHelper.fieldsReadable),
   * and not in terminals, which show no field but take the paste.
   */
  private async checkLanded(a: Active, target: ForegroundWindow, text: string): Promise<void> {
    if (appLabel(target.process) === "terminal") return;
    const readable = this.deps.input.fieldsReadable(target.hwnd);
    await new Promise((resolve) => setTimeout(resolve, LANDED_CHECK_MS));
    // Read either way: a first read that finds a field marks the window, so the next paste there is checked.
    const r = await this.deps.input.field(target.hwnd);
    if (!readable || r.text !== null || r.reason !== "no-field" || this.active || this.seq !== a.seq) return;
    console.log("dictation", a.entry.id, "pasted where no field had focus: card kept");
    // A card of its own: the done card may be folding, and its fold reporting it hidden would end this one too.
    const state: OverlayState = { ...this.baseState(a), seq: ++this.seq, phase: "done", keep: true, message: t().overlay.noFieldFocused };
    this.kept = { state, text };
    this.deps.overlay.state(state);
    this.deps.overlay.final(state.seq, text);
  }

  /**
   * A T3 paste the check couldn't see land: one more look a moment later, and the card folds if the text
   * shows up more often than in the box before the paste.
   */
  private async recheckT3(a: Active, hwnd: number, text: string, before: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, RECHECK_MS));
    const box = await this.deps.input.field(hwnd);
    if (box.text === null || occurrences(box.text, text) <= occurrences(before, text) || this.kept?.state.seq !== a.seq || this.active) return;
    console.log("dictation", a.entry.id, "landed after all: card folds");
    this.kept = null;
    this.deps.overlay.state({ ...this.baseState(a), phase: "done" });
  }

  /** A dictation that came to nothing: its card folds away, or gives the screen back to a kept one. */
  private emptyOrKept(a: Active): void {
    if (!this.kept) return this.deps.overlay.state({ ...this.baseState(a), phase: "empty" });
    this.deps.overlay.state(this.kept.state);
    this.deps.overlay.final(this.kept.state.seq, this.kept.text);
  }

  /** The renderer folded the card for `seq` away (closed, copied, dragged out, or done). */
  cardHidden(seq: number): void {
    if (this.kept?.state.seq === seq) this.kept = null;
  }

  /**
   * The window in front when the dictation was stopped, else the one it was started in (when there
   * was none to tell, see InputHelper.foreground, or it is Ciao's own: opening Settings mid-dictation
   * must not paste it all into the terms). Recorded in history as the dictation's window.
   */
  private async target(a: Active): Promise<ForegroundWindow | null> {
    const start = await a.target;
    let stop = a.stopTarget ? await a.stopTarget : null;
    if (stop && this.deps.isOwnWindow(stop.hwnd)) stop = null;
    if (!stop || !start || stop.hwnd === start.hwnd) return stop ?? start;
    a.targetMoved = !((a.forwarded ? await a.forwarded : false) && isT3Code(stop)); // not when Ciao itself brought T3 Code forward
    a.entry.target = { title: stop.title, process: stop.process };
    return stop;
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
      provider: a.settings.provider,
      smart: a.settings.provider === "gemini" ? a.settings.smart : undefined,
      // A partial live transcript is kept even when the saved file had to be transcribed instead.
      transcribed_by: entry.transcripts.some((x) => x.source === "retry-file") ? "file" : entry.transcripts.length ? "live" : "none",
      // A wake-word start begins with the audio since the word, so its onset is ~0 and means nothing.
      voice_onset_ms: a.wakeStarted ? undefined : timings?.voiceOnsetMs,
      first_text_ms: timings?.firstTextMs,
      final_after_release_ms: timings?.finalAfterReleaseMs,
      ready_after_release_ms: outcome !== "cancelled" && a.releasedAt ? (a.deliveredAt ?? Date.now()) - a.releasedAt : undefined,
      cost_usd: Math.round(entry.transcripts.reduce((sum, x) => sum + x.costUsd, 0) * 10_000) / 10_000,
      target_app: entry.target?.process ? appLabel(entry.target.process) : undefined,
      paste_miss: miss?.reason,
      switched_to_app: miss?.foregroundProcess ? appLabel(miss.foregroundProcess) : undefined,
      target_closed: miss?.targetExists === undefined ? undefined : !miss.targetExists,
      target_on_other_desktop: miss?.targetOnCurrentDesktop === undefined ? undefined : !miss.targetOnCurrentDesktop,
      target_moved: a.targetMoved,
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
      costPerMinuteUsd: pricePerMinute(models(a.settings).live),
      offline: a.offline !== null,
      delay: a.settings.showDelay && a.settings.provider === "openai" ? a.settings.delay : undefined,
      layout: a.settings.formatText,
    };
  }

  private push(a: Active): void {
    this.report();
    if (a.shown) this.deps.overlay.state(this.baseState(a));
  }

  private reported = { recording: false, handsFree: false };

  /** Tells other apps (state.json) when recording or hands-free changed. */
  private report(): void {
    if (this.active?.replay) return;
    const recording = this.active?.phase === "recording";
    const handsFree = recording && this.handsFree;
    if (recording === this.reported.recording && handsFree === this.reported.handsFree) return;
    this.reported = { recording, handsFree };
    this.deps.stateChanged(recording, handsFree);
  }
}

/** What the card says when the text went to the clipboard instead. */
function missMessage(reason: string | undefined): string {
  const o = t().overlay;
  if (reason === "no-permission") return o.noPermission;
  if (reason === "not-t3") return o.notT3;
  if (reason === "not-in-field") return o.notInField;
  if (reason === "no-field") return o.noField;
  return o.clipboard;
}
