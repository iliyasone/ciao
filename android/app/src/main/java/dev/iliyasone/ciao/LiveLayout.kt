package dev.iliyasone.ciao

// Paragraphs and numbered lists, decided by simple rules while the text streams in. A port of
// src/core/liveLayout.ts (see the rules there); keep the two in step so the phone lays text out
// exactly like the desktop app.

data class Pause(val at: Int, val ms: Long)

sealed class Break {
    abstract val at: Int

    data class Paragraph(override val at: Int) : Break()

    data class Item(override val at: Int, val n: Int) : Break()
}

/** Replace text[start, end) with [insert] (drops the ordinal, capitalises what follows). */
data class Edit(val start: Int, val end: Int, val insert: String)

data class Layout(val breaks: List<Break>, val edits: List<Edit>)

object LiveLayout {
    const val PARAGRAPH_PAUSE_MS = 1200L
    private const val LIST_END_PAUSE_MS = 2000L

    private val ORDINAL_SOURCES = listOf(
        "во-первых|перв(?:ое|ый момент|ый пункт)|first(?:ly)?" to 1,
        "во-вторых|втор(?:ое|ой момент|ой пункт)|second(?:ly)?" to 2,
        "в-третьих|трет(?:ье|ий момент|ий пункт)|third(?:ly)?" to 3,
        "в-четв[её]ртых|четв[её]рт(?:ое|ый момент|ый пункт)" to 4,
        "в-пятых|пят(?:ое|ый момент|ый пункт)" to 5,
        "в-шестых|шест(?:ое|ой момент|ой пункт)" to 6,
        "в-седьмых|седьм(?:ое|ой момент|ой пункт)" to 7,
        "в-восьмых|восьм(?:ое|ой момент|ой пункт)" to 8,
        "в-девятых|девят(?:ое|ый момент|ый пункт)" to 9,
        "в-десятых|десят(?:ое|ый момент|ый пункт)" to 10,
    )

    // (?iu): case-insensitive for Cyrillic too, like the JS /iu flags.
    private val ORDINALS = ORDINAL_SOURCES.map { (src, n) -> Regex("(?iu)^(?:$src)$") to n }
    private val ORDINAL = Regex("(?iu)^(?:${ORDINAL_SOURCES.joinToString("|") { it.first }})(?![\\p{L}-])")
    private val CONTINUE = Regex("(?iu)^(?:и ещё|и еще|ещё|еще|дальше|далее|также|и также|и последнее|последнее|next|also)(?![\\p{L}-])")
    private val AFTER_WORD = Regex("^[\\s,:;.!—–-]*")
    private val SENTENCE_END = Regex("[.!?…]+[\"»”)]*\\s+(?=\\S)")
    private val RU = java.util.Locale("ru", "RU")

    private fun firstNonSpace(text: String, from: Int): Int {
        var i = from
        while (i < text.length && text[i].isWhitespace()) i++
        return i
    }

    private fun sentenceStarts(text: String, pauses: List<Pause>): List<Int> {
        val starts = sortedSetOf<Int>()
        val first = firstNonSpace(text, 0)
        if (first < text.length) starts.add(first)
        for (m in SENTENCE_END.findAll(text)) starts.add(m.range.last + 1)
        // A pause followed by a capital letter starts a sentence even without punctuation.
        for (p in pauses) {
            val s = firstNonSpace(text, p.at)
            if (s < text.length && text[s].isUpperCase()) starts.add(s)
        }
        return starts.filter { it < text.length }
    }

    /** The longest pause right before [start] (only whitespace in between). */
    private fun pauseBefore(text: String, pauses: List<Pause>, start: Int): Long {
        var ms = 0L
        for (p in pauses) if (p.at <= start && text.substring(p.at, start).isBlank()) ms = maxOf(ms, p.ms)
        return ms
    }

    fun layout(text: String, pauses: List<Pause>): Layout {
        val breaks = mutableListOf<Break>()
        val edits = mutableListOf<Edit>()
        var item = 0 // current list item number, 0 = not in a list

        fun startItem(start: Int, word: String, n: Int) {
            breaks.add(Break.Item(start, n))
            val afterWord = start + word.length
            val end = afterWord + AFTER_WORD.find(text.substring(afterWord))!!.value.length
            val next = text.getOrNull(end)
            // Only once the next letter has arrived, so a half-streamed word isn't mangled.
            if (next != null && next.isLetter()) edits.add(Edit(start, end + 1, next.toString().uppercase(RU)))
            else if (next == null) edits.add(Edit(start, end, ""))
            item = n
        }

        for (start in sentenceStarts(text, pauses)) {
            val rest = text.substring(start)
            val pause = pauseBefore(text, pauses, start)
            val ordinal = ORDINAL.find(rest)
            if (ordinal != null) {
                val value = ORDINALS.first { it.first.matches(ordinal.value) }.second
                startItem(start, ordinal.value, if (item != 0) item + 1 else value)
                continue
            }
            val cont = if (item != 0) CONTINUE.find(rest) else null
            if (cont != null) {
                startItem(start, cont.value, item + 1)
                continue
            }
            if (start == 0 || text.substring(0, start).isBlank()) continue
            if (if (item != 0) pause >= LIST_END_PAUSE_MS else pause >= PARAGRAPH_PAUSE_MS) {
                breaks.add(Break.Paragraph(start))
                item = 0
            }
        }
        return Layout(breaks, edits)
    }

    /** The laid-out text as plain text/Markdown: blank lines between paragraphs, "1. " items. */
    fun apply(text: String, l: Layout): String {
        val marks = l.breaks.associateBy { it.at }
        val edits = l.edits.associateBy { it.start }
        val out = StringBuilder()
        var prevItem = false
        var i = 0
        while (i < text.length) {
            val b = marks[i]
            if (b != null) {
                val trimmed = out.trimEnd()
                out.setLength(trimmed.length)
                if (out.isNotEmpty()) out.append(if (b is Break.Item && (prevItem || out.endsWith(":"))) "\n" else "\n\n")
                if (b is Break.Item) out.append("${b.n}. ")
                prevItem = b is Break.Item
            }
            val e = edits[i]
            if (e != null) {
                out.append(e.insert)
                i = e.end
            } else {
                out.append(text[i])
                i++
            }
        }
        return out.toString().trim()
    }
}
