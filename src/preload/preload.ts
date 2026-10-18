import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HistoryEntry, OverlayState, Provider, RetryMode, Settings, SyncStatus, TermSuggestion, UpdateState, ProxyCheck } from "../core/types";

function on<A extends unknown[]>(channel: string, cb: (...args: A) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(...(args as A));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  /** "win32", "darwin", …: read by core/platform.ts. */
  platform: process.platform,
  overlay: {
    onState: (cb: (s: OverlayState) => void) => on("overlay:state", cb),
    /** gapMs: time since the previous delta — a long one means the speaker paused. */
    onDelta: (cb: (seq: number, text: string, gapMs: number) => void) => on("overlay:delta", cb),
    onRevise: (cb: (seq: number, text: string, gapMs: number) => void) => on("overlay:revise", cb),
    onFinal: (cb: (seq: number, text: string) => void) => on("overlay:final", cb),
    setInteractive: (on: boolean) => ipcRenderer.send("overlay:interactive", on),
    hidden: (seq: number) => ipcRenderer.send("overlay:hidden", seq),
    /** The user closed or used the card (it is folding now): a kept one is done with. */
    closed: (seq: number) => ipcRenderer.send("overlay:closed", seq),
    /** x/y: where the press was on screen; the window then follows the cursor until dragEnd. */
    dragStart: (mode: "move" | "resize", x: number, y: number) => ipcRenderer.send("overlay:drag-start", mode, x, y),
    dragEnd: () => ipcRenderer.send("overlay:drag-end"),
    resetPlacement: () => ipcRenderer.send("overlay:reset-placement"),
    copy: (text: string): Promise<void> => ipcRenderer.invoke("overlay:copy", text),
    openHistory: () => ipcRenderer.send("overlay:open-history"),
    /** Whether the pill stays on screen between dictations. */
    onPill: (cb: (on: boolean) => void) => on("overlay:pill", cb),
    /** The pill was clicked: start a hands-free dictation, or finish the one running. */
    pillClick: () => ipcRenderer.send("overlay:pill-click"),
    /** The card's Stop button: finish the dictation running (never starts one). */
    stop: () => ipcRenderer.send("overlay:stop"),
    /** Linux: what is drawn, in window pixels (the rest of the window lets clicks through). */
    setRegion: (rects: { x: number; y: number; width: number; height: number }[]) => ipcRenderer.send("overlay:region", rects),
    /** A card or a suggestion is up (true), or nothing but maybe the pill (false). */
    setBusy: (on: boolean) => ipcRenderer.send("overlay:busy", on),
    /** A word the user corrected in a pasted dictation, offered for the terms. */
    onSuggest: (cb: (s: TermSuggestion) => void) => on("overlay:suggest", cb),
    /** The answer to a suggestion: add the word to the terms, or don't offer it again. */
    answer: (s: TermSuggestion, add: boolean) => ipcRenderer.send("overlay:answer", s, add),
  },
  capture: {
    onStart: (cb: (seq: number) => void) => on("capture:start", cb),
    /** Play the start or stop sound (src/renderer/overlay/sounds.ts). */
    onSound: (cb: (kind: "start" | "stop") => void) => on("overlay:sound", cb),
    onStop: (cb: (seq: number) => void) => on("capture:stop", cb),
    /** The microphone chosen in Settings, by name ("" = the system's default). */
    onMic: (cb: (name: string) => void) => on("capture:mic", cb),
    chunk: (seq: number, pcm: ArrayBuffer) => ipcRenderer.send("capture:chunk", seq, pcm),
    stopped: (seq: number) => ipcRenderer.send("capture:stopped", seq),
    error: (seq: number, message: string) => ipcRenderer.send("capture:error", seq, message),
  },
  wake: {
    onEnable: (cb: (on: boolean) => void) => on("wake:enable", cb),
    chunk: (pcm: ArrayBuffer) => ipcRenderer.send("wake:chunk", pcm),
  },
  history: {
    list: (): Promise<HistoryEntry[]> => ipcRenderer.invoke("history:list"),
    remove: (id: string): Promise<void> => ipcRenderer.invoke("history:remove", id),
    /** provider: the service to use instead of the one in Settings. */
    retry: (id: string, mode: RetryMode, provider?: Provider): Promise<HistoryEntry> => ipcRenderer.invoke("history:retry", id, mode, provider),
    copy: (text: string): Promise<void> => ipcRenderer.invoke("history:copy", text),
    openFolder: (id?: string): Promise<void> => ipcRenderer.invoke("history:open-folder", id),
    /** Saves the user's own version of the text; resolves with the entry and the corrected words worth adding to the terms. */
    /** `base`: the id of the transcript that was edited. */
    edit: (id: string, base: string, text: string): Promise<{ entry: HistoryEntry; suggestions: { heard: string; fixed: string }[] }> =>
      ipcRenderer.invoke("history:edit", id, base, text),
    addTerm: (term: string): Promise<void> => ipcRenderer.invoke("history:add-term", term),
    onChanged: (cb: (entry: HistoryEntry) => void) => on("history:changed", cb),
    audioUrl: (id: string) => `ciao-audio://entry/${encodeURIComponent(id)}`,
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
    set: (s: Settings): Promise<Settings> => ipcRenderer.invoke("settings:set", s),
    onChanged: (cb: (s: Settings) => void) => on("settings:changed", cb),
    /** Terms or the prompt changed through sync, not in this window. */
    onSynced: (cb: (s: Settings) => void) => on("settings:synced", cb),
    /** config.json was edited outside Ciao and reloaded. */
    onReloaded: (cb: (s: Settings) => void) => on("settings:reloaded", cb),
    /** A corrected word was added to the terms from a suggestion. */
    onTermAdded: (cb: (term: string) => void) => on("settings:term-added", cb),
    hasApiKey: (provider: Provider): Promise<boolean> => ipcRenderer.invoke("settings:has-key", provider),
    /** Checks a proxy (src/main/proxy.ts). */
    checkProxy: (url: string): Promise<ProxyCheck> => ipcRenderer.invoke("settings:check-proxy", url),
    /** A key was saved, here or on another device (through sync). */
    onKeys: (cb: () => void) => on("settings:keys", cb),
    wakeAvailable: (): Promise<boolean> => ipcRenderer.invoke("settings:wake-available"),
    canBringForward: (): Promise<boolean> => ipcRenderer.invoke("settings:can-bring-forward"),
    setApiKey: (provider: Provider, key: string): Promise<void> => ipcRenderer.invoke("settings:set-key", provider, key),
    /** Waits for the next key, combo or mouse button (null if cancelled with Esc). */
    captureTrigger: (): Promise<string | null> => ipcRenderer.invoke("settings:capture-trigger"),
    /** macOS: whether Ciao has the Accessibility permission; null elsewhere (not needed). */
    accessibility: (): Promise<boolean | null> => ipcRenderer.invoke("settings:accessibility"),
    onAccessibility: (cb: (granted: boolean) => void) => on("settings:accessibility", cb),
    openAccessibility: (): Promise<void> => ipcRenderer.invoke("settings:open-accessibility"),
  },
  sync: {
    get: (): Promise<SyncStatus> => ipcRenderer.invoke("sync:get"),
    onStatus: (cb: (s: SyncStatus) => void) => on("sync:status", cb),
    /** Opens Google's sign-in in the browser; resolves once signed in (or not). */
    signIn: (): Promise<void> => ipcRenderer.invoke("sync:sign-in"),
    /** Forgets the account on this device; also cancels a sign-in still waiting in the browser. */
    signOut: (): Promise<void> => ipcRenderer.invoke("sync:sign-out"),
  },
  update: {
    get: (): Promise<UpdateState> => ipcRenderer.invoke("update:get"),
    onState: (cb: (s: UpdateState) => void) => on("update:state", cb),
    check: (): Promise<void> => ipcRenderer.invoke("update:check"),
    /** Downloads the found version, then the app restarts into it. */
    install: (): Promise<void> => ipcRenderer.invoke("update:install"),
    openNotes: (version: string): Promise<void> => ipcRenderer.invoke("update:open-notes", version),
  },
};

export type CiaoApi = typeof api;

contextBridge.exposeInMainWorld("ciao", api);
