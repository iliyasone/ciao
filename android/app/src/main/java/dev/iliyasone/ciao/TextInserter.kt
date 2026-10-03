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
     * Inserts [text] at the cursor of [node] (replacing the selection), with a space before it when
     * it would otherwise stick to the previous word.
     *
     * A field with text in it gets a paste: ACTION_SET_TEXT replaces the whole content with plain
     * text, which would drop formatting, mentions and the app's undo. An empty field, or one that
     * refuses the paste, gets ACTION_SET_TEXT. Either action returning true counts as done: Chrome
     * and WebViews update their accessibility tree later, so reading the text back would look like
     * a miss and insert twice.
     */
    fun insert(context: Context, node: AccessibilityNodeInfo, text: String): Boolean {
        if (!node.refresh() || !node.isEditable) return false
        val current = if (node.isShowingHintText) "" else node.text?.toString().orEmpty()
        var start = node.textSelectionStart
        var end = node.textSelectionEnd
        if (start < 0 || end < 0 || start > current.length || end > current.length) {
            start = current.length
            end = current.length
        }
        if (start > end) start = end.also { end = start }
        val before = current.substring(0, start)
        val piece = (if (before.isNotEmpty() && !before.last().isWhitespace()) " " else "") + text

        if (current.isNotEmpty() && paste(context, node, piece)) return true

        val updated = before + piece + current.substring(end)
        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated) }
        if (!node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            return current.isEmpty() && paste(context, node, piece)
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

    /** Pastes [text], then puts back what was on the clipboard if Android let us read it. */
    private fun paste(context: Context, node: AccessibilityNodeInfo, text: String): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        val previous = runCatching { clipboard.primaryClip }.getOrNull()
        clipboard.setPrimaryClip(ClipData.newPlainText("Ciao", text))
        val pasted = node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
        if (pasted && previous != null) Handler(Looper.getMainLooper()).postDelayed({ clipboard.setPrimaryClip(previous) }, 500)
        return pasted
    }

    fun copy(context: Context, text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Ciao", text))
    }
}
