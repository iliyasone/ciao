package dev.iliyasone.ciao

import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.text.LineBreaker
import android.os.SystemClock
import android.text.Layout as TextLayout
import android.text.SpannableString
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.AbsoluteSizeSpan
import android.text.style.ForegroundColorSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.TextView
import java.text.NumberFormat
import java.util.Locale

/**
 * The live card at the top of the screen: what you say appears word by word, new words bright and
 * settling to grey (as in src/renderer/overlay/Overlay.tsx), laid out in paragraphs and lists.
 */
class CardView(
    context: Context,
    private val onCancel: () -> Unit,
    private val onDone: () -> Unit,
    private val onRetry: () -> Unit,
) : LinearLayout(context) {
    enum class Phase { RECORDING, FINISHING, DONE, CLIPBOARD, FAILED }

    private class Token(val text: String, val at: Long)

    private val density = resources.displayMetrics.density
    private fun dp(v: Number) = (v.toFloat() * density).toInt()

    private val settledColor = context.getColor(R.color.settled)
    private val freshColor = context.getColor(R.color.fresh)
    private val faintColor = context.getColor(R.color.faint)

    private val dot = View(context).apply {
        background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(context.getColor(R.color.accent))
        }
    }
    private val spinner = ProgressBar(context).apply { isIndeterminate = true }
    private val statusIcon = ImageView(context)
    private val clock = TextView(context).apply {
        setTextColor(faintColor)
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
        typeface = Typeface.create(Typeface.DEFAULT, Typeface.NORMAL)
        fontFeatureSettings = "tnum"
    }
    private val cancelButton = iconButton(R.drawable.ic_close, R.string.cancel) { onCancel() }
    private val doneButton = iconButton(R.drawable.ic_check, R.string.done) { onDone() }
    private val retryButton = iconButton(R.drawable.ic_retry, R.string.retry) { onRetry() }
    private val body = TextView(context).apply {
        setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f)
        setLineSpacing(0f, 1.15f)
        setTextColor(settledColor)
        // Greedy line breaking: text cut at a line start (see render) wraps exactly as it did uncut.
        breakStrategy = LineBreaker.BREAK_STRATEGY_SIMPLE // a constant, inlined: fine below API 29
        hyphenationFrequency = TextLayout.HYPHENATION_FREQUENCY_NONE
    }
    private val scroller = object : ScrollView(context) {
        override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
            super.onMeasure(widthMeasureSpec, MeasureSpec.makeMeasureSpec(dp(MAX_TEXT_DP), MeasureSpec.AT_MOST))
        }
    }.apply {
        isVerticalScrollBarEnabled = false
        addView(body)
    }

    private var phase = Phase.RECORDING
    private var startedAt = 0L
    private var endedAt = 0L
    private var showCost = true
    private var costPerMinute = 0.017
    private var layoutText = true

    private var settled = ""
    private val fresh = mutableListOf<Token>()
    private val pauses = mutableListOf<Pause>()
    private var final: String? = null
    private var message: String? = null
    private var stick = true
    /** The text changed since the last render (the clock alone doesn't rebuild it). */
    private var dirty = true
    /**
     * Until the final text arrives, the card holds the last lines only: laying out a long dictation
     * in full every frame made it lag. They start [shownFrom] into the laid-out text, always at a
     * line start, and [cutOff] is what is left out: should a revision change it, the text is shown
     * whole again.
     */
    private var shownFrom = 0
    private var cutOff = ""
    private var finalShown = false

    private val tick = object : Runnable {
        override fun run() {
            render()
            if (phase == Phase.RECORDING || fresh.isNotEmpty()) postDelayed(this, 60)
        }
    }

    init {
        orientation = VERTICAL
        setPadding(dp(18), dp(10), dp(10), dp(14))
        background = GradientDrawable().apply {
            cornerRadius = dp(22).toFloat()
            setColor(context.getColor(R.color.overlay))
            setStroke(dp(1), Color.argb(26, 128, 128, 128))
        }
        elevation = dp(10).toFloat()

        val status = FrameLayout(context).apply {
            addView(dot, FrameLayout.LayoutParams(dp(10), dp(10), Gravity.CENTER))
            addView(spinner, FrameLayout.LayoutParams(dp(16), dp(16), Gravity.CENTER))
            addView(statusIcon, FrameLayout.LayoutParams(dp(18), dp(18), Gravity.CENTER))
        }
        val header = LinearLayout(context).apply {
            orientation = HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            addView(status, LayoutParams(dp(20), dp(20)))
            addView(clock, LayoutParams(0, LayoutParams.WRAP_CONTENT, 1f).apply { marginStart = dp(10) })
            addView(retryButton, LayoutParams(dp(36), dp(36)))
            addView(cancelButton, LayoutParams(dp(36), dp(36)))
            addView(doneButton, LayoutParams(dp(36), dp(36)))
        }
        addView(header, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
        addView(scroller, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT).apply { marginEnd = dp(8) })
        scroller.setOnScrollChangeListener { v, _, y, _, _ ->
            val child = (v as ScrollView).getChildAt(0)
            stick = y + v.height >= child.height - dp(8)
        }
    }

    private fun iconButton(icon: Int, label: Int, onClick: () -> Unit) = ImageView(context).apply {
        setImageResource(icon)
        setColorFilter(context.getColor(R.color.muted))
        contentDescription = context.getString(label)
        setPadding(dp(8), dp(8), dp(8), dp(8))
        val ripple = TypedValue()
        context.theme.resolveAttribute(android.R.attr.selectableItemBackgroundBorderless, ripple, true)
        setBackgroundResource(ripple.resourceId)
        setOnClickListener { onClick() }
    }

    fun begin(showCost: Boolean, costPerMinute: Double, layoutText: Boolean) {
        this.showCost = showCost
        this.costPerMinute = costPerMinute
        this.layoutText = layoutText
        settled = ""
        fresh.clear()
        pauses.clear()
        final = null
        message = null
        stick = true
        shownFrom = 0
        cutOff = ""
        finalShown = false
        dirty = true
        startedAt = SystemClock.elapsedRealtime()
        endedAt = 0
        setPhase(Phase.RECORDING)
    }

    /** [gapMs]: time since the previous delta (a long gap = the speaker paused). */
    fun delta(text: String, gapMs: Long) {
        val t = if (settled.isEmpty() && fresh.isEmpty()) text.trimStart() else text
        if (t.isEmpty()) return
        val at = settled.length + fresh.sumOf { it.text.length }
        if (gapMs >= LiveLayout.PARAGRAPH_PAUSE_MS && at > 0) pauses.add(Pause(at, gapMs))
        fresh.add(Token(t, SystemClock.elapsedRealtime()))
        dirty = true
        removeCallbacks(tick)
        tick.run()
    }

    /**
     * The whole text so far, changed somewhere (Gemini revising its guess): keep what stayed the same
     * as it is, and fade in the rest as new. As the "revise" action in src/renderer/overlay/Overlay.tsx.
     */
    fun revise(text: String, gapMs: Long) {
        val next = text.trimStart()
        val full = settled + fresh.joinToString("") { it.text }
        val (same, moved) = Revision.revisePauses(full, next, pauses, gapMs)
        pauses.clear()
        pauses.addAll(moved)
        val kept = mutableListOf<Token>()
        if (same >= settled.length) {
            var at = settled.length
            for (t in fresh) {
                if (at + t.text.length <= same) kept.add(t)
                else if (same > at) kept.add(Token(t.text.substring(0, same - at), t.at))
                if (at + t.text.length >= same) break
                at += t.text.length
            }
        } else {
            settled = settled.substring(0, same)
        }
        fresh.clear()
        fresh.addAll(kept)
        val rest = next.substring(same)
        if (rest.isNotEmpty()) fresh.add(Token(rest, SystemClock.elapsedRealtime()))
        dirty = true
        removeCallbacks(tick)
        tick.run()
    }

    fun final(text: String) {
        final = text
        // Nothing left to fade: a long final text is laid out once, not every frame.
        for (t in fresh) settled += t.text
        fresh.clear()
        dirty = true
        render()
    }

    /** [retry]: a FAILED card that kept the recording, with a button to transcribe it again. */
    fun setPhase(p: Phase, message: String? = null, retry: Boolean = false) {
        // An offline or mic notice is over once the text is in; a failure note once it is retried.
        if (message != null) this.message = message
        else if (p == Phase.DONE || phase == Phase.FAILED) this.message = null
        phase = p
        dirty = true
        if (p != Phase.RECORDING && endedAt == 0L) endedAt = SystemClock.elapsedRealtime()
        dot.visibility = if (p == Phase.RECORDING) VISIBLE else GONE
        spinner.visibility = if (p == Phase.FINISHING) VISIBLE else GONE
        statusIcon.visibility = if (p == Phase.DONE || p == Phase.CLIPBOARD || p == Phase.FAILED) VISIBLE else GONE
        when (p) {
            Phase.DONE -> statusIcon.setImageResource(R.drawable.ic_check).also { statusIcon.setColorFilter(context.getColor(R.color.ok)) }
            Phase.CLIPBOARD -> statusIcon.setImageResource(R.drawable.ic_clipboard).also { statusIcon.setColorFilter(context.getColor(R.color.warn)) }
            Phase.FAILED -> statusIcon.setImageResource(R.drawable.ic_warning).also { statusIcon.setColorFilter(context.getColor(R.color.warn)) }
            else -> {}
        }
        doneButton.visibility = if (p == Phase.RECORDING) VISIBLE else GONE
        retryButton.visibility = if (retry) VISIBLE else GONE
        cancelButton.visibility = if (p == Phase.RECORDING || p == Phase.FINISHING || retry) VISIBLE else INVISIBLE
        removeCallbacks(tick)
        tick.run()
    }

    /** A note in the header instead of the timer (offline, mic trouble), while recording too. */
    fun notice(text: String) {
        message = text
        render()
    }

    /** Mic level for the recording dot, 0..32768. */
    fun level(level: Double) {
        val s = 1f + minOf(level / 2500.0, 1.0).toFloat() * 0.7f
        dot.scaleX = s
        dot.scaleY = s
    }

    private fun render() {
        val now = SystemClock.elapsedRealtime()
        val elapsed = (if (endedAt != 0L) endedAt else now) - startedAt
        val secs = elapsed / 1000
        val time = "%d:%02d".format(secs / 60, secs % 60)
        val status = when {
            message != null -> message
            showCost -> "$time · ${formatCost(elapsed / 60_000.0 * costPerMinute)}"
            else -> time
        }
        if (clock.text.toString() != status) clock.text = status
        // Every frame, as the text grows: a scroll animating to an older bottom would end short of it.
        if (stick) scroller.post { scroller.smoothScrollTo(0, body.height) }

        // Fading words redraw every frame; otherwise only a change does.
        if (!dirty && fresh.isEmpty()) return
        dirty = false
        // Merge settled tokens into plain text.
        while (fresh.isNotEmpty() && now - fresh[0].at > FRESH_MS) settled += fresh.removeAt(0).text

        val f = final
        // Laid out once (a long final is costly, and finishing marks the card dirty again), as plain
        // text: the live frame before it may hold the same words in fading colours.
        if (f != null && finalShown) return
        finalShown = f != null
        body.text = when {
            f != null -> f.also { shownFrom = 0 }
            settled.isEmpty() && fresh.isEmpty() -> SpannableStringBuilder("…").apply {
                setSpan(ForegroundColorSpan(context.getColor(R.color.ghost)), 0, 1, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            }
            else -> lastLines(liveText(now))
        }
    }

    /** The laid-out text, colour runs and paragraph gaps by offset (settled text needs no span: it is the body's colour). */
    private class Live(val text: StringBuilder, val runs: List<Run>, val gaps: List<Int>)

    private class Run(val from: Int, var to: Int, val color: Int)

    /** [live] from [shownFrom] on, dropping more lines off the top once there are many. */
    private fun lastLines(live: Live): CharSequence {
        val text = live.text
        val kept = shownFrom == 0 || text.startsWith(cutOff)
        if (!kept) {
            shownFrom = 0
            cutOff = ""
        }
        val l = body.layout
        val shown = body.text
        if (kept && stick && l != null && l.text.length == shown.length && l.lineCount > MAX_LINES && shownFrom + shown.length <= text.length) {
            val line = l.lineCount - KEEP_LINES
            var drop = l.getLineStart(line)
            // Only where the text up to there is still the same, so that is still a line start (a
            // revision of the word right after could wrap that one line differently: cosmetic).
            if (text.substring(shownFrom, shownFrom + drop) == shown.substring(0, drop)) {
                while (shownFrom + drop < text.length && text[shownFrom + drop] == '\n') drop++
                shownFrom += drop
                // The scroller is at the bottom; with less above, its next layout clamps it there again.
                cutOff = text.substring(0, shownFrom)
            }
        }
        val out = SpannableString(text.substring(shownFrom))
        for (r in live.runs) {
            val from = maxOf(r.from, shownFrom) - shownFrom
            val to = r.to - shownFrom
            if (to > from) out.setSpan(ForegroundColorSpan(r.color), from, to, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        }
        for (g in live.gaps) if (g >= shownFrom) out.setSpan(AbsoluteSizeSpan(dp(8)), g - shownFrom, g - shownFrom + 2, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
        return out
    }

    /** The live text with its layout applied, each fresh token coloured by its age. */
    private fun liveText(now: Long): Live {
        val full = settled + fresh.joinToString("") { it.text }
        // Where each colour ends: the settled text, then each fresh token.
        val ends = IntArray(fresh.size + 1)
        val colors = IntArray(fresh.size + 1)
        ends[0] = settled.length
        colors[0] = settledColor
        for ((k, t) in fresh.withIndex()) {
            ends[k + 1] = ends[k] + t.text.length
            colors[k + 1] = tokenColor(now - t.at)
        }
        var span = 0
        fun colorAt(i: Int): Int {
            while (span < ends.size - 1 && i >= ends[span]) span++
            return colors[span]
        }
        val l = if (layoutText) LiveLayout.layout(full, pauses) else Layout(emptyList(), emptyList())
        val breakAt = l.breaks.associateBy { it.at }
        val editAt = l.edits.associateBy { it.start }
        // Breaks and edits in order: the text between two of them is copied as is.
        val marks = (breakAt.keys + editAt.keys).sorted()
        var mark = 0
        val out = StringBuilder(full.length + 64)
        val runs = mutableListOf<Run>()
        val gaps = mutableListOf<Int>()
        fun add(s: CharSequence, color: Int) {
            val from = out.length
            out.append(s)
            if (color == settledColor) return
            val last = runs.lastOrNull()
            if (last != null && last.to == from && last.color == color) last.to = out.length else runs.add(Run(from, out.length, color))
        }
        var i = 0
        while (i < full.length) {
            val b = breakAt[i]
            if (b != null && i > 0) {
                // Trailing spaces would start the new line with a gap.
                while (out.isNotEmpty() && out[out.length - 1] == ' ') out.setLength(out.length - 1)
                while (runs.isNotEmpty() && runs.last().to > out.length) {
                    val last = runs.last()
                    if (last.from >= out.length) runs.removeAt(runs.size - 1) else last.to = out.length
                }
                if (b is Break.Paragraph) {
                    gaps.add(out.length)
                    add("\n\n", settledColor)
                } else {
                    add("\n", settledColor)
                }
            }
            if (b is Break.Item) add("${b.n}. ", faintColor)
            val e = editAt[i]
            if (e != null) {
                add(e.insert, colorAt(i))
                i = e.end
            } else {
                // Up to the next break or edit, or where the colour changes.
                while (mark < marks.size && marks[mark] <= i) mark++
                val c = colorAt(i)
                val j = minOf(if (mark < marks.size) marks[mark] else full.length, ends[span])
                add(full.subSequence(i, j), c)
                i = j
            }
        }
        return Live(out, runs, gaps)
    }

    /** Fades in bright, then settles to grey over FRESH_MS. */
    private fun tokenColor(age: Long): Int {
        val fadeIn = (age / 180f).coerceIn(0f, 1f)
        val settle = ((age - 400f) / (FRESH_MS - 400f)).coerceIn(0f, 1f)
        val c = blend(freshColor, settledColor, settle)
        return Color.argb((Color.alpha(c) * (0.15f + 0.85f * fadeIn)).toInt(), Color.red(c), Color.green(c), Color.blue(c))
    }

    private fun blend(a: Int, b: Int, t: Float): Int = Color.argb(
        255,
        (Color.red(a) + (Color.red(b) - Color.red(a)) * t).toInt(),
        (Color.green(a) + (Color.green(b) - Color.green(a)) * t).toInt(),
        (Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t).toInt(),
    )

    override fun onDetachedFromWindow() {
        removeCallbacks(tick)
        super.onDetachedFromWindow()
    }

    companion object {
        private const val FRESH_MS = 1250L
        private const val MAX_TEXT_DP = 25 * 6 // six lines, then it scrolls
        /** Past this many lines while recording, the card drops the top ones down to [KEEP_LINES]. */
        private const val MAX_LINES = 60
        private const val KEEP_LINES = 30

        /** "0,4 ¢" under a dollar, "$1.23" above; as formatCost in src/core/cost.ts. */
        fun formatCost(usd: Double): String {
            if (usd >= 1) return "$" + "%.2f".format(Locale.US, usd)
            val cents = usd * 100
            val digits = if (cents < 10) 1 else 0
            val nf = NumberFormat.getNumberInstance(Locale("ru", "RU")).apply {
                minimumFractionDigits = digits
                maximumFractionDigits = digits
            }
            return "${nf.format(cents)} ¢"
        }
    }
}
