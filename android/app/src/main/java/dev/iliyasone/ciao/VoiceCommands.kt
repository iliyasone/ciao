package dev.iliyasone.ciao

// Spoken commands inside the transcript; a port of src/core/voiceCommands.ts. Recognition may write
// the word in Cyrillic or Latin ("чао", "Ciao") with any punctuation between repeats.

object VoiceCommands {
    private const val WORD = "(?:чао|ciao|чау)"
    private const val SEP = "[\\s,.!?…:;—–-]*"
    private val STOP_AT_END = Regex("(?iu)$SEP(?<!\\p{L})$WORD$SEP$WORD$SEP$")

    /** The transcript so far ends with "чао-чао": the speaker wants to finish. */
    fun endsWithStopPhrase(text: String): Boolean = STOP_AT_END.containsMatchIn(text)

    /** Removes a trailing "чао-чао" (and the punctuation around it) from the final text. */
    fun stripStopPhrase(text: String): String = text.replace(STOP_AT_END, "").trimEnd()

    // ── "Чао, запомни слово PostHog" ──────────────────────────────────────
    // A port of takeRememberCommands in src/core/voiceCommands.ts; Terms.kt turns what was heard
    // into the term. (?U): \s takes Unicode spaces too, as in JS.

    // The noun is required: "Чао, добавь тесты" is dictation, not a command.
    private const val VERB_AND_NOUN =
        "(?:запомни|запиши|добавь|remember|add)(?!\\p{L})" +
            "(?:$SEP(?:в|to|the|a|an|my|новое|новый|new)(?!\\p{L}))?" +
            "$SEP(?:словарь|слово|термины|термин|words?|terms?|vocabulary|dictionary)(?!\\p{L})" +
            // "добавь в словарь слово …"
            "(?:$SEP(?:слово|термин|word|term)(?!\\p{L}))?" +
            "(?:$SEP(?:по буквам|spelled|spelt))?"
    // "ао": a wake-word start may begin with the tail of "чао", or with none of it.
    private val REMEMBER = Regex("(?iU)(?:^\\s*ао|(?<!\\p{L})$WORD)$SEP$VERB_AND_NOUN")
    private val REMEMBER_AFTER_WAKE = Regex("(?iU)(?:^\\s*(?:ао)?|(?<!\\p{L})$WORD)$SEP$VERB_AND_NOUN")
    /** Where the term goes, said after it: "…слово PostHog в словарь", "…PostHog to my dictionary". */
    private val DESTINATION = Regex("(?iU)^[\\s,]*(?:в|to)\\s+(?:(?:my|the)\\s+)?(?:словарь|термины|dictionary|vocabulary|terms|words)(?!\\p{L})")

    /** A word, a number or an identifier such as "Next.js", "C++" or "gpt-5". */
    private val TOKEN = Regex("[\\p{L}\\p{N}]+(?:[.+#_'’][\\p{L}\\p{N}]+)*[+#]*")

    /** Russian and English letter names, as a recognizer writes them in either script. */
    private val LETTER_NAMES = (
        "а бэ бе вэ ве гэ ге дэ де е ё жэ же зэ зе и й ка эль эл эм эн о пэ пе эр эс тэ те у эф ха цэ це че ша ща ы э ю я икс игрек " +
            "эй би си ди иф джи эйч ай джей кей оу пи кью ар ти ви дабл даблю уай вай зед зи экс " +
            "bee cee dee gee jay kay el em en oh pee cue ar ess tee vee double ex why zed zee aitch"
        ).split(" ").toSet()

    /** Letters that are words too, and may start the next sentence. */
    private val LETTER_WORDS = "а и я в с к о у a i".split(" ").toSet()

    private fun isLetter(token: String) = (token.length == 1 && token[0].isLetter()) || token.lowercase() in LETTER_NAMES

    /** Gaps between words in a spoken spelling; a sentence end anywhere else ends the term. */
    private val SPELLING_GAP = Regex("(?U)[\\s,.\\-–—:;]*")
    private val SENTENCE_GAP = Regex("[,.!?…;:\\n»\"”’)]")
    /** Nothing yet, or a sentence end: what follows starts a sentence. */
    private val SENTENCE_STARTS = Regex("(?U)^\\s*$|[.!?…]\\s*$")
    private val TRAILING = Regex("(?U)^[\\s,.!?…;:»\"”’)\\]]*")
    /** Words of a written-out term, at most this many: the rest of the sentence is dictation again. */
    private const val MAX_WORDS = 3
    /** Dictation goes on after the term ("…слово PostHog и запушь"). */
    private val GOES_ON = "и а но или в потом дальше это теперь and but or to then now this".split(" ").toSet()

