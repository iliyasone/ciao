import { useSyncExternalStore } from "react";
import { STRINGS, type Strings } from "../core/i18n";
import type { Lang } from "../core/types";

// The interface language of this window: read once before the first render, then kept in sync
// with Settings, so switching it re-renders every open window without a restart.

let lang: Lang = "en";
const listeners = new Set<() => void>();

function set(next: Lang): void {
  if (next === lang) return;
  lang = next;
  document.documentElement.lang = next;
  for (const l of listeners) l();
}

/** Call (and await) before rendering. Never rejects: the overlay must render to capture audio. */
export async function loadLang(): Promise<void> {
  ciao.settings.onChanged((s) => set(s.language));
  try {
    lang = (await ciao.settings.get()).language;
  } catch (e) {
    console.warn("reading the language:", e);
  }
  document.documentElement.lang = lang;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useStrings(): Strings {
  return STRINGS[useSyncExternalStore(subscribe, () => lang)];
}
