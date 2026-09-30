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
  /** System.Windows.Forms.Keys name of the push-to-talk key. */
  hotkey: string;
  /** The middle mouse button works like the hotkey (click = hands-free, hold = push-to-talk). */
  middleClick: boolean;
  /** Electron accelerator that pastes the last transcript again. */
  pasteLastHotkey: string;
  autoPaste: boolean;
  /** Put back whatever was on the clipboard after a successful paste. */
  restoreClipboard: boolean;
  showCost: boolean;
  openAtLogin: boolean;
  theme: Theme;
  /** Developer mode: show and change the recognizer delay level. */
  showDelay: boolean;
}

export type EntryStatus = "recording" | "transcribing" | "done" | "failed" | "cancelled";
export type Delivery = "pasted" | "clipboard" | "none";
export type TranscriptSource = "live" | "retry-live" | "retry-file";

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
  | "empty"; // nothing was said

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
  /** Set only in developer mode (Settings.showDelay). */
  delay?: Delay;
  /** Live connection dropped — audio is still recorded and will be transcribed from the file. */
  offline: boolean;
  message?: string;
}

export type RetryMode = "file" | "live";
