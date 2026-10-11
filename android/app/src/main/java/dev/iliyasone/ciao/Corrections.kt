package dev.iliyasone.ciao

import java.text.Normalizer

// Words the user corrected in an inserted dictation; a port of src/core/corrections.ts (its comments
// say why each rule is there). CorrectionsTest holds the TypeScript outputs. Regex differences kept
// in mind: Android's regex engine is ICU, the unit tests run on the JVM's, so nothing here depends on
// where they differ: JS's \s is spelled out, ends are \z (`$` also matches before a final line
// break in both), and the Latin script is checked per code point, not with \p{Script=}.

/** [heard]: what recognition wrote; [fixed]: what the user changed it to, the term to suggest. */
data class Correction(val heard: String, val fixed: String)

object Corrections {
    private class Word(val text: String, val key: String, val start: Int, val end: Int)

    // A word may hold inner dots, hyphens, underscores, apostrophes and pluses: "Node.js", "gpt-5", "C++".
    private val WORD = Regex("[\\p{L}\\p{N}](?:[\\p{L}\\p{N}]|[.\\-_'’+](?=[\\p{L}\\p{N}+]))*\\+*")

    private fun nfc(text: String) = Normalizer.normalize(text, Normalizer.Form.NFC)

    private fun words(text: String) = WORD.findAll(nfc(text)).map { Word(it.value, it.value.lowercase(), it.range.first, it.range.last + 1) }.toList()

    private const val MAX_SPAN = 3
    private const val MIN_KEPT = 0.5
    private const val SHORT = 6
    private const val MAX_TERM_LENGTH = 40
    /** Longer dictations aren't compared: the alignment grows with the square of the length. */
    private const val MAX_WORDS = 1500
    /** Not terms, however they are spelled. */
    private val NOT_TERMS = setOf("ok", "ок", "okay", "окей")

    /**
     * The corrections between [inserted] (what Ciao put into the field) and [field] (its text now).
     * null: the inserted text is no longer there (sent, deleted, rewritten), so watching can stop.
     */
    fun find(insertedText: String, fieldText: String): List<Correction>? {
        // Offsets below index the texts as compared: composed ("й", not "и" + a combining mark).
        val inserted = nfc(insertedText)
        val field = nfc(fieldText)
        val a = words(inserted)
        val b = words(field)
        if (a.isEmpty()) return null
        val window = locate(a, b) ?: return null
        if (a.size > MAX_WORDS) return emptyList()
        val bw = b.subList(window.first, window.second)
        val ops = align(a, bw)
        val kept = ops.count { it.same }
        if (kept < (if (a.size < SHORT) 1 else Math.ceil(a.size * MIN_KEPT).toInt())) return null

        val found = mutableListOf<Correction>()
        val seen = HashSet<String>()
        fun add(heard: String, fixed: String) {
            if (seen.add(fixed.lowercase())) found.add(Correction(heard, fixed))
        }
        var i = 0
        while (i < ops.size) {
            val op = ops[i]
            if (op.same) {
                // A case-only change counts when it is a term's spelling: "Github" → "GitHub", "api" → "API".
                val was = a[op.a].text
                val now = bw[op.b].text
                if (was != now && looksLikeTerm(now) && !looksLikeTerm(was)) add(was, now)
                i++
                continue
            }
            // A run of changes between two unchanged words.
            var j = i
            val aIdx = mutableListOf<Int>()
            val bIdx = mutableListOf<Int>()
            while (j < ops.size && !ops[j].same) {
                if (ops[j].a >= 0) aIdx.add(ops[j].a)
                if (ops[j].b >= 0) bIdx.add(ops[j].b)
                j++
            }
            i = j
            if (aIdx.isEmpty() || bIdx.isEmpty() || aIdx.size > MAX_SPAN || bIdx.size > MAX_SPAN) continue
            val heard = inserted.substring(a[aIdx.first()].start, a[aIdx.last()].end)
            val fixed = field.substring(bw[bIdx.first()].start, bw[bIdx.last()].end)
            if (worthSuggesting(heard, fixed, sentenceStart(field, bw[bIdx.first()].start))) add(heard, fixed)
        }
        return found
    }

    /** Corrections that aren't terms already (compared without case). */
    fun newTerms(corrections: List<Correction>, terms: List<String>): List<Correction> {
        val known = terms.map { it.trim().lowercase() }.toSet()
        return corrections.filter { it.fixed.lowercase() !in known }
    }

    // ── Where in the field our text is ──────────────────────────────────────

