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
    private val REMEMBER = Regex(
        // "ао": a wake-word start may begin with the tail of "чао".
        "(?iU)(?:^\\s*ао|(?<!\\p{L})$WORD)$SEP" +
            "(?:запомни|запиши|добавь|remember|add)(?!\\p{L})" +
            "(?:$SEP(?:в|to|the|a|an|my|новое|новый|new)(?!\\p{L}))?" +
            "$SEP(?:словарь|слово|термины|термин|words?|terms?|vocabulary|dictionary)(?!\\p{L})" +
            "(?:$SEP(?:по буквам|spelled|spelt))?",
    )

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
    private val SENTENCE_GAP = Regex("[,.!?…;:\\n]")
    private val TRAILING = Regex("(?U)^[\\s,.!?…;:»\"”’)\\]]*")
    /** Words of a written-out term, at most this many: the rest of the sentence is dictation again. */
    private const val MAX_WORDS = 3
    /** Dictation goes on after the term ("…слово PostHog и запушь"). */
    private val GOES_ON = "и а но или потом дальше это теперь and but or then now this".split(" ").toSet()

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
     */
    fun takeRememberCommands(text: String): Pair<String, List<RememberCommand>> {
        val commands = mutableListOf<RememberCommand>()
        val out = StringBuilder()
        var from = 0
        var m = REMEMBER.find(text)
        while (m != null) {
            val (end, command) = readTerm(text, m.range.last + 1)
            commands.add(command)
            out.append(text, from, m.range.first)
            // The punctuation after the term goes with it.
            from = end + TRAILING.find(text.substring(end))!!.value.length
            m = if (from < text.length) REMEMBER.find(text, from) else null
        }
        if (commands.isEmpty()) return text to commands
        // The text went on after a command at its start: begin it with a capital.
        val capital = out.isBlank()
        val rest = out.append(text.substring(from)).toString()
            .replace(Regex("[ \\t]{2,}"), " ")
            .replace(Regex("(?U)[\\s,;:—–-]+$"), "")
            .trim()
        return (if (capital) rest.replaceFirstChar { it.uppercaseChar() } else rest) to commands
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
