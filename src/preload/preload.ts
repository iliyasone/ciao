import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { HistoryEntry, OverlayState, Provider, RetryMode, Settings, SyncStatus, UpdateState } from "../core/types";

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
    dragStart: () => ipcRenderer.send("overlay:drag-start"),
    drag: (mode: "move" | "resize", dx: number, dy: number) => ipcRenderer.send("overlay:drag", mode, dx, dy),
    dragEnd: () => ipcRenderer.send("overlay:drag-end"),
    resetPlacement: () => ipcRenderer.send("overlay:reset-placement"),
    copy: (text: string): Promise<void> => ipcRenderer.invoke("overlay:copy", text),
    openHistory: () => ipcRenderer.send("overlay:open-history"),
  },
  capture: {
    onStart: (cb: (seq: number) => void) => on("capture:start", cb),
    onStop: (cb: (seq: number) => void) => on("capture:stop", cb),
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
    retry: (id: string, mode: RetryMode): Promise<HistoryEntry> => ipcRenderer.invoke("history:retry", id, mode),
    copy: (text: string): Promise<void> => ipcRenderer.invoke("history:copy", text),
    openFolder: (id?: string): Promise<void> => ipcRenderer.invoke("history:open-folder", id),
    onChanged: (cb: (entry: HistoryEntry) => void) => on("history:changed", cb),
    audioUrl: (id: string) => `ciao-audio://entry/${encodeURIComponent(id)}`,
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke("settings:get"),
    set: (s: Settings): Promise<Settings> => ipcRenderer.invoke("settings:set", s),
    onChanged: (cb: (s: Settings) => void) => on("settings:changed", cb),
    /** Terms or the prompt changed through sync, not in this window. */
    onSynced: (cb: (s: Settings) => void) => on("settings:synced", cb),
    hasApiKey: (provider: Provider): Promise<boolean> => ipcRenderer.invoke("settings:has-key", provider),
    wakeAvailable: (): Promise<boolean> => ipcRenderer.invoke("settings:wake-available"),
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
