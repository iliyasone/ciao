package dev.iliyasone.ciao

import android.app.Activity
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Bundle
import android.text.format.DateUtils
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.roundToInt

/**
 * What dictation cost and how much was said, per period: the desktop's Usage tab
 * (src/renderer/history/UsagePanel.tsx), drawn from [Usage.summarize].
 */
class UsageActivity : Activity() {
    private var entries: List<Usage.Entry> = emptyList()
    private var window = 30
    private var cost = true
    private lateinit var body: LinearLayout
    private lateinit var windows: LinearLayout
    private lateinit var metrics: LinearLayout
    private val density get() = resources.displayMetrics.density
    private fun dp(v: Number) = (v.toFloat() * density).toInt()

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Ui.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val title = TextView(this).apply {
            setText(R.string.usage_title)
            textSize = 22f
            setTextColor(getColor(R.color.fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        windows = LinearLayout(this)
        metrics = LinearLayout(this)
        body = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        setContentView(ScrollView(this).apply {
            addView(LinearLayout(this@UsageActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(dp(20), dp(28), dp(20), dp(40))
                addView(title)
                addView(HorizontalScrollView(this@UsageActivity).apply {
                    isHorizontalScrollBarEnabled = false
                    addView(windows)
                }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(12) })
                addView(metrics, LinearLayout.LayoutParams(-2, -2).apply { topMargin = dp(8) })
                addView(body)
            })
        })
    }

    override fun onResume() {
        super.onResume()
        Thread {
            val list = History(File(filesDir, "history")).list().map(Usage::of)
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                entries = list
                render()
            }
        }.start()
    }

    private fun windowLabel(w: Int) = getString(
        when (w) {
            1 -> R.string.usage_window_day
            7 -> R.string.usage_window_week
            30 -> R.string.usage_window_month
            90 -> R.string.usage_window_quarter
            else -> R.string.usage_window_all
        },
    )

    private fun render() {
        segmented(windows, Usage.WINDOWS.map { windowLabel(it) to (it == window) }) { i -> window = Usage.WINDOWS[i]; render() }
        segmented(metrics, listOf(getString(R.string.usage_metric_cost) to cost, getString(R.string.usage_metric_minutes) to !cost)) { i -> cost = i == 0; render() }

        val s = Usage.summarize(entries, window, System.currentTimeMillis())
        body.removeAllViews()
        val since = DateUtils.formatDateTime(this, s.from, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_SHOW_YEAR)
        val perDay = if (s.activeDays > 0) s.total.usd / s.activeDays else 0.0
        val tiles = listOf(
            Triple(R.string.usage_cost, CardView.formatCost(s.total.usd), getString(R.string.usage_since, since)),
            Triple(R.string.usage_spoken, duration(s.total.ms), null),
            Triple(R.string.usage_dictations, s.total.count.toString(), null),
            Triple(R.string.usage_per_day, CardView.formatCost(perDay), if (s.activeDays > 0) getString(R.string.usage_per_day_hint, s.activeDays) else null),
        )
        for (pair in tiles.chunked(2)) {
            body.addView(LinearLayout(this).apply {
                for ((i, t) in pair.withIndex()) addView(tile(getString(t.first), t.second, t.third), LinearLayout.LayoutParams(0, -2, 1f).apply { if (i > 0) leftMargin = dp(8) })
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(8) })
        }
        if (s.total.count == 0) {
            body.addView(small(getString(R.string.usage_empty), R.color.faint).apply { textSize = 15f; setPadding(0, dp(24), 0, 0) })
        } else {
            body.addView(Chart(this, s, cost), LinearLayout.LayoutParams(-1, dp(220)).apply { topMargin = dp(16) })
            body.addView(models(s))
        }
        body.addView(small(getString(R.string.usage_note), R.color.ghost).apply { setPadding(0, dp(20), 0, 0) })
    }

    private fun duration(ms: Long): String {
        val m = ((ms + 30_000) / 60_000).toInt()
        return if (m < 60) getString(R.string.usage_minutes, m) else getString(R.string.usage_hours, m / 60, m % 60)
    }

    private fun rounded(color: Int, radius: Float = 12f) = GradientDrawable().apply {
        setColor(color)
        cornerRadius = radius * density
    }