    /** "latin", "other" (Cyrillic), or null for a number. */
    private fun script(word: String): String? = when {
        word.any { Character.UnicodeScript.of(it.code) == Character.UnicodeScript.LATIN } -> "latin"
        word.any { it.isLetter() } -> "other"
        else -> null
    }

    /** [heard]: what was heard as the term, e.g. "PostHog", "пост хог" or "пэ, о, эс, тэ". */
    data class RememberCommand(val heard: String, val spelled: Boolean)

    /**
     * Finds "чао, запомни слово …" commands and removes them (with the term after each) from the
     * text. A command with nothing after it is removed too, and comes back with heard = "".
     * [wakeStarted]: the text may begin with the command without the "чао" (Android has no wake
     * word yet; kept for parity with the desktop).
     */
    fun takeRememberCommands(text: String, wakeStarted: Boolean = false): Pair<String, List<RememberCommand>> {
        val re = if (wakeStarted) REMEMBER_AFTER_WAKE else REMEMBER
        val commands = mutableListOf<RememberCommand>()
        val out = StringBuilder()
        var from = 0
        /** The text after a command: with a capital where a sentence starts (at the start, or after "."). */
        fun add(piece: String) {
            out.append(if (from > 0 && SENTENCE_STARTS.containsMatchIn(out)) piece.replaceFirstChar { it.uppercaseChar() } else piece)
        }
        var m = re.find(text)
        while (m != null) {
            val (termEnd, command) = readTerm(text, m.range.last + 1)
            commands.add(command)
            add(text.substring(from, m.range.first))
            val end = termEnd + (DESTINATION.find(text.substring(termEnd))?.value?.length ?: 0)
            // The punctuation after the term goes with it.
            from = end + TRAILING.find(text.substring(end))!!.value.length
            m = if (from < text.length) re.find(text, from) else null
        }
        if (commands.isEmpty()) return text to commands
        add(text.substring(from))
        val rest = out.toString()
            .replace(Regex("[ \\t]{2,}"), " ")
            .replace(Regex("(?U)[\\s,;:—–\\-«\"„“(]+$"), "")
            .trim()
        return rest to commands
    }

    private class Token(val word: String, val from: Int, val to: Int)

    /** The term after a command that ends at [start], and where it ends. */
    private fun readTerm(text: String, start: Int): Pair<Int, RememberCommand> {
        val tokens = TOKEN.findAll(text, start).map { Token(it.value, it.range.first, it.range.last + 1) }.toList()
        if (tokens.isEmpty()) return text.length to RememberCommand("", false)
        fun word(i: Int) = tokens.getOrNull(i)?.word?.lowercase() ?: ""
        /** What separates token i from the one before. */
        fun gap(i: Int) = text.substring(tokens[i - 1].to, tokens[i].from)
        /** Letter j goes on a spelling; one that is a word too only before another letter ("…эм, а потом" ends at "эм"). */
        fun spells(j: Int) =
            isLetter(word(j)) && SPELLING_GAP.matches(gap(j)) &&
                (word(j) !in LETTER_WORDS || j + 1 == tokens.size || (isLetter(word(j + 1)) && word(j + 1) !in LETTER_WORDS))
        /** Two or more letters from token i on: the index after the last; otherwise i. */
        fun spelling(i: Int): Int {
            var j = if (isLetter(word(i))) i + 1 else i
            while (j > i && j < tokens.size && spells(j)) j++
            return if (j - i >= 2) j else i
        }
        // After a sentence end ("…слово. PostHog.") a lone word or a spelling: anything longer is the next sentence.
        val alone = tokens.size == 1 || Regex("[.!?…\\n]").containsMatchIn(gap(1))
        if (Regex("[.!?…]").containsMatchIn(text.substring(start, tokens[0].from)) && !alone && spelling(0) == 0) return start to RememberCommand("", false)
        var end = spelling(0)
        var spelled = end > 0
        if (!spelled) {
            // Written out: the words up to a punctuation mark or the dictation going on…
            val first = script(word(0))
            fun goesOn(i: Int) = SENTENCE_GAP.containsMatchIn(gap(i)) || word(i) in GOES_ON || script(word(i)).let { it != null && it != first }
            end = 1
            while (end < tokens.size && end < MAX_WORDS && !goesOn(end)) end++
            // …and maybe spelled right after ("PostHog, по буквам: пэ, о, эс, тэ…").
            var next = end
            if (next < tokens.size && SPELLING_GAP.matches(gap(next))) {
                if (word(next) == "по" && word(next + 1) == "буквам") next += 2
                else if (word(next) == "spelled" || word(next) == "spelt") next += 1
                val to = spelling(next)
                if (to > next) {
                    end = to
                    spelled = true
                }
            }
        }
        val to = tokens[end - 1].to
        return to to RememberCommand(text.substring(tokens[0].from, to), spelled)
    }
}
