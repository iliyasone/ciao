package dev.iliyasone.ciao

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView

/**
 * Offers a word the user corrected after a dictation for the terms ("постхок" → "PostHog"), in the
 * live card's style and place, with the Ciao icon so it is clearly Ciao asking, not the app below.
 */
class SuggestionView(
    context: Context,
    correction: Correction,
    private val onAdd: () -> Unit,
    private val onNo: () -> Unit,
) : LinearLayout(context) {
    private val density = resources.displayMetrics.density
    private fun dp(v: Number) = (v.toFloat() * density).toInt()

    private val title = TextView(context).apply {
        text = context.getString(R.string.suggest_title)
        setTextColor(context.getColor(R.color.faint))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
    }
    private val body = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setTextColor(context.getColor(R.color.muted))
        text = change(context, correction)
    }
    private val buttons = LinearLayout(context).apply {
        orientation = HORIZONTAL
        gravity = Gravity.END
        addView(button(R.string.suggest_no, R.color.muted) { onNo() })
        addView(button(R.string.suggest_add, R.color.accent) { onAdd() }, LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT).apply { marginStart = dp(4) })
    }

    init {
        orientation = VERTICAL
        setPadding(dp(18), dp(12), dp(10), dp(6))
        background = GradientDrawable().apply {
            cornerRadius = dp(22).toFloat()
            setColor(context.getColor(R.color.overlay))
            setStroke(dp(1), Color.argb(26, 128, 128, 128))
        }
        elevation = dp(10).toFloat()

        val icon = ImageView(context).apply { setImageResource(R.drawable.bubble) }
        val header = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(icon, LayoutParams(dp(20), dp(20)))
            addView(title, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(8) })
        }
        addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        addView(body, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(6)
            marginEnd = dp(8)
        })
        addView(buttons, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { topMargin = dp(2) })
    }

    /** The term went in: say so in place of the question. */
    fun added(term: String) {
        buttons.visibility = GONE
        body.text = context.getString(R.string.suggest_added, term)
        body.setTextColor(context.getColor(R.color.fg))
        setPadding(paddingLeft, paddingTop, paddingRight, dp(14))
    }

    private fun button(label: Int, color: Int, onClick: () -> Unit) = TextView(context).apply {
        text = context.getString(label)
        setTextColor(context.getColor(color))
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        gravity = Gravity.CENTER
        minHeight = dp(40)
        setPadding(dp(12), 0, dp(12), 0)
        val ripple = TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackground, ripple, true)
        setBackgroundResource(ripple.resourceId)
        setOnClickListener { onClick() }
    }

    companion object {
        /** «постхок» → «PostHog», the new spelling stressed. */
        private fun change(context: Context, c: Correction): CharSequence {
            val text = context.getString(R.string.suggest_change, c.heard, c.fixed)
            val out = SpannableStringBuilder(text)
            val at = text.lastIndexOf(c.fixed)
            if (at >= 0) {
                out.setSpan(ForegroundColorSpan(context.getColor(R.color.fg)), at, at + c.fixed.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                out.setSpan(StyleSpan(Typeface.BOLD), at, at + c.fixed.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            return out
        }
    }
}
