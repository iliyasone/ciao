package dev.iliyasone.ciao

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Bundle
import android.view.accessibility.AccessibilityNodeInfo

/** Puts the transcript into a text field through the accessibility node of that field. */
object TextInserter {
    /**
     * Inserts [text] at the cursor of [node] (replacing the selection), with a space before it when
     * it would otherwise stick to the previous word. Fields that ignore ACTION_SET_TEXT get it pasted.
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
        val updated = before + piece + current.substring(end)

        val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, updated) }
        if (node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) {
            node.refresh()
            val now = node.text?.toString().orEmpty()
            if (now == updated || now.contains(text)) {
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
        }
        // Rich editors and some web fields ignore SET_TEXT but accept a paste.
        copy(context, piece)
        return node.performAction(AccessibilityNodeInfo.ACTION_PASTE)
    }

    fun copy(context: Context, text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java)
        clipboard.setPrimaryClip(ClipData.newPlainText("Ciao", text))
    }
}
