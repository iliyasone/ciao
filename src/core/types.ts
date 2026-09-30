// Shared, platform-neutral types. Nothing here may import Electron or Node.

export type Delay = "minimal" | "low" | "medium" | "high" | "xhigh";
export type Theme = "system" | "light" | "dark";
export const DELAYS: Delay[] = ["minimal", "low", "medium", "high", "xhigh"];

export interface Settings {
  /** Streaming model used while you speak. */
  liveModel: string;
  delay: Delay;
  languages: string[];
  /** Free-form context for the recognizer. */
  prompt: string;
  /** Literal terms to get right (product names, identifiers). */
  keywords: string[];
  /** Model for "transcribe the whole recording again, more accurately". */
  fileModel: string;
  /**
   * Dictation triggers, in the native helper's syntax (see core/triggers.ts): hold = push-to-talk,
   * a short press = hands-free until the next press. Mouse buttons are swallowed while bound.
   */
  triggers: string[];
  /** Electron accelerator that pastes the last transcript again. */
  pasteLastHotkey: string;
  autoPaste: boolean;
  /** Put back whatever was on the clipboard after a successful paste. */
  restoreClipboard: boolean;
  showCost: boolean;
  openAtLogin: boolean;
  theme: Theme;
  /** Where the live card sits (window top-left); null = bottom-centre. Set by dragging its grip. */
  overlayPosition: { x: number; y: number } | null;
  overlayWidth: number;
  /** Developer mode: show and change the recognizer delay level. */
  showDelay: boolean;
  /** Paragraphs after long pauses and numbered lists for "первое… второе…", live and in the pasted text. */
  formatText: boolean;
  /** Saying "чао" starts a hands-free dictation (the mic stays open; detection is local). */
  wakeWord: boolean;
  /** In hands-free mode, saying "чао-чао" finishes the dictation (the words are not pasted). */
  stopPhrase: boolean;
}

export type EntryStatus = "recording" | "transcribing" | "done" | "failed" | "cancelled";
export type Delivery = "pasted" | "clipboard" | "none";
export type TranscriptSource = "live" | "retry-live" | "retry-file" | "formatted";

export interface Transcript {
  id: string;
  source: TranscriptSource;
  model: string;
  delay?: Delay;
  text: string;
  createdAt: string;
  costUsd: number;
}

export interface HistoryEntry {
  id: string;
  createdAt: string;
  durationMs: number;
  status: EntryStatus;
  delivery?: Delivery;
  target?: { title: string; process: string };
  error?: string;
  /** Oldest first; the last one is the current text. */
  transcripts: Transcript[];
  timings?: { voiceOnsetMs?: number; firstTextMs?: number; finalAfterReleaseMs?: number };
}

export type OverlayPhase =
  | "recording" // listening, live text streaming in
  | "finishing" // key released, waiting for the final transcript
  | "done" // pasted
  | "clipboard" // could not paste, text is on the clipboard
  | "saved" // could not transcribe, audio kept in history
  | "empty" // nothing was said
  | "recovered"; // a dictation cut short by a restart, transcribed from its saved audio

export interface OverlayState {
  /** Increments per dictation, so stale renderer messages can be ignored. */
  seq: number;
  phase: OverlayPhase;
  handsFree: boolean;
  /** Epoch ms; the timer runs in the renderer. */
  startedAt: number;
  endedAt?: number;
  showCost: boolean;
  costPerMinuteUsd: number;
  /** Lay the live text out in paragraphs and lists (Settings.formatText). */
  layout?: boolean;
  /** Set only in developer mode (Settings.showDelay). */
  delay?: Delay;
  /** Live connection dropped — audio is still recorded and will be transcribed from the file. */
  offline: boolean;
  message?: string;
}

export type RetryMode = "file" | "live";