    /** The stretch of the field's words to align with the inserted ones, as from..to. */
    private fun locate(a: List<Word>, b: List<Word>): Pair<Int, Int>? {
        for (n in intArrayOf(3, 2, 1)) {
            if (a.size < n) continue
            val at = HashMap<String, MutableList<Int>>()
            for (j in 0..b.size - n) at.getOrPut(gram(b, j, n)) { mutableListOf() }.add(j)
            val votes = LinkedHashMap<Int, Int>()
            for (i in 0..a.size - n) for (j in at[gram(a, i, n)].orEmpty()) votes[j - i] = (votes[j - i] ?: 0) + 1
            var best: Int? = null
            for ((offset, count) in votes) {
                val b0 = best
                if (b0 == null || count > votes[b0]!! || (count == votes[b0]!! && offset < b0)) best = offset
            }
            val found = best ?: continue
            // Room for words the user added or removed around and inside the text.
            val slack = Math.ceil(a.size / 2.0).toInt() + 10
            return maxOf(0, found - slack) to minOf(b.size, found + a.size + slack)
        }
        return null
    }

    private fun gram(w: List<Word>, i: Int, n: Int) = (i until i + n).joinToString(" ") { w[it].key }

    // ── Aligning words ──────────────────────────────────────────────────────

    /** [same]: the word is unchanged; otherwise a change, with a = -1 for an added word and b = -1 for a deleted one. */
    private class Op(val same: Boolean, val a: Int, val b: Int)

    /** Edit-distance alignment of all of [a] against a stretch of [b]; the field's words before and after our text are free. */
    private fun align(a: List<Word>, b: List<Word>): List<Op> {
        val n = a.size
        val m = b.size
        val w = m + 1
        val cost = IntArray((n + 1) * w)
        for (i in 1..n) cost[i * w] = i
        for (i in 1..n) {
            for (j in 1..m) {
                val sub = cost[(i - 1) * w + j - 1] + (if (a[i - 1].key == b[j - 1].key) 0 else 1)
                cost[i * w + j] = minOf(sub, cost[(i - 1) * w + j] + 1, cost[i * w + j - 1] + 1)
            }
        }
        // End where the cost is lowest; on a tie the longer stretch wins.
        var j = 0
        for (k in 1..m) if (cost[n * w + k] <= cost[n * w + j]) j = k
        var i = n
        val ops = mutableListOf<Op>()
        while (i > 0) {
            val here = cost[i * w + j]
            val equal = j > 0 && a[i - 1].key == b[j - 1].key
            if (j > 0 && here == cost[(i - 1) * w + j - 1] + (if (equal) 0 else 1)) {
                ops.add(Op(equal, i - 1, j - 1))
                i--
                j--
            } else if (here == cost[(i - 1) * w + j] + 1) {
                ops.add(Op(false, i - 1, -1))
                i--
            } else {
                ops.add(Op(false, -1, j - 1))
                j--
            }
        }
        return ops.asReversed()
    }

    // ── Is it a term? ───────────────────────────────────────────────────────

    private val LOWER_UPPER = Regex("\\p{Ll}\\p{Lu}")
    private val ALL_CAPS = Regex("^\\p{Lu}{2,}\\z")
    private val NOT_LETTER = Regex("[^\\p{L}]")
    private val DIGIT = Regex("\\p{N}")
    private val LETTER = Regex("\\p{L}")
    private val UPPER = Regex("\\p{Lu}")
    // JS's `.` (any code point but a line terminator) before a capital: one that isn't the first letter.
    private val INNER_UPPER = Regex("[^\\n\\r\\u2028\\u2029]\\p{Lu}")
    /** JS's \s, spelled out: \s means less on the JVM and differs again on Android. */

    /** Spelled like a name or an identifier: a capital inside ("GitHub"), all capitals ("API"), or a digit with letters ("T3"). */
    internal fun looksLikeTerm(word: String): Boolean =
        LOWER_UPPER.containsMatchIn(word) ||
            (ALL_CAPS.containsMatchIn(word.replace(NOT_LETTER, "")) && word.length >= 2) ||
            (DIGIT.containsMatchIn(word) && LETTER.containsMatchIn(word))

    /** JS's \s (one UTF-16 unit), spelled out: Kotlin's isWhitespace counts a few other characters. */
    private fun jsSpace(c: Char) = c in "\t\n\u000B\u000C\r \u00A0\u1680\u2028\u2029\u202F\u205F\u3000\uFEFF" || c in '\u2000'..'\u200A'

    /** Nothing but spaces, quotes or brackets since the start of the text or the end of a sentence. */
    private fun sentenceStart(text: String, at: Int): Boolean {
        var i = at - 1
        while (i >= 0 && (jsSpace(text[i]) || text[i] in "\"«“(")) i--
        return i < 0 || text[i] in ".!?…:"
    }

