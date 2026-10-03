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
}
