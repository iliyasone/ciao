package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

class TextInserterTest {
    private fun inserted(shown: String, hint: String?, start: Int, end: Int, text: String, showingHint: Boolean = false) =
        TextInserter.place(shown, hint, showingHint, start, end, text).run { before + piece + after }

    @Test
    fun insertsTheDictationNotTheField() {
        assertEquals("Привет", inserted("", null, 0, 0, "Привет"))
        assertEquals("Привет", inserted("Message", "Message", 7, 7, "Привет"))
        assertEquals("Привет", inserted("Message", "Message", -1, -1, "Привет", showingHint = true))
        assertEquals("Hello world", inserted("Hello", "Message", 5, 5, "world"))
        assertEquals("Hello world there", inserted("Hello there", null, 5, 5, "world"))
        assertEquals("Hi there", inserted("Hello there", null, 0, 5, "Hi"))
        assertEquals("Hello world", inserted("Hello", null, -1, -1, "world"))
    }

    @Test
    fun aHintCountsAsAnEmptyField() {
        // An empty field gets ACTION_SET_TEXT, not a paste.
        assertEquals("", TextInserter.place("Message", "Message", false, 7, 7, "x").current)
        assertEquals("", TextInserter.place("Message", null, true, -1, -1, "x").current)
    }
}
