import { clipboard, ClipboardItem } from "electron";
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

// Chromium/Electron targets read the clipboard asynchronously after Ctrl+V; give them time.
const RESTORE_AFTER_MS = 700;

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
  const before = restoreClipboard ? await snapshot() : null;
  await clipboard.writeText(text);
  const r = await input.paste(hwnd);
  if (!r.ok) {
    const { ok: _, ...miss } = r;
    return { delivery: "clipboard", miss };
  }
  if (before) setTimeout(() => void restore(before), RESTORE_AFTER_MS);
  return { delivery: "pasted" };
}
