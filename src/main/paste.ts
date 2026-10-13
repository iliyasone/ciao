import { clipboard, ClipboardItem } from "electron";
import { occurrences, t3Prompt } from "../core/t3";
import type { InputHelper, PasteMiss } from "./input";

/** Every format currently on the clipboard, copied out so it can be put back later. */
async function snapshot(): Promise<ClipboardItem[] | null> {
  try {
    const items = await clipboard.read();
    return await Promise.all(
      items.map(async (item) => {
        const data: Record<string, Blob> = {};
        for (const type of item.types) {
          const value = await item.getType(type).catch(() => null);
          if (value instanceof Blob) data[type] = value;
        }
        return new ClipboardItem(data);
      }),
    );
  } catch {
    return null; // unreadable clipboard: don't risk restoring garbage
  }
}

async function restore(items: ClipboardItem[]): Promise<void> {
  try {
    if (items.length && items.some((i) => i.types.length)) await clipboard.write(items);
    else clipboard.clear();
  } catch {
    // Some exotic format could not be written back; the pasted text stays instead.
  }
}

// Chromium/Electron targets read the clipboard asynchronously after Ctrl+V, later still while busy
// (an agent streaming its answer); give them time.
const RESTORE_AFTER_MS = 1500;
/** Checking: how long the pasted text may take to show up in the field, and how often it is read. */
const LAND_MS = 1200;
const LAND_EVERY_MS = 150;

/** The clipboard as it was before a paste, waiting to be put back. */
let pending: { before: ClipboardItem[]; text: string; timer: ReturnType<typeof setTimeout> } | null = null;

/**
 * The clipboard to put back after this paste. While the last paste's restore is still waiting, the
 * clipboard holds that dictation, not the user's: take over what it was going to put back.
 */
async function takeSnapshot(): Promise<ClipboardItem[] | null> {
  if (!pending) return snapshot();
  clearTimeout(pending.timer);
  const { before } = pending;
  pending = null;
  return before;
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/** The clipboard now gets other text than the last paste's: that paste's restore must not put the old one over it. */
export function cancelRestore(): void {
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

/** Puts the old clipboard back, unless something else was copied since (the user, or the next paste). */
function restoreLater(before: ClipboardItem[], text: string, ms: number): void {
  const timer = setTimeout(async () => {
    if (pending?.timer === timer) pending = null;
    if (sameText(await clipboard.readText(), text)) await restore(before);
  }, ms);
  pending = { before, text, timer };
}

/**
 * Pastes `text` into `hwnd` via the clipboard. If the window is no longer in front,
 * nothing is typed anywhere and the text stays on the clipboard instead.
 */
export async function pasteText(
  input: InputHelper,
  text: string,
  hwnd: number,
  restoreClipboard: boolean,
): Promise<{ delivery: "pasted" } | { delivery: "clipboard"; miss: PasteMiss }> {
  const before = restoreClipboard ? await takeSnapshot() : (cancelRestore(), null);
  await clipboard.writeText(text);
  const r = await input.paste(hwnd);
  if (!r.ok) {
    const { ok: _, ...miss } = r;
    return { delivery: "clipboard", miss };
  }
  if (before) restoreLater(before, text, RESTORE_AFTER_MS);
  return { delivery: "pasted" };
}

/**
 * T3 Code windows whose chat box has been read in this run: there "no field" means focus is really
 * elsewhere. Elsewhere it may only mean the app doesn't show its fields (Electron on Linux without
 * desktop accessibility, or a T3 Code just started). Never 0, the window Wayland can't name.
 */
const readableWindows = new Set<number>();

/** How the T3 paste was checked: the text showed up; or the field can't be read, or changed in a way that tells nothing. */
export type T3Check = "landed" | "unreadable" | "unclear";

/**
 * T3 mode. The chat box is read before and after the paste:
 * - focus on a message rather than the chat box (and this window's box has been read before): nothing is pasted;
 * - the prefix and suffix go around the text only when the box is empty or can't be read (a prompt said in several holds gets them once);
 * - the text shows up in the box: pasted, and the old clipboard comes back at once;
 * - the box had text and is just as it was: a miss, and the text stays on the clipboard;
 * - anything else (it can't be read, the window went, the box was sent and cleared): pasted, but the
 *   text stays on the clipboard so it can't be lost.
 */
export async function pasteIntoT3(
  input: InputHelper,
  raw: string,
  affix: { prefix: string; suffix: string },
  hwnd: number,
  restoreClipboard: boolean,
): Promise<{ text: string } & ({ delivery: "pasted"; check: T3Check } | { delivery: "clipboard"; miss: PasteMiss })> {
  const before = restoreClipboard ? await takeSnapshot() : (cancelRestore(), null);
  let pre = await input.field(hwnd);
  const known = hwnd !== 0 && readableWindows.has(hwnd);
  if (pre.text === null && pre.reason === "no-field" && known) {
    await new Promise((resolve) => setTimeout(resolve, 250)); // focus may be just settling
    pre = await input.field(hwnd);
  }
  if (pre.text !== null && hwnd !== 0) readableWindows.add(hwnd);
  // An empty box, or one that can't be read, gets the prefix and suffix.
  const text = pre.text === null || !pre.text.trim() ? t3Prompt(raw, affix.prefix, affix.suffix) : raw;
  await clipboard.writeText(text);
  if (pre.text === null && pre.reason === "no-field" && known) return { text, delivery: "clipboard", miss: { reason: "no-field" } };
  const r = await input.paste(hwnd);
  if (!r.ok) {
    const { ok: _, ...miss } = r;
    return { text, delivery: "clipboard", miss };
  }
  if (pre.text === null) return { text, delivery: "pasted", check: "unreadable" };
  const baseline = occurrences(pre.text, text);
  let last: string | null = null;
  for (const until = Date.now() + LAND_MS; ; ) {
    await new Promise((resolve) => setTimeout(resolve, LAND_EVERY_MS));
    const now = await input.field(hwnd);
    last = now.text;
    if (now.text !== null && occurrences(now.text, text) > baseline) {
      if (before) restoreLater(before, text, 0);
      return { text, delivery: "pasted", check: "landed" };
    }
    if (now.text === null && now.reason === "focus-changed") break; // switched away: nothing more to see
    if (Date.now() >= until) break;
  }
  // A box that had text and still has just that: the paste went nowhere. (An empty box that is still
  // empty may have been sent at once, before any read saw the text.)
  if (pre.text.trim() && last === pre.text) return { text, delivery: "clipboard", miss: { reason: "not-in-field" } };
  return { text, delivery: "pasted", check: "unclear" };
}
