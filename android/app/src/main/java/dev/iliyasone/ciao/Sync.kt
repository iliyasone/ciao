package dev.iliyasone.ciao

import org.json.JSONArray
import org.json.JSONObject

// Terms, the prompt and the API keys, synced between devices; a port of src/core/sync.ts. Each
// device keeps every term ever added or removed with the time of its last change; merging keeps the
// later change of each term, so an added term survives a save elsewhere and a removed one doesn't
// come back. The prompt, each key and the "sync keys" switch are single values: the later edit wins.
// The switch is synced too: turned off on one device, it stops every device from sending keys, and
// the file keeps none (each device still has its own).

/**
 * [at]: epoch ms of the last add or remove. What a device had before it started syncing: 0 for the
 * user's own choices, -1 for an untouched default ([Sync.initialState]), which any real choice beats.
 */
data class TermChange(val term: String, val at: Long, val removed: Boolean = false)

data class Stamped(val value: String, val at: Long)

data class Flag(val value: Boolean, val at: Long)

/**
 * [terms] in display order; removed terms stay as tombstones. [keys]: API keys by provider
 * ("openai", "gemini"), "" for one removed. [syncKeys]: whether keys go into the synced file.
 */
data class SyncState(
    val terms: List<TermChange>,
    val prompt: Stamped,
    val keys: Map<String, Stamped> = emptyMap(),
    val syncKeys: Flag = Flag(true, -1),
)

/** What a device has now: its settings and its API keys ("" or missing when it has none). */
data class Local(val keywords: List<String>, val prompt: String, val keys: Map<String, String>, val syncKeys: Boolean)

object Sync {
    /** Trimmed, without empty lines and repeats. */
    fun normalizeTerms(list: List<String>): List<String> = list.map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    /**
     * What a device had before it synced: older than any edit made since. [defaultKeywords] and
     * [defaultPrompt] are this platform's defaults: kept as they are, they lose to anything another
     * device chose; a default term the user deleted stays deleted. Defaults differ by platform, so
     * a default term missing here is not a deletion.
     */
    fun initialState(local: Local, defaultKeywords: List<String>, defaultPrompt: String, defaultSyncKeys: Boolean = true): SyncState {
        val prompt = local.prompt
        val terms = normalizeTerms(local.keywords)
        val own = terms.toSet()
        val isDefault = defaultKeywords.toSet()
        return SyncState(
            terms.map { TermChange(it, if (it in isDefault) -1 else 0) } +
                normalizeTerms(defaultKeywords).filter { it !in own }.map { TermChange(it, 0, removed = true) },
            Stamped(prompt, if (prompt == defaultPrompt) -1 else 0),
            local.keys.filterValues { it.isNotEmpty() }.mapValues { Stamped(it.value, 0) },
            Flag(local.syncKeys, if (local.syncKeys == defaultSyncKeys) -1 else 0),
        )
    }

    /**
     * Keys this device had before the history knew of keys (a history from an older Ciao): as old
     * as [initialState]'s, not an edit made now that would replace another device's key.
     */
    fun adoptKeys(state: SyncState, keys: Map<String, String>): SyncState {
        val known = keys.filter { (provider, key) -> key.isNotEmpty() && provider !in state.keys }
        if (known.isEmpty()) return state
        return state.copy(keys = state.keys + known.mapValues { Stamped(it.value, 0) })
    }

    /** The terms to use: the ones not removed, in order. */
    fun termsOf(state: SyncState): List<String> = state.terms.filter { !it.removed }.map { it.term }

    /**
     * The merged terms in the order the user keeps them (a reorder isn't synced): the ones they have
     * first, as they are, then new ones at the end.
     */
    fun arrangeTerms(current: List<String>, merged: List<String>): List<String> {
        val keep = merged.toSet()
        val kept = normalizeTerms(current).filter { it in keep }
        val have = kept.toSet()
        return kept + merged.filter { it !in have }
    }

    /**
     * Records the user's edit: terms added or removed since [state], a changed prompt, key or
     * switch, stamped [now]. Null when nothing changed (a reorder alone isn't an edit).
     */
    fun recordEdit(state: SyncState, local: Local, now: Long): SyncState? {
        val prompt = local.prompt
        val next = normalizeTerms(local.keywords)
        val wanted = next.toSet()
        var changed = false
        val terms = state.terms.map {
            val removed = it.term !in wanted
            if (removed == it.removed) it else TermChange(it.term, now, removed).also { changed = true }
        }.toMutableList()
        val known = state.terms.map { it.term }.toSet()
        for (term in next) {
            if (term !in known) {
                changed = true
                terms.add(TermChange(term, now))
            }
        }
        val keys = state.keys.toMutableMap()
        for (provider in state.keys.keys + local.keys.keys) {
            val key = local.keys[provider] ?: ""
            if (key == (keys[provider]?.value ?: "")) continue
            changed = true
            keys[provider] = Stamped(key, now)
        }
        val promptChanged = prompt != state.prompt.value
        val switched = local.syncKeys != state.syncKeys.value
        if (!changed && !promptChanged && !switched) return null
        return SyncState(
            terms,
            if (promptChanged) Stamped(prompt, now) else state.prompt,
            keys,
            if (switched) Flag(local.syncKeys, now) else state.syncKeys,
        )
    }

