package dev.iliyasone.ciao

import android.animation.ValueAnimator
import android.content.Context
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.view.View
import android.view.animation.LinearInterpolator

/** The Ciao icon floating above the keyboard; a ring around it shows the mic level or a spinner. */
class BubbleView(context: Context) : View(context) {
    enum class State { IDLE, RECORDING, FINISHING }

    var state = State.IDLE
        set(v) {
            field = v
            if (v == State.FINISHING) spinner.start() else spinner.cancel()
            invalidate()
        }

    /** Mean absolute mic level, 0..32768; smoothed here. */
    var level = 0.0
        set(v) {
            field = v
            smooth += (minOf(v / 2500.0, 1.0) - smooth) * 0.35
            invalidate()
        }

    private var smooth = 0.0
    private val density = resources.displayMetrics.density
    private val icon = BitmapFactory.decodeResource(resources, R.drawable.bubble)
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val accent = context.getColor(R.color.accent)
    private val ring = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = accent
    }
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = accent }
    private val dst = RectF()
    private var sweepStart = 0f
    private val spinner = ValueAnimator.ofFloat(0f, 360f).apply {
        duration = 900
        repeatCount = ValueAnimator.INFINITE
        interpolator = LinearInterpolator()
        addUpdateListener {
            sweepStart = it.animatedValue as Float
            invalidate()
        }
    }

    override fun onDraw(canvas: Canvas) {
        val cx = width / 2f
        val cy = height / 2f
        val iconSize = ICON_DP * density
        when (state) {
            State.IDLE -> iconPaint.alpha = 235
            State.RECORDING -> {
                iconPaint.alpha = 255
                glow.alpha = (60 + smooth * 110).toInt()
                canvas.drawCircle(cx, cy, iconSize / 2f + (4 + smooth * 8).toFloat() * density, glow)
            }
            State.FINISHING -> iconPaint.alpha = 160
        }
        dst.set(cx - iconSize / 2, cy - iconSize / 2, cx + iconSize / 2, cy + iconSize / 2)
        canvas.drawBitmap(icon, null, dst, iconPaint)
        if (state == State.FINISHING) {
            ring.strokeWidth = 3 * density
            val r = iconSize / 2 + 5 * density
            canvas.drawArc(cx - r, cy - r, cx + r, cy + r, sweepStart, 100f, false, ring)
        }
    }

    override fun onDetachedFromWindow() {
        spinner.cancel()
        super.onDetachedFromWindow()
    }

    companion object {
        const val ICON_DP = 44
        /** The window is larger than the icon so the level glow has room. */
        const val SIZE_DP = 68
    }
}
