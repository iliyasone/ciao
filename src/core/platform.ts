// The OS this code runs on, in the main process and in renderers alike: renderers have no
// `process`, so the preload exposes the platform as `ciao.platform` before any page script runs.
const platform =
  typeof process !== "undefined" ? process.platform : (globalThis as { ciao?: { platform?: string } }).ciao?.platform;

export const isMac = platform === "darwin";
