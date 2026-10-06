// Terms, the prompt and the API keys, synced between devices through a file in the user's Google
// Drive (src/main/sync.ts on the desktop, android/…/Sync.kt on the phone, which ports this file).
//
// Each device keeps the whole history it knows: every term ever added or removed, with the time
// of its last change. Merging two histories keeps the later change of each term, so a term added
// on the phone survives a save on the computer, and a removed one doesn't come back. The prompt,
// each key and the "sync keys" switch are single values: the later edit wins.
//
// The switch is synced too: turned off on one device, it stops every device from sending keys, and
// the file keeps none (each device still has its own).

export interface TermChange {
  term: string;
  /**
   * Epoch ms of the last add or remove. What a device had before it started syncing: 0 for the
   * user's own choices, -1 for an untouched default (initialState), which any real choice beats.
   */
  at: number;
  removed?: boolean;
}

export interface Stamped<T> {
  value: T;
  /** As TermChange.at. */
  at: number;
}

export interface SyncState {
  /** In display order; removed terms stay as tombstones. */
  terms: TermChange[];
  prompt: Stamped<string>;
  /** API keys by provider ("openai", "gemini"); "" for one removed. */
  keys: Record<string, Stamped<string>>;
  /** Whether keys go into the synced file. On by default. */
  syncKeys: Stamped<boolean>;
}

/** What a device has now: its settings and its API keys ("" or missing when it has none). */
export interface Local {
  keywords: string[];
  prompt: string;
  keys: Record<string, string>;
  syncKeys: boolean;
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
export function initialState(local: Local, defaults: { keywords: string[]; prompt: string; syncKeys: boolean }): SyncState {
  const { keywords, prompt } = local;
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
    keys: Object.fromEntries(
      Object.entries(local.keys)
        .filter(([, key]) => key)
        .map(([provider, key]) => [provider, { value: key, at: 0 }]),
    ),
    syncKeys: { value: local.syncKeys, at: local.syncKeys === defaults.syncKeys ? -1 : 0 },
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
 * Records the user's edit: terms added or removed since `state`, a changed prompt, key or switch,
 * stamped `now`. Returns null when nothing changed (a reorder alone isn't an edit).
 */
export function recordEdit(state: SyncState, local: Local, now: number): SyncState | null {
  const { prompt } = local;
  const next = normalizeTerms(local.keywords);
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
  const keys = { ...state.keys };
  for (const provider of new Set([...Object.keys(keys), ...Object.keys(local.keys)])) {
    const key = local.keys[provider] ?? "";
    if (key === (keys[provider]?.value ?? "")) continue;
    changed = true;
    keys[provider] = { value: key, at: now };
  }
  const promptChanged = prompt !== state.prompt.value;
  const switched = local.syncKeys !== state.syncKeys.value;
  if (!changed && !promptChanged && !switched) return null;
  return {
    terms,
    prompt: promptChanged ? { value: prompt, at: now } : state.prompt,
    keys,
    syncKeys: switched ? { value: local.syncKeys, at: now } : state.syncKeys,
  };
}

/** Of two changes to one term: the later; a removal on a tie, so every device ends up the same. */
function later(a: TermChange, b: TermChange): TermChange {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return b.removed && !a.removed ? b : a;
}

/** Of two values: the later; on a tie the greater, so every device ends up the same. */
function laterValue(a: Stamped<string>, b: Stamped<string>): Stamped<string> {
  if (a.at !== b.at) return a.at > b.at ? a : b;
  return a.value >= b.value ? a : b;
}

/**
 * Both histories in one: the later change of each term and value. Order: `local`'s, then new ones.
 * While keys aren't synced, `local` keeps its own and takes none from `remote`.
 */
export function mergeStates(local: SyncState, remote: SyncState): SyncState {
  const theirs = new Map(remote.terms.map((t) => [t.term, t]));
  const terms = local.terms.map((t) => {
    const other = theirs.get(t.term);
    theirs.delete(t.term);
    return other ? later(t, other) : t;
  });
  terms.push(...theirs.values());
  // On a tie, off: keys leave the file rather than spread.
  const [x, y] = [local.syncKeys, remote.syncKeys];
  const syncKeys = x.at !== y.at ? (x.at > y.at ? x : y) : x.value ? y : x;
  const keys = { ...local.keys };
  if (syncKeys.value) {
    for (const [provider, key] of Object.entries(remote.keys)) keys[provider] = keys[provider] ? laterValue(keys[provider], key) : key;
  }
  return { terms, prompt: laterValue(local.prompt, remote.prompt), keys, syncKeys };
}

/** What goes into the synced file: no keys while the switch is off. */
export function shared(state: SyncState): SyncState {
  return state.syncKeys.value ? state : { ...state, keys: {} };
}

/** Same content, whatever the order: nothing to upload or apply. */
export function sameState(a: SyncState, b: SyncState): boolean {
  const key = (s: SyncState) =>
    JSON.stringify([
      [...s.terms].sort((x, y) => (x.term < y.term ? -1 : x.term > y.term ? 1 : 0)).map((t) => [t.term, t.at, !!t.removed]),
      s.prompt.value,
      s.prompt.at,
      Object.entries(s.keys)
        .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
        .map(([provider, key]) => [provider, key.value, key.at]),
      s.syncKeys.value,
      s.syncKeys.at,
    ]);
  return key(a) === key(b);
}

/** The synced file's content. */
export function serializeState(state: SyncState): string {
  return JSON.stringify({ version: 1, terms: state.terms, prompt: state.prompt, keys: state.keys, syncKeys: state.syncKeys });
}

/**
 * The synced file read back; null if it isn't one (a newer format, or damaged). A file from before
 * keys were synced has no `keys` and no `syncKeys`: an untouched default then.
 */
export function parseState(text: string): SyncState | null {
  try {
    const raw = JSON.parse(text) as {
      version?: unknown;
      terms?: unknown;
      prompt?: { value?: unknown; at?: unknown };
      keys?: Record<string, { value?: unknown; at?: unknown }>;
      syncKeys?: { value?: unknown; at?: unknown };
    };
    if (raw.version !== 1 || !Array.isArray(raw.terms) || typeof raw.prompt?.value !== "string" || typeof raw.prompt.at !== "number") return null;
    const terms: TermChange[] = [];
    for (const t of raw.terms as Partial<TermChange>[]) {
      if (typeof t?.term !== "string" || typeof t.at !== "number" || !t.term.trim()) return null;
      terms.push(t.removed === true ? { term: t.term, at: t.at, removed: true } : { term: t.term, at: t.at });
    }
    const keys: Record<string, Stamped<string>> = {};
    if (raw.keys !== undefined) {
      if (typeof raw.keys !== "object" || raw.keys === null || Array.isArray(raw.keys)) return null;
      for (const [provider, k] of Object.entries(raw.keys)) {
        if (typeof k?.value !== "string" || typeof k.at !== "number") return null;
        keys[provider] = { value: k.value, at: k.at };
      }
    }
    let syncKeys: Stamped<boolean> = { value: true, at: -1 };
    if (raw.syncKeys !== undefined) {
      if (typeof raw.syncKeys?.value !== "boolean" || typeof raw.syncKeys.at !== "number") return null;
      syncKeys = { value: raw.syncKeys.value, at: raw.syncKeys.at };
    }
    return { terms, prompt: { value: raw.prompt.value, at: raw.prompt.at }, keys, syncKeys };
  } catch {
    return null;
  }
}