    private fun hasLatin(s: String): Boolean {
        var i = 0
        while (i < s.length) {
            val c = s.codePointAt(i)
            if (Character.UnicodeScript.of(c) == Character.UnicodeScript.LATIN) return true
            i += Character.charCount(c)
        }
        return false
    }

    private fun worthSuggesting(heard: String, fixed: String, atSentenceStart: Boolean): Boolean {
        if (fixed.length < 2 || fixed.length > MAX_TERM_LENGTH) return false
        if (!LETTER.containsMatchIn(fixed)) return false // numbers: "2" → "3" is a change of mind, not a term
        if (fixed.lowercase() in NOT_TERMS) return false
        if (heard.lowercase() == fixed.lowercase()) return looksLikeTerm(fixed) && !looksLikeTerm(heard)
        // Ordinary lowercase words in the same script are typo fixes or a different word, not terms.
        val latin = hasLatin(fixed)
        val sameScript = latin == hasLatin(heard)
        val marked = if (atSentenceStart) INNER_UPPER.containsMatchIn(fixed) || DIGIT.containsMatchIn(fixed) else UPPER.containsMatchIn(fixed) || DIGIT.containsMatchIn(fixed)
        if (sameScript && !marked) return false
        if (sameScript && otherEnding(heard, fixed)) return false
        return soundsAlike(heard, fixed)
    }

    /** The same word with another ending, a grammar fix rather than a spelling: "Иваном" → "Ивановым" (not "Ильязу" → "Ильясу"). */
    private fun otherEnding(heard: String, fixed: String): Boolean {
        val x = heard.lowercase()
        val y = fixed.lowercase()
        var p = 0
        while (p < x.length && p < y.length && x[p] == y[p]) p++
        val tx = x.length - p
        val ty = y.length - p
        return p >= 3 && tx != ty && minOf(tx, ty) <= 2
    }

    private val TRANSLIT = mapOf(
        'а' to "a", 'б' to "b", 'в' to "v", 'г' to "g", 'д' to "d", 'е' to "e", 'ё' to "e", 'ж' to "zh", 'з' to "z", 'и' to "i",
        'й' to "i", 'к' to "k", 'л' to "l", 'м' to "m", 'н' to "n", 'о' to "o", 'п' to "p", 'р' to "r", 'с' to "s", 'т' to "t",
        'у' to "u", 'ф' to "f", 'х' to "h", 'ц' to "ts", 'ч' to "ch", 'ш' to "sh", 'щ' to "sh", 'ъ' to "", 'ы' to "i", 'ь' to "",
        'э' to "e", 'ю' to "yu", 'я' to "ya",
    )
    private val NOT_LATIN_OR_DIGIT = Regex("[^a-z0-9]")
    private val K_SOUND = Regex("ck|q|c(?=[aoukrlt]|\\z)")
    private val DOUBLED = Regex("(.)\\1+")
    private val VOWELS = Regex("[aeiou]")

    /** A rough sound of the word: lowercase Latin letters and digits. */
    fun sound(text: String): String {
        // Surrogate halves pass through untranslated and are dropped below, as JS drops the whole code point.
        val s = buildString { for (c in text.lowercase()) append(TRANSLIT[c] ?: c) }.replace(NOT_LATIN_OR_DIGIT, "")
        return s
            .replace("ph", "f")
            .replace(K_SOUND, "k")
            .replace("c", "s")
            .replace("x", "ks")
            .replace("w", "v")
            .replace('y', 'i').replace('j', 'i')
            .replace(DOUBLED, "$1")
    }

    private fun similarity(x: String, y: String): Double {
        if (x.isEmpty() || y.isEmpty()) return 0.0
        return 1 - levenshtein(x, y).toDouble() / maxOf(x.length, y.length)
    }

    private fun levenshtein(x: String, y: String): Int {
        var prev = IntArray(y.length + 1) { it }
        for (i in 1..x.length) {
            val row = IntArray(y.length + 1)
            row[0] = i
            for (j in 1..y.length) row[j] = minOf(prev[j - 1] + (if (x[i - 1] == y[j - 1]) 0 else 1), prev[j] + 1, row[j - 1] + 1)
            prev = row
        }
        return prev[y.length]
    }

    /** The two sound alike: close as rough Latin spellings, or with the same consonants. */
    fun soundsAlike(heard: String, fixed: String): Boolean {
        val x = sound(heard)
        val y = sound(fixed)
        if (similarity(x, y) >= 0.6) return true
        val cx = x.replace(VOWELS, "")
        val cy = y.replace(VOWELS, "")
        return cx.length >= 2 && similarity(cx, cy) >= 0.75
    }
}
