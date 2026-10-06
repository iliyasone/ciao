// Terms and the prompt, synced between devices through a file in the user's Google Drive
// (src/main/sync.ts on the desktop, android/…/Sync.kt on the phone, which ports this file).
//
// Each device keeps the whole history it knows: every term ever added or removed, with the time
// of its last change. Merging two histories keeps the later change of each term, so a term added
// on the phone survives a save on the computer, and a removed one doesn't come back. The prompt is
// one value: the later edit wins.

export interface TermChange {
  term: string;
  /**
   * Epoch ms of the last add or remove. What a device had before it started syncing: 0 for the
   * user's own choices, -1 for an untouched default (initialState), which any real choice beats.
   */
  at: number;
  removed?: boolean;
}

export interface SyncState {
  /** In display order; removed terms stay as tombstones. */
  terms: TermChange[];
  prompt: { value: string; at: number };
}

/** Trimmed, without empty lines and repeats (the settings keep what's typed, blank lines included). */
export function normalizeTerms(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const term = raw.trim();
    if (term && !seen.has(term)) {
      seen.add(term);
      out.push(term);
    }
  }
  return out;
}

/**
 * What a device had before it synced: older than any edit made since. `defaults` are this
 * platform's defaults: kept as they are, they lose to anything another device chose (a fresh
 * install must not reset a custom prompt); a default term the user deleted stays deleted. Defaults
 * differ by platform, so a default term missing here is not a deletion.
 */
export function initialState(keywords: string[], prompt: string, defaults: { keywords: string[]; prompt: string }): SyncState {
  const terms = normalizeTerms(keywords);
  const own = new Set(terms);
  const isDefault = new Set(defaults.keywords);
  return {
    terms: [
      ...terms.map((term) => ({ term, at: isDefault.has(term) ? -1 : 0 })),
      ...normalizeTerms(defaults.keywords)
        .filter((term) => !own.has(term))
        .map((term) => ({ term, at: 0, removed: true })),
    ],
    prompt: { value: prompt, at: prompt === defaults.prompt ? -1 : 0 },
  };
}

/** The terms to use: the ones not removed, in order. */
export function termsOf(state: SyncState): string[] {
  return state.terms.filter((t) => !t.removed).map((t) => t.term);
}

/**
 * The merged terms in the order the user keeps them (a reorder isn't synced): the ones they have
 * first, as they are, then new ones at the end.
 */
export function arrangeTerms(current: string[], merged: string[]): string[] {
  const keep = new Set(merged);
  const kept = normalizeTerms(current).filter((term) => keep.has(term));
  const have = new Set(kept);
  return [...kept, ...merged.filter((term) => !have.has(term))];
}

/**
 * Records the user's edit: terms added or removed since `state`, and a changed prompt, stamped
 * `now`. Returns null when nothing changed (a reorder alone isn't an edit).
 */
export function recordEdit(state: SyncState, keywords: string[], prompt: string, now: number): SyncState | null {
  const next = normalizeTerms(keywords);
  const wanted = new Set(next);
  let changed = false;
  const terms = state.terms.map((t) => {
    const removed = !wanted.has(t.term);
    if (removed === !!t.removed) return t;
    changed = true;
    return removed ? { term: t.term, at: now, removed: true } : { term: t.term, at: now };
  });
  const known = new Set(state.terms.map((t) => t.term));
  for (const term of next) {
    if (!known.has(term)) {
      changed = true;
      terms.push({ term, at: now });
    }
  }
  const promptChanged = prompt !== state.prompt.value;
  if (!changed && !promptChanged) return null;
  return { terms, prompt: promptChanged ? { value: prompt, at: now } : state.prompt };
}

/** Of two changes to one term: the later; a removal on a tie, so every device ends up the same. */
function later(a: TermChange, b: TermChange): TermChange {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return b.removed && !a.removed ? b : a;
}

/** Both histories in one: the later change of each term and of the prompt. Order: `local`'s, then new ones. */
export function mergeStates(local: SyncState, remote: SyncState): SyncState {
  const theirs = new Map(remote.terms.map((t) => [t.term, t]));
  const terms = local.terms.map((t) => {
    const other = theirs.get(t.term);
    theirs.delete(t.term);
    return other ? later(t, other) : t;
  });
  terms.push(...theirs.values());
  const a = local.prompt;
  const b = remote.prompt;
  const prompt = a.at !== b.at ? (a.at > b.at ? a : b) : a.value >= b.value ? a : b;
  return { terms, prompt };
}

/** Same content, whatever the order: nothing to upload or apply. */
export function sameState(a: SyncState, b: SyncState): boolean {
  const key = (s: SyncState) =>
    JSON.stringify([
      [...s.terms].sort((x, y) => (x.term < y.term ? -1 : x.term > y.term ? 1 : 0)).map((t) => [t.term, t.at, !!t.removed]),
      s.prompt.value,
      s.prompt.at,
    ]);
  return key(a) === key(b);
}

/** The synced file's content. */
export function serializeState(state: SyncState): string {
  return JSON.stringify({ version: 1, terms: state.terms, prompt: state.prompt });
}

/** The synced file read back; null if it isn't one (a newer format, or damaged). */
export function parseState(text: string): SyncState | null {
  try {
    const raw = JSON.parse(text) as { version?: unknown; terms?: unknown; prompt?: { value?: unknown; at?: unknown } };
    if (raw.version !== 1 || !Array.isArray(raw.terms) || typeof raw.prompt?.value !== "string" || typeof raw.prompt.at !== "number") return null;
    const terms: TermChange[] = [];
    for (const t of raw.terms as Partial<TermChange>[]) {
      if (typeof t?.term !== "string" || typeof t.at !== "number" || !t.term.trim()) return null;
      terms.push(t.removed === true ? { term: t.term, at: t.at, removed: true } : { term: t.term, at: t.at });
    }
    return { terms, prompt: { value: raw.prompt.value, at: raw.prompt.at } };
  } catch {
    return null;
  }
}
