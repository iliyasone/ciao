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

    @Test
    fun suspectsAnUnflaggedHintOnlyWithTheCursorAtTheStart() {
        assertEquals(true, TextInserter.mayBeHint("Message", null, 0, 0))
        assertEquals(false, TextInserter.mayBeHint("Message", null, -1, -1))
        assertEquals(true, TextInserter.mayBeHint("Сообщение", "Message", 0, 0))
        assertEquals(false, TextInserter.mayBeHint("Message", "Message", 0, 0))
        assertEquals(false, TextInserter.mayBeHint("Hello", null, 5, 5))
        assertEquals(false, TextInserter.mayBeHint("Hello", null, 0, 5))
        assertEquals(false, TextInserter.mayBeHint("", null, 0, 0))
    }

    private var caret = -1
    private val selections = mutableListOf<Pair<Int, Int>>()

    /**
     * What insert() hands the app: the text it sets, or the clipboard at the moment it pastes. The field
     * really holds [holds] characters: like a TextView, it refuses a selection past them, or one it
     * already has, and lists ACTION_SET_SELECTION only while it holds some. [canSelect] off: a custom
     * view that doesn't move its cursor.
     */
    private fun insert(
        shown: String, hint: String?, start: Int, end: Int, transcript: String,
        holds: Int = shown.length, canSelect: Boolean = true, chrome: Boolean = false,
        className: String = "android.widget.EditText", prefix: Int = 0,
    ): String? {
        var real = holds
        var selection = start to end
        val context = RuntimeEnvironment.getApplication()
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        var result: String? = null
        caret = -1
        selections.clear()
        val node = AccessibilityNodeInfo.obtain().apply {
            isEditable = true
            text = shown
            hintText = hint
            setTextSelection(start, end)
            this.className = className
            if (canSelect && holds > 0) addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_SET_SELECTION)
            if (chrome) extras.putString("AccessibilityNodeInfo.chromeRole", "textField")
        }
        shadowOf(node).setOnPerformActionListener { action, args ->
            when (action) {
                AccessibilityNodeInfo.ACTION_SET_TEXT -> {
                    result = args.getCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE).toString()
                    real = result!!.length
                }
                AccessibilityNodeInfo.ACTION_PASTE -> result = "paste:" + clipboard.primaryClip!!.getItemAt(0).text
                AccessibilityNodeInfo.ACTION_SET_SELECTION -> {
                    caret = args.getInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT)
                    val to = args.getInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT)
                    if (!canSelect || caret > real || to > real || selection == caret to to) return@setOnPerformActionListener false
                    // A Compose field showing a [prefix] before its text maps a cursor inside it to 0.
                    if (caret in 1..prefix && selection == 0 to 0) return@setOnPerformActionListener false
                    selection = caret to to
                    selections += selection
                }
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
    fun aHintTheAppDoesNotFlagStaysOut() {
        // The field shows "Message" as its text, with no hint and the cursor at 0, but holds nothing,
        // so (as a TextView does) it doesn't even list ACTION_SET_SELECTION.
        assertEquals("Привет", insert("Message", null, 0, 0, "Привет", holds = 0))
        // Both probes were refused and the cursor wasn't put back: it only went after the dictation.
        assertEquals(listOf(6 to 6), selections)
        assertEquals("Привет", insert("Сообщение", "Message", 0, 0, "Привет", holds = 0))
    }

    @Test
    fun realTextWithTheCursorAtTheStartStays() {
        assertEquals("Well, Hello", insert("Hello", null, 0, 0, "Well, "))
        // The probe moved the cursor past the first character and back, then after the dictation.
        assertEquals(listOf(1 to 1, 0 to 0, 6 to 6), selections)
        // Shown text longer than what the field holds (a chip, say) is still real text.
        assertEquals("Well, Hello @Ann", insert("Hello @Ann", null, 0, 0, "Well, ", holds = 7))
        assertEquals("Hello world", insert("Hello", null, -1, -1, "world"))
        // A field with a prefix refuses the first cursor, not the one at the end.
        assertEquals("Well, +7 900", insert("+7 900", null, 0, 0, "Well, ", prefix = 3))
        assertEquals(listOf(6 to 6, 0 to 0, 6 to 6), selections)
        // A custom editor isn't asked, even one that would refuse: its text is kept.
        assertEquals("Well, Hello", insert("Hello", null, 0, 0, "Well, ", canSelect = false, className = "com.example.Editor"))
        // With the clipboard to put back, the dictation is pasted where the probe left the cursor: at 0.
        val clipboard = RuntimeEnvironment.getApplication().getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("user", "copied"))
        assertEquals("paste:Well, ", insert("Hello", null, 0, 0, "Well, "))
        assertEquals(listOf(1 to 1, 0 to 0), selections)
        // With the cursor unknown there's no probe.
        assertEquals("paste: world", insert("Hello", null, -1, -1, "world"))
        assertEquals(listOf<Pair<Int, Int>>(), selections)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(500))
        clipboard.clearPrimaryClip()
        // Nor is Chrome's text probed: it flags its hints.
        assertEquals("Well, Hello", insert("Hello", null, 0, 0, "Well, ", chrome = true))
        assertEquals(listOf(6 to 6), selections)
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
