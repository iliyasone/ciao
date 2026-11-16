package dev.iliyasone.ciao

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupMenu
import android.widget.Switch
import android.widget.TextView

/**
 * The pieces the settings and setup screens are built from, in T3 Code's settings style: a section
 * title over a bordered card, rows inside it (title, a muted line or two, the control on the right),
 * thin dividers between them.
 */
class Kit(val context: Context) {
    private val density = context.resources.displayMetrics.density
    fun dp(v: Number) = (v.toFloat() * density).toInt()
    fun color(id: Int) = context.getColor(id)

    fun text(size: Float, colorId: Int = R.color.fg, medium: Boolean = false, value: CharSequence? = null) = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, size)
        setTextColor(color(colorId))
        if (medium) typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        if (value != null) text = value
        // An arrow (→) from a fallback font would make its line taller than the rest.
        if (android.os.Build.VERSION.SDK_INT >= 28) isFallbackLineSpacing = false
    }

    fun title(value: CharSequence) = text(15f, medium = true, value = value)
    fun hint(value: CharSequence? = null) = text(13f, R.color.muted, value = value).apply { setLineSpacing(dp(2).toFloat(), 1f) }

    /** A section: its title, then [card]. */
    fun section(parent: LinearLayout, title: CharSequence?, card: LinearLayout): LinearLayout {
        if (title != null) parent.addView(text(17f, medium = true, value = title), LinearLayout.LayoutParams(-1, -2).apply {
            topMargin = dp(28)
            bottomMargin = dp(10)
            marginStart = dp(14)
        })
        parent.addView(card, LinearLayout.LayoutParams(-1, -2).apply { if (title == null) topMargin = dp(16) })
        return card
    }

    fun card() = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.card_bg)
        // The rows' pressed state stays inside the rounded corners.
        clipToOutline = true
        // Between the rows that show: a hidden row takes its divider with it.
        dividerDrawable = context.getDrawable(R.drawable.divider)
        showDividers = LinearLayout.SHOW_DIVIDER_MIDDLE
    }

    fun add(card: LinearLayout, row: View): View {
        card.addView(row, LinearLayout.LayoutParams(-1, -2))
        return row
    }

    /**
     * A row: [title] and [hint] on the left, [control] on the right, vertically centred on them.
     * [below] goes full width under the text (a field, a wide select). Returns the row.
     */
    fun row(title: CharSequence?, hint: CharSequence? = null, control: View? = null, below: List<View> = emptyList(), titleId: Int = 0, hintId: Int = 0): LinearLayout {
        val row = LinearLayout(context).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(14), dp(12), dp(14), dp(12))
            minimumHeight = dp(56)
        }
        val top = LinearLayout(context).apply { gravity = Gravity.CENTER_VERTICAL }
        val texts = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }
        if (title != null) texts.addView(title(title).apply { if (titleId != 0) id = titleId })
        if (hint != null || hintId != 0) texts.addView(hint(hint).apply {
            if (hintId != 0) id = hintId
            if (title != null) setPadding(0, dp(3), 0, 0)
        })
        top.addView(texts, LinearLayout.LayoutParams(0, -2, 1f))
        if (control != null) top.addView(control, LinearLayout.LayoutParams(-2, -2).apply { marginStart = dp(12) })
        row.addView(top)
        for (v in below) row.addView(v, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(10) })
        return row
    }

    /** The whole row toggles the switch. */
    fun switchRow(id: Int, title: CharSequence, hint: CharSequence? = null): LinearLayout {
        // Its title is a separate view: TalkBack reads it from here.
        val sw = switch(id).apply { contentDescription = title }
        return row(title, hint, sw).apply {
            setBackgroundResource(selectable())
            setOnClickListener { sw.toggle() }
        }
    }

    @Suppress("UseSwitchCompatOrMaterialCode")
    fun switch(id: Int) = Switch(context).apply {
        this.id = id
        setTrackResource(R.drawable.switch_track)
        setThumbResource(R.drawable.switch_thumb)
        trackTintList = null
        thumbTintList = null
        showText = false
        text = null
        switchMinWidth = dp(40)
    }

    /** A row that opens something: a chevron on the right, the whole row tappable. */
    fun linkRow(title: CharSequence, hint: CharSequence? = null, hintId: Int = 0, onClick: () -> Unit) =
        row(title, hint, icon(R.drawable.ic_chevron_right, R.color.ghost, 16), hintId = hintId).apply {
            setBackgroundResource(selectable())
            setOnClickListener { onClick() }
        }

    fun icon(res: Int, colorId: Int, sizeDp: Int) = ImageView(context).apply {
        setImageResource(res)
        imageTintList = ColorStateList.valueOf(color(colorId))
        layoutParams = LinearLayout.LayoutParams(dp(sizeDp), dp(sizeDp))
    }

    /**
     * A select: shows the picked option, a tap opens the list. [options]: value to label.
     * Calls [onPick] with the value when another one is picked.
     */
    fun select(id: Int, options: List<Pair<String, String>>, value: String, onPick: (String) -> Unit) = TextView(context).apply {
        this.id = id
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        setTextColor(color(R.color.fg))
        setBackgroundResource(R.drawable.select_bg)
        gravity = Gravity.CENTER_VERTICAL
        minHeight = dp(40)
        setPadding(dp(12), 0, dp(10), 0)
        compoundDrawablePadding = dp(8)
        setCompoundDrawablesRelativeWithIntrinsicBounds(null, null, context.getDrawable(R.drawable.ic_chevron_down)!!.mutate().apply { setTint(color(R.color.muted)) }, null)
        var current = value
        fun show() { text = options.firstOrNull { it.first == current }?.second ?: options.first().second }
        show()
        // For [setSelect]: a value changed elsewhere (another screen) shows without calling onPick.
        tag = { v: String -> current = v; show() }
        setOnClickListener {
            val menu = PopupMenu(context, this)
            options.forEachIndexed { i, (_, label) -> menu.menu.add(0, i, i, label) }
            menu.setOnMenuItemClickListener { item ->
                val picked = options[item.itemId].first
                if (picked != current) {
                    current = picked
                    show()
                    onPick(picked)
                }
                true
            }
            menu.show()
        }
    }

    /** Shows [value] in a select made by [select], as picked elsewhere. */
    @Suppress("UNCHECKED_CAST")
    fun setSelect(select: TextView, value: String) = (select.tag as (String) -> Unit)(value)

    fun field(id: Int, hint: CharSequence, lines: Int = 1, mono: Boolean = false) = EditText(context).apply {
        this.id = id
        this.hint = hint
        setTextSize(TypedValue.COMPLEX_UNIT_SP, if (mono) 14f else 15f)
        if (mono) typeface = Typeface.MONOSPACE
        gravity = Gravity.CENTER_VERTICAL or Gravity.START
        setTextColor(color(R.color.fg))
        setHintTextColor(color(R.color.ghost))
        setBackgroundResource(R.drawable.field_bg)
        setPadding(dp(12), dp(10), dp(12), dp(10))
        minHeight = dp(44)
        if (lines > 1) {
            minLines = lines
            maxLines = 8
            gravity = Gravity.TOP or Gravity.START
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
        } else {
            isSingleLine = true
        }
    }

    fun button(label: CharSequence, primary: Boolean, id: Int = View.NO_ID) = Button(context, null, 0, 0).apply {
        this.id = id
        text = label
        isAllCaps = false
        stateListAnimator = null
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f)
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(color(if (primary) R.color.on_accent else R.color.fg))
        setBackgroundResource(if (primary) R.drawable.button_primary else R.drawable.button_outline)
        gravity = Gravity.CENTER
        minHeight = dp(44)
        minimumHeight = dp(44)
        setPadding(dp(16), 0, dp(16), 0)
    }

    /** Buttons one under another, full width: the first is the step's main action. */
    fun stack(vararg views: View) = LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        views.forEachIndexed { i, v -> addView(v, LinearLayout.LayoutParams(-1, -2).apply { if (i > 0) topMargin = dp(8) }) }
    }

    /** Buttons side by side, wrapping to a new line when they don't fit. */
    fun buttons(vararg views: View) = FlowLayout(context, dp(8)).apply { for (v in views) addView(v) }

    fun selectable(): Int = TypedValue().also { context.theme.resolveAttribute(android.R.attr.selectableItemBackground, it, true) }.resourceId
}
