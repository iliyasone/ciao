package dev.iliyasone.ciao

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityNodeInfo

/** Puts the transcript into a text field through the accessibility node of that field. */
object TextInserter {
    /**
     * Inserts [transcript] at the cursor of [node] (replacing the selection), with a space before it when
     * it would otherwise stick to the previous word.
     *
     * A field with text in it gets a paste when we can put the clipboard back afterwards:
     * ACTION_SET_TEXT replaces the whole content with plain text, which drops formatting and the
     * app's undo. Android 10+ hides the clipboard from apps without focus, though, and losing what
     * the user copied is worse, so then (and for empty fields) it is ACTION_SET_TEXT, with a paste
     * only if that is refused. Either action returning true counts as done: Chrome and WebViews
     * update their accessibility tree later, so reading the text back would look like a miss and
     * insert twice.
     */
    fun insert(context: Context, node: AccessibilityNodeInfo, transcript: String): Boolean {
        if (!node.refresh() || !node.isEditable) return false
        val (current, before, piece, after) = place(
            node.text?.toString().orEmpty(), node.hintText?.toString(), node.isShowingHintText,
            node.textSelectionStart, node.textSelectionEnd, transcript,
        )

        val clipboard = context.getSystemService(ClipboardManager::class.java)
        // Only plain text can be put back: a copied image or file is a content:// URI whose read
        // grant ends once the clip is replaced, and setting it again would throw.
        val saved = runCatching { clipboard.primaryClip }.getOrNull()
            ?.takeIf { clip -> (0 until clip.itemCount).all { clip.getItemAt(it).run { uri == null && intent == null } } }
        if (current.isNotEmpty() && saved != null && paste(context, node, piece, saved)) return true

        val updated = before + piece + after
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated) }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            return paste(context, node, piece, saved)
        }
        val caret = before.length + piece.length
        node.performAction(
            AccessibilityNodeInfo.ACTION_SET_SELECTION,
            Bundle().apply {
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_START_INT, caret)
                putInt(AccessibilityNodeInfo.ACTION_ARGUMENT_SELECTION_END_INT, caret)
            },
        )
        return true
    }

    /** The field's text without its hint, what goes before and after the cursor, and [text] to put between them. */
    data class Placement(val current: String, val before: String, val piece: String, val after: String)

    /**
     * Where [text] goes in a field showing [shown] with the selection [selStart]..[selEnd]. An empty
     * field shows its hint ("Message"), and many apps report the hint as the field's text without
     * flagging it as one (Telegram, for one): the dictation would land after it.
     */
    fun place(shown: String, hint: String?, showingHint: Boolean, selStart: Int, selEnd: Int, text: String): Placement {
        val current = if (showingHint || shown == hint) "" else shown
        var start = selStart
        var end = selEnd
        if (start < 0 || end < 0 || start > current.length || end > current.length) {
            start = current.length
            end = current.length
        }
        if (start > end) start = end.also { end = start }
        val before = current.substring(0, start)
        val piece = (if (before.isNotEmpty() && !before.last().isWhitespace()) " " else "") + text
        return Placement(current, before, piece, current.substring(end))
    }

    /** Pastes [text], then puts back [saved] (what was on the clipboard), if Android let us read it. */
    private fun paste(context: Context, node: AccessibilityNodeInfo, text: String, saved: ClipData?): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText(LABEL, text))
        val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        if (saved != null) {
            // Give the app time to read the clip; don't undo something the user copied meanwhile.
            val restore = {
                runCatching { if (clipboard.primaryClipDescription?.label == LABEL) clipboard.setPrimaryClip(saved) }
                Unit
            }
            if (pasted) Handler(Looper.getMainLooper()).postDelayed(restore, 500) else restore()
        }
        return pasted
    }

    fun copy(context: Context, text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText(LABEL, text))
    }

    private const val LABEL = "Ciao"
}
