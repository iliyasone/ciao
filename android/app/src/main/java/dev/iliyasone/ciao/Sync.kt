package dev.iliyasone.ciao

import org.json.JSONArray
import org.json.JSONObject

// Terms and the prompt, synced between devices; a port of src/core/sync.ts. Each device keeps every
// term ever added or removed with the time of its last change; merging keeps the later change of
// each term, so an added term survives a save elsewhere and a removed one doesn't come back. The
// prompt is one value: the later edit wins.

/**
 * [at]: epoch ms of the last add or remove. What a device had before it started syncing: 0 for the
 * user's own choices, -1 for an untouched default ([Sync.initialState]), which any real choice beats.
 */
data class TermChange(val term: String, val at: Long, val removed: Boolean = false)

data class Stamped(val value: String, val at: Long)

/** [terms] in display order; removed terms stay as tombstones. */
data class SyncState(val terms: List<TermChange>, val prompt: Stamped)

object Sync {
    /** Trimmed, without empty lines and repeats. */
    fun normalizeTerms(list: List<String>): List<String> = list.map { it.trim() }.filter { it.isNotEmpty() }.distinct()

    /**
     * What a device had before it synced: older than any edit made since. [defaultKeywords] and
     * [defaultPrompt] are this platform's defaults: kept as they are, they lose to anything another
     * device chose; a default term the user deleted stays deleted. Defaults differ by platform, so
     * a default term missing here is not a deletion.
     */
    fun initialState(keywords: List<String>, prompt: String, defaultKeywords: List<String>, defaultPrompt: String): SyncState {
        val terms = normalizeTerms(keywords)
        val own = terms.toSet()
        val isDefault = defaultKeywords.toSet()
        return SyncState(
            terms.map { TermChange(it, if (it in isDefault) -1 else 0) } +
                normalizeTerms(defaultKeywords).filter { it !in own }.map { TermChange(it, 0, removed = true) },
            Stamped(prompt, if (prompt == defaultPrompt) -1 else 0),
        )
    }

    /** The terms to use: the ones not removed, in order. */
    fun termsOf(state: SyncState): List<String> = state.terms.filter { !it.removed }.map { it.term }

    /**
     * Records the user's edit: terms added or removed since [state], and a changed prompt, stamped
     * [now]. Null when nothing changed (a reorder alone isn't an edit).
     */
    fun recordEdit(state: SyncState, keywords: List<String>, prompt: String, now: Long): SyncState? {
        val next = normalizeTerms(keywords)
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
        val promptChanged = prompt != state.prompt.value
        if (!changed && !promptChanged) return null
        return SyncState(terms, if (promptChanged) Stamped(prompt, now) else state.prompt)
    }

    /** Of two changes to one term: the later; a removal on a tie, so every device ends up the same. */
    private fun later(a: TermChange, b: TermChange): TermChange {
        if (a.at != b.at) return if (a.at > b.at) a else b
        return if (b.removed && !a.removed) b else a
    }

    /** Both histories in one: the later change of each term and of the prompt. Order: [local]'s, then new ones. */
    fun mergeStates(local: SyncState, remote: SyncState): SyncState {
        val theirs = LinkedHashMap<String, TermChange>()
        for (t in remote.terms) theirs[t.term] = t
        val terms = local.terms.map { t -> theirs.remove(t.term)?.let { later(t, it) } ?: t }.toMutableList()
        terms.addAll(theirs.values)
        val a = local.prompt
        val b = remote.prompt
        val prompt = if (a.at != b.at) (if (a.at > b.at) a else b) else if (a.value >= b.value) a else b
        return SyncState(terms, prompt)
    }

    /** Same content, whatever the order: nothing to upload or apply. */
    fun sameState(a: SyncState, b: SyncState): Boolean =
        a.terms.sortedBy { it.term }.map { Triple(it.term, it.at, it.removed) } == b.terms.sortedBy { it.term }.map { Triple(it.term, it.at, it.removed) } &&
            a.prompt == b.prompt

    /** The synced file's content. */
    fun serialize(state: SyncState): String = JSONObject()
        .put("version", 1)
        .put("terms", JSONArray().apply {
            for (t in state.terms) put(JSONObject().put("term", t.term).put("at", t.at).apply { if (t.removed) put("removed", true) })
        })
        .put("prompt", JSONObject().put("value", state.prompt.value).put("at", state.prompt.at))
        .toString()

    /** The synced file read back; null if it isn't one (a newer format, or damaged). */
    fun parse(text: String): SyncState? = runCatching {
        val raw = JSONObject(text)
        if (raw.optInt("version") != 1) return null
        val list = raw.getJSONArray("terms")
        val terms = (0 until list.length()).map { i ->
            val t = list.getJSONObject(i)
            val term = t.getString("term")
            if (term.isBlank()) return null
            TermChange(term, t.getLong("at"), t.optBoolean("removed"))
        }
        val p = raw.getJSONObject("prompt")
        SyncState(terms, Stamped(p.getString("value"), p.getLong("at")))
    }.getOrNull()
}
