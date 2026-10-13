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
const LAND_MS = 1500;
const LAND_EVERY_MS = 150;

/** The clipboard as it was before a paste, waiting to be put back (`running` once it is being put back). */
let pending: { before: ClipboardItem[]; text: string; timer: ReturnType<typeof setTimeout>; running?: Promise<void> } | null = null;

/**
 * The clipboard to put back after this paste. While the last paste's restore is still waiting, the
 * clipboard holds that dictation, not the user's: take over what it was going to put back. One
 * already under way is let finish first, so it can't land on top of this paste.
 */
async function takeSnapshot(): Promise<ClipboardItem[] | null> {
  if (pending?.running) await pending.running;
  if (!pending) return snapshot();
  clearTimeout(pending.timer);
  const { before } = pending;
  pending = null;
  return before;
}

const sameText = (a: string, b: string) => a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");

/** The clipboard now gets other text than the last paste's: that paste's restore must not put the old one over it. */
export async function cancelRestore(): Promise<void> {
  if (pending?.running) await pending.running;
  if (pending) clearTimeout(pending.timer);
  pending = null;
}

/** Puts the old clipboard back, unless something else was copied since (the user, or the next paste). */
function restoreLater(before: ClipboardItem[], text: string, ms: number): void {
  const entry: NonNullable<typeof pending> = {
    before,
    text,
    timer: setTimeout(() => {
      entry.running = (async () => {
        if (sameText(await clipboard.readText(), text)) await restore(before);
      })().finally(() => {
        if (pending === entry) pending = null;
      });
    }, ms),
  };
  pending = entry;
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
  const before = restoreClipboard ? await takeSnapshot() : (await cancelRestore(), null);
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
 * - the prefix and suffix go around the text when the box is empty or can't be read (a prompt said in several holds gets them once);
 * - the text shows up in the box: pasted, and the old clipboard comes back at once;
 * - nothing editable was focused (a click into the timeline blurs the box) in a window whose box has
 *   been read before: T3 Code itself sends such a paste to the chat box, so it is pasted and checked
 *   the same way; if no box turns up at all, it is a miss and the text stays on the clipboard;
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
  const before = restoreClipboard ? await takeSnapshot() : (await cancelRestore(), null);
  const pre = await input.field(hwnd);
  if (pre.text !== null && hwnd !== 0) readableWindows.add(hwnd);
  // Nothing focused where boxes read fine: watch for the box T3 Code moves the paste into.
  const unfocused = pre.text === null && pre.reason === "no-field" && hwnd !== 0 && readableWindows.has(hwnd);
  const text = pre.text === null || !pre.text.trim() ? t3Prompt(raw, affix.prefix, affix.suffix) : raw;
  await clipboard.writeText(text);
  const r = await input.paste(hwnd);
  if (!r.ok) {
    const { ok: _, ...miss } = r;
    return { text, delivery: "clipboard", miss };
  }
  if (pre.text === null && !unfocused) return { text, delivery: "pasted", check: "unreadable" };
  const baseline = pre.text === null ? 0 : occurrences(pre.text, text);
  let last: Awaited<ReturnType<InputHelper["field"]>> | null = null;
  for (const until = Date.now() + LAND_MS; ; ) {
    await new Promise((resolve) => setTimeout(resolve, LAND_EVERY_MS));
    last = await input.field(hwnd);
    if (last.text !== null && occurrences(last.text, text) > baseline) {
      if (before) restoreLater(before, text, 0);
      return { text, delivery: "pasted", check: "landed" };
    }
    if (last.text === null && last.reason === "focus-changed") break; // switched away: nothing more to see
    if (Date.now() >= until) break;
  }
  if (unfocused && last?.text === null && last.reason === "no-field") return { text, delivery: "clipboard", miss: { reason: "no-field" } };
  // A box that had text and still has just that: the paste went nowhere. (An empty box that is still
  // empty may have been sent at once, before any read saw the text.)
  if (pre.text?.trim() && last?.text === pre.text) return { text, delivery: "clipboard", miss: { reason: "not-in-field" } };
  return { text, delivery: "pasted", check: "unclear" };
}
