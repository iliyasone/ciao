package dev.iliyasone.ciao

// Pauses after the live text was revised rather than extended; a port of src/core/revision.ts.

object Revision {
    private val WORD = Regex("[\\p{L}\\p{N}]+")

    private class Word(val word: String, val start: Int)

    private fun words(text: String) = WORD.findAll(text).map { Word(it.value.lowercase(), it.range.first) }.toList()

    /** Where a pause goes before the word starting at [start]: on the space before it, as with a delta. */
    private fun before(text: String, start: Int): Int = if (start > 0 && text[start - 1].isWhitespace()) start - 1 else start

    /**
     * Gemini replaces its whole guess, and its final may rewrite the start ("Ну, привет." →
     * "Привет."). Each pause after the first change moves with the words that followed it (the next
     * two, or the next one), in order; one whose words are gone is dropped. A long gap before this
     * revision becomes a pause before its first new word. Also returns where the text starts to differ.
     */
    fun revisePauses(prev: String, next: String, pauses: List<Pause>, gapMs: Long): Pair<Int, List<Pause>> {
        var same = 0
        while (same < next.length && same < prev.length && next[same] == prev[same]) same++
        val kept = pauses.filter { it.at <= same }.toMutableList()

        val nextWords = words(next)
        val prevWords = words(prev)
        var from = nextWords.indexOfFirst { it.start >= same }
        if (from < 0) from = nextWords.size
        for (p in pauses) {
            if (p.at <= same) continue
            val after = prevWords.filter { it.start >= p.at }.map { it.word }
            for (n in intArrayOf(2, 1)) {
                if (after.size < n) continue
                val want = after.subList(0, n)
                val j = nextWords.indices.firstOrNull { i -> i >= from && want.indices.all { k -> nextWords.getOrNull(i + k)?.word == want[k] } } ?: continue
                val at = before(next, nextWords[j].start)
                if (at > 0) kept.add(Pause(at, p.ms))
                from = j + 1
                break
            }
        }

        if (same > 0 && gapMs >= LiveLayout.PARAGRAPH_PAUSE_MS) {
            val first = nextWords.firstOrNull { it.start >= same && it.start > 0 }
            if (first != null) {
                val at = before(next, first.start)
                if (kept.none { it.at == at }) kept.add(Pause(at, gapMs))
            }
        }
        kept.sortBy { it.at }
        return same to kept
    }
}