    private fun tint(alpha: Float) = Color.argb((alpha * 255).roundToInt(), Color.red(getColor(R.color.fg)), Color.green(getColor(R.color.fg)), Color.blue(getColor(R.color.fg)))

    private fun segmented(row: LinearLayout, options: List<Pair<String, Boolean>>, onPick: (Int) -> Unit) {
        row.removeAllViews()
        row.background = rounded(tint(0.05f))
        row.setPadding(dp(2), dp(2), dp(2), dp(2))
        for ((i, o) in options.withIndex()) {
            row.addView(TextView(this).apply {
                text = o.first
                textSize = 13f
                setTextColor(getColor(if (o.second) R.color.fg else R.color.muted))
                setPadding(dp(12), dp(6), dp(12), dp(6))
                background = if (o.second) rounded(getColor(R.color.card), 10f) else null
                setOnClickListener { onPick(i) }
            })
        }
    }

    private fun tile(label: String, value: String, hint: String?) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        setBackgroundResource(R.drawable.card_bg)
        setPadding(dp(14), dp(10), dp(14), dp(10))
        addView(small(label, R.color.faint))
        addView(TextView(this@UsageActivity).apply {
            text = value
            textSize = 20f
            setTextColor(getColor(R.color.fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        })
        if (hint != null) addView(small(hint, R.color.ghost).apply { setSingleLine() })
    }

    private fun models(s: Usage.Summary) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(small(getString(R.string.usage_by_model), R.color.faint).apply {
            isAllCaps = true
            letterSpacing = 0.06f
            textSize = 13f
            setPadding(0, dp(20), 0, dp(6))
        })
        val value = { t: Usage.Totals -> if (cost) t.usd else t.ms.toDouble() }
        val total = s.models.sumOf { value(it.totals) }
        val list = LinearLayout(this@UsageActivity).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundResource(R.drawable.card_bg)
            setPadding(dp(14), dp(4), dp(14), dp(4))
        }
        for (m in s.models) {
            val share = if (total > 0) value(m.totals) / total else 0.0
            list.addView(LinearLayout(this@UsageActivity).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(8), 0, dp(8))
                addView(LinearLayout(this@UsageActivity).apply {
                    gravity = Gravity.CENTER_VERTICAL
                    addView(View(this@UsageActivity).apply { background = rounded(COLORS.getValue(m.provider), 3f) }, LinearLayout.LayoutParams(dp(8), dp(8)).apply { rightMargin = dp(8) })
                    addView(TextView(this@UsageActivity).apply {
                        text = m.model
                        textSize = 14f
                        setTextColor(getColor(R.color.fg))
                        setSingleLine()
                    }, LinearLayout.LayoutParams(0, -2, 1f))
                    addView(TextView(this@UsageActivity).apply {
                        text = CardView.formatCost(m.totals.usd)
                        textSize = 14f
                        setTextColor(getColor(R.color.fg))
                        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
                    })
                })
                addView(small("${(share * 100).roundToInt()}% · ${m.totals.count} · ${duration(m.totals.ms)}", R.color.faint).apply { setPadding(dp(16), dp(2), 0, 0) })
            })
        }
        addView(list)
    }

    private fun small(s: String, color: Int) = TextView(this).apply {
        text = s
        textSize = 12f
        setTextColor(getColor(color))
    }

    /** Stacked columns per day (per hour), as the desktop's chart; touch a column to read it. */
    private inner class Chart(context: Context, val s: Usage.Summary, val cost: Boolean) : View(context) {
        private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
        private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 10 * density; color = getColor(R.color.ghost) }
        private val head = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 12 * density; color = getColor(R.color.faint) }
        private var picked: Int? = null
        private val rect = RectF()

        init {
            background = context.getDrawable(R.drawable.card_bg)
        }

        private fun value(t: Usage.Totals) = if (cost) t.usd else t.ms / 60_000.0
        private fun format(v: Double) = if (cost) CardView.formatCost(v) else duration((v * 60_000).toLong())
        private fun label(c: Usage.Column) =
            if (s.hourly) DateUtils.formatDateTime(context, c.start, DateUtils.FORMAT_SHOW_TIME)
            else DateUtils.formatDateTime(context, c.start, DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_NO_YEAR or DateUtils.FORMAT_ABBREV_MONTH)

        private val left get() = dp(44).toFloat()
        private val slot get() = (width - left - dp(12)) / s.columns.size

        override fun onTouchEvent(e: MotionEvent): Boolean {
            picked = ((e.x - left) / slot).toInt().takeIf { it in s.columns.indices && e.action != MotionEvent.ACTION_CANCEL }
            parent.requestDisallowInterceptTouchEvent(e.action != MotionEvent.ACTION_UP)
            invalidate()
            return true
        }

        override fun onDraw(canvas: Canvas) {
            val top = dp(36).toFloat()
            val bottom = height - dp(24).toFloat()
            val right = width - dp(12).toFloat()
            val max = max(s.columns.maxOf { value(it.total) }, if (cost) 0.01 else 1.0)
            val step = niceStep(max / 3)
            val ceiling = ceil(max / step) * step
            val y = { v: Double -> (bottom - v / ceiling * (bottom - top)).toFloat() }

            // The heading: the touched column, else the legend.
            val shown = picked?.let { s.columns[it] }
            var x = dp(14).toFloat()
            val headY = dp(22).toFloat()
            if (shown != null) {
                head.color = getColor(R.color.fg)
                canvas.drawText(label(shown), x, headY, head)
                x += head.measureText(label(shown)) + dp(12)
                head.color = getColor(R.color.faint)
                canvas.drawText("${CardView.formatCost(shown.total.usd)} · ${duration(shown.total.ms)}", x, headY, head)
            } else {
                for (p in Usage.PROVIDERS.filter { p -> s.columns.any { value(it.byProvider.getValue(p)) > 0 } }) {
                    paint.color = COLORS.getValue(p)
                    rect.set(x, headY - dp(8), x + dp(8), headY)
                    canvas.drawRoundRect(rect, dp(2).toFloat(), dp(2).toFloat(), paint)
                    x += dp(12)
                    val name = providerName(p)
                    canvas.drawText(name, x, headY, head)
                    x += head.measureText(name) + dp(14)
                }
            }

            paint.color = tint(0.07f)
            var t = 0.0
            while (t <= ceiling + step / 2) {
                canvas.drawRect(left, y(t), right, y(t) + density, paint)
                val l = if (cost) CardView.formatCost(t) else t.roundToInt().toString()
                canvas.drawText(l, left - dp(6) - text.measureText(l), y(t) + dp(3.5), text)
                t += step
            }
            val bar = max(density, min(dp(16).toFloat(), slot * 0.7f))
            val every = max(1, ceil(s.columns.size / 4.0).toInt())
            for ((i, c) in s.columns.withIndex()) {
                val x0 = left + i * slot
                if (i == picked) {
                    paint.color = tint(0.05f)
                    canvas.drawRect(x0, top, x0 + slot, bottom, paint)
                }
                var base = 0.0
                for (p in Usage.PROVIDERS) {
                    val v = value(c.byProvider.getValue(p))
                    if (v <= 0) continue
                    paint.color = COLORS.getValue(p)
                    rect.set(x0 + (slot - bar) / 2, y(base + v), x0 + (slot + bar) / 2, max(y(base), y(base + v) + density / 2))
                    canvas.drawRoundRect(rect, min(dp(3).toFloat(), bar / 4), min(dp(3).toFloat(), bar / 4), paint)
                    base += v
                }
                if (i % every == (s.columns.size - 1) % every) {
                    val l = label(c)
                    val w = text.measureText(l)
                    canvas.drawText(l, min(right - w, max(left, x0 + slot / 2 - w / 2)), height - dp(8).toFloat(), text)
                }
            }
        }
    }

    private fun providerName(p: String) = when (p) {
        "openai" -> Provider.OPENAI.displayName
        "gemini" -> Provider.GEMINI.displayName
        else -> getString(R.string.usage_other)
    }

    companion object {
        /** As COLORS in src/renderer/history/UsagePanel.tsx. */
        val COLORS = mapOf("openai" to Color.parseColor("#10A37F"), "gemini" to Color.parseColor("#4C8DF6"), "other" to Color.parseColor("#A1A1AA"))

        /** 1, 2 or 5 times a power of ten, at least [raw]. */
        fun niceStep(raw: Double): Double {
            val power = 10.0.pow(floor(log10(raw)))
            return listOf(1.0, 2.0, 5.0, 10.0).map { it * power }.first { it >= raw }
        }
    }
}
