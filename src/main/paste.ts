import { clipboard, ClipboardItem } from "electron";
import { fieldHas } from "../core/t3";
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

/** Puts the old clipboard back, unless something else was copied since (the user, or the next paste). */
function restoreLater(before: ClipboardItem[], text: string, ms: number): void {
  setTimeout(async () => {
    if ((await clipboard.readText()).replace(/\r\n/g, "\n") === text.replace(/\r\n/g, "\n")) await restore(before);
  }, ms);
}

/**
 * Whether the pasted text showed up in the focused field of `hwnd`: true, false (the field reads
 * fine but doesn't have it), or null (the field can't be read there, so nobody can tell).
 */
async function landed(input: InputHelper, hwnd: number, text: string): Promise<boolean | null> {
  let readable = false;
  for (const until = Date.now() + LAND_MS; ; ) {
    const r = await input.field(hwnd);
    if (r.text !== null) {
      readable = true;
      if (fieldHas(r.text, text)) return true;
    } else if (r.reason === "unsupported" || r.reason === "no-helper") {
      return null; // no field can be read here, ever
    }
    if (Date.now() >= until) return readable ? false : null;
    await new Promise((resolve) => setTimeout(resolve, LAND_EVERY_MS));
  }
}

/**
 * Pastes `text` into `hwnd` via the clipboard. If the window is no longer in front,
 * nothing is typed anywhere and the text stays on the clipboard instead.
 *
 * check (T3 mode): read the focused field after the paste. The text showed up: the old clipboard comes
 * back at once. The field reads fine but hasn't got it (focus was on a message, not the chat box): it
 * is a miss, and the text stays on the clipboard. The field can't be read: the text stays on the
 * clipboard too, so it is never lost; the old clipboard isn't put back.
 */
export async function pasteText(
  input: InputHelper,
  text: string,
  hwnd: number,
  restoreClipboard: boolean,
  check = false,
): Promise<{ delivery: "pasted" } | { delivery: "clipboard"; miss: PasteMiss }> {
  const before = restoreClipboard ? await snapshot() : null;
  await clipboard.writeText(text);
  const r = await input.paste(hwnd);
  if (!r.ok) {
    const { ok: _, ...miss } = r;
    return { delivery: "clipboard", miss };
  }
  if (check) {
    const ok = await landed(input, hwnd, text);
    if (ok === false) return { delivery: "clipboard", miss: { reason: "not-in-field" } };
    if (ok && before) restoreLater(before, text, 0);
    return { delivery: "pasted" };
  }
  if (before) restoreLater(before, text, RESTORE_AFTER_MS);
  return { delivery: "pasted" };
}
