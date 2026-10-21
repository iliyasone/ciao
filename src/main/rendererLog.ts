import type { WebContents } from "electron";

/**
 * Puts what a window's page goes through into ciao.log: its console warnings and errors, a crash, a
 * hang, a failed load. Without it a broken page leaves no trace (the overlay drew nothing and recorded
 * nothing, and the log only said the capture never stopped).
 */
export function logRenderer(wc: WebContents, name: string): void {
  wc.on("console-message", (e) => {
    if (e.level === "error") console.error(`${name}:`, e.message, `(${e.sourceId}:${e.lineNumber})`);
    else if (e.level === "warning") console.warn(`${name}:`, e.message, `(${e.sourceId}:${e.lineNumber})`);
  });
  wc.on("render-process-gone", (_e, d) => console.error(`${name}: page gone:`, d.reason, `exit code ${d.exitCode}`));
  wc.on("unresponsive", () => console.warn(`${name}: page not responding`));
  wc.on("responsive", () => console.log(`${name}: page responding again`));
  wc.on("did-fail-load", (_e, code, description, url) => console.error(`${name}: load failed:`, code, description, url));
  wc.on("preload-error", (_e, file, error) => console.error(`${name}: preload ${file}:`, error));
}
