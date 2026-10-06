package dev.iliyasone.ciao

import android.content.ClipData
import android.content.ClipboardManager
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class TextInserterTest {
    private fun inserted(shown: String, hint: String?, start: Int, end: Int, transcript: String, showingHint: Boolean = false) =
        TextInserter.place(shown, hint, showingHint, start, end, transcript).run { before + piece + after }

    @Test
    fun placesTheDictation() {
        assertEquals("Привет", inserted("", null, 0, 0, "Привет"))
        assertEquals("Привет", inserted("Message", "Message", 7, 7, "Привет"))
        assertEquals("Привет", inserted("Message", "Message", -1, -1, "Привет", showingHint = true))
        assertEquals("Hello world", inserted("Hello", "Message", 5, 5, "world"))
        assertEquals("Hello world there", inserted("Hello there", null, 5, 5, "world"))
        assertEquals("Hi there", inserted("Hello there", null, 0, 5, "Hi"))
        assertEquals("Hello world", inserted("Hello", null, -1, -1, "world"))
        assertEquals("Hello world", inserted("Hello ", null, 6, 6, "world"))
        assertEquals("Hi there", inserted("Hello there", null, 5, 0, "Hi"))
    }

    @Test
    fun aHintCountsAsAnEmptyField() {
        // An empty field gets ACTION_SET_TEXT, not a paste.
        assertEquals("", TextInserter.place("Message", "Message", false, 7, 7, "x").current)
        assertEquals("", TextInserter.place("Message", null, true, -1, -1, "x").current)
    }

    private var caret = -1

    /** What insert() hands the app: the text it sets, or the clipboard at the moment it pastes. */
    private fun insert(shown: String, hint: String?, start: Int, end: Int, transcript: String): String? {
        val context = RuntimeEnvironment.getApplication()
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        var result: String? = null
        caret = -1
        val node = AccessibilityNodeInfo.obtain().apply {
            isEditable = true
            text = shown
            hintText = hint
            setTextSelection(start, end)
        }
        shadowOf(node).setOnPerformActionListener { action, args ->
            when (action) {
                AccessibilityNodeInfo.ACTION_SET_TEXT ->
                    result = args.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE).toString()
                AccessibilityNodeInfo.ACTION_PASTE -> result = "paste:" + clipboard.primaryClip!!.getItemAt(0).text
                AccessibilityNodeInfo.ACTION_SET_SELECTION -> caret = args.getInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT)
            }
            true
        }
        assertEquals(true, TextInserter.insert(context, node, transcript))
        return result
    }

    @Test
    fun insertsTheDictationNotTheField() {
        assertEquals("Привет", insert("", null, 0, 0, "Привет"))
        assertEquals("Привет", insert("Message", "Message", 7, 7, "Привет"))
        // Nothing on the clipboard to put back, so the whole text is set rather than pasted.
        assertEquals("Hello world", insert("Hello", "Message", 5, 5, "world"))
        assertEquals("Hello world there", insert("Hello there", null, 5, 5, "world"))
        assertEquals(11, caret)
    }

    @Test
    fun pastesAndPutsTheClipboardBack() {
        val clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("user", "copied"))
        assertEquals("paste: world", insert("Hello", "Message", 5, 5, "world"))
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
        assertEquals("copied", clipboard.primaryClip!!.getItemAt(0).text.toString())
    }
}