    /** Of two changes to one term: the later; a removal on a tie, so every device ends up the same. */
    private fun later(a: TermChange, b: TermChange): TermChange {
        if (a.at != b.at) return if (a.at > b.at) a else b
        return if (b.removed && !a.removed) b else a
    }

    /** Of two values: the later; on a tie the greater, so every device ends up the same. */
    private fun later(a: Stamped, b: Stamped): Stamped = if (a.at != b.at) (if (a.at > b.at) a else b) else if (a.value >= b.value) a else b

    /**
     * Both histories in one: the later change of each term and value. Order: [local]'s, then new
     * ones. While keys aren't synced, [local] keeps its own and takes none from [remote].
     */
    fun mergeStates(local: SyncState, remote: SyncState): SyncState {
        val theirs = LinkedHashMap<String, TermChange>()
        for (t in remote.terms) theirs[t.term] = t
        val terms = local.terms.map { t -> theirs.remove(t.term)?.let { later(t, it) } ?: t }.toMutableList()
        terms.addAll(theirs.values)
        // On a tie, off: keys leave the file rather than spread.
        val x = local.syncKeys
        val y = remote.syncKeys
        val syncKeys = if (x.at != y.at) (if (x.at > y.at) x else y) else if (x.value) y else x
        val keys = local.keys.toMutableMap()
        if (syncKeys.value) for ((provider, key) in remote.keys) keys[provider] = keys[provider]?.let { later(it, key) } ?: key
        return SyncState(terms, later(local.prompt, remote.prompt), keys, syncKeys)
    }

    /** What goes into the synced file: no keys while the switch is off. */
    fun shared(state: SyncState): SyncState = if (state.syncKeys.value) state else state.copy(keys = emptyMap())

    /** Same content, whatever the order: nothing to upload or apply. */
    fun sameState(a: SyncState, b: SyncState): Boolean =
        a.terms.sortedBy { it.term }.map { Triple(it.term, it.at, it.removed) } == b.terms.sortedBy { it.term }.map { Triple(it.term, it.at, it.removed) } &&
            a.prompt == b.prompt && a.keys == b.keys && a.syncKeys == b.syncKeys

    /** The synced file's content. */
    fun serialize(state: SyncState): String = JSONObject()
        .put("version", 1)
        .put("terms", JSONArray().apply {
            for (t in state.terms) put(JSONObject().put("term", t.term).put("at", t.at).apply { if (t.removed) put("removed", true) })
        })
        .put("prompt", JSONObject().put("value", state.prompt.value).put("at", state.prompt.at))
        .put("keys", JSONObject().apply { for ((provider, k) in state.keys) put(provider, JSONObject().put("value", k.value).put("at", k.at)) })
        .put("syncKeys", JSONObject().put("value", state.syncKeys.value).put("at", state.syncKeys.at))
        .toString()

    /**
     * The synced file read back; null if it isn't one (a newer format, or damaged). As strict about
     * types as the desktop, so both refuse the same files. A file from before keys were synced has
     * no `keys` and no `syncKeys`: an untouched default then.
     */
    fun parse(text: String): SyncState? = runCatching {
        val raw = JSONObject(text)
        if ((raw.opt("version") as? Number)?.toDouble() != 1.0) return null
        val list = raw.getJSONArray("terms")
        val terms = (0 until list.length()).map { i ->
            val t = list.getJSONObject(i)
            val term = t.opt("term") as? String ?: return null
            val at = t.opt("at") as? Number ?: return null
            if (term.isBlank()) return null
            TermChange(term, at.toLong(), t.opt("removed") == true)
        }
        val p = raw.getJSONObject("prompt")
        val value = p.opt("value") as? String ?: return null
        val at = p.opt("at") as? Number ?: return null
        val keys = LinkedHashMap<String, Stamped>()
        if (raw.has("keys")) {
            val k = raw.opt("keys") as? JSONObject ?: return null
            for (provider in k.keys()) {
                val entry = k.opt(provider) as? JSONObject ?: return null
                keys[provider] = Stamped(entry.opt("value") as? String ?: return null, (entry.opt("at") as? Number ?: return null).toLong())
            }
        }
        var syncKeys = Flag(true, -1)
        if (raw.has("syncKeys")) {
            val f = raw.opt("syncKeys") as? JSONObject ?: return null
            syncKeys = Flag(f.opt("value") as? Boolean ?: return null, (f.opt("at") as? Number ?: return null).toLong())
        }
        SyncState(terms, Stamped(value, at.toLong()), keys, syncKeys)
    }.getOrNull()
}
