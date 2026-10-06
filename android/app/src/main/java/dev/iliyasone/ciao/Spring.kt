package dev.iliyasone.ciao

import android.view.Choreographer
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.sqrt

/**
 * A damped spring pulling a point towards a target, stepped once per frame; it is what makes the
 * bubble glide (and, thrown, overshoot a little) instead of jumping. [onFrame] gets each new
 * position, [onEnd] the moment it comes to rest on the target.
 */
class Spring(
    private val onFrame: (x: Float, y: Float) -> Unit,
    private val onEnd: () -> Unit = {},
) : Choreographer.FrameCallback {
    var x = 0f
        private set
    var y = 0f
        private set
    private var vx = 0f
    private var vy = 0f
    private var toX = 0f
    private var toY = 0f
    private var lastFrameNanos = 0L

    var running = false
        private set

    /** Starts from ([fromX], [fromY]) moving at ([velX], [velY]) px/s, or retargets a running spring. */
    fun animate(fromX: Float, fromY: Float, targetX: Float, targetY: Float, velX: Float = 0f, velY: Float = 0f) {
        if (!running) {
            x = fromX
            y = fromY
            vx = velX
            vy = velY
            running = true
            lastFrameNanos = 0L
            Choreographer.getInstance().postFrameCallback(this)
        }
        toX = targetX
        toY = targetY
    }

    fun cancel() {
        if (!running) return
        running = false
        Choreographer.getInstance().removeFrameCallback(this)
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) return
        // The first frame has no previous one to measure against; a stalled one is capped.
        val dt = if (lastFrameNanos == 0L) 1 / 60f else min((frameTimeNanos - lastFrameNanos) / 1e9f, 1 / 20f)
        lastFrameNanos = frameTimeNanos
        step(dt)
        if (abs(toX - x) < REST_PX && abs(toY - y) < REST_PX && abs(vx) < REST_VELOCITY && abs(vy) < REST_VELOCITY) {
            x = toX
            y = toY
            running = false
            onFrame(x, y)
            onEnd()
            return
        }
        onFrame(x, y)
        Choreographer.getInstance().postFrameCallback(this)
    }

    /** Exact solution of the underdamped spring over [dt], so a long frame can't make it blow up. */
    private fun step(dt: Float) {
        val (nx, nvx) = solve(x - toX, vx, dt)
        val (ny, nvy) = solve(y - toY, vy, dt)
        x = toX + nx
        vx = nvx
        y = toY + ny
        vy = nvy
    }

    private fun solve(offset: Float, velocity: Float, t: Float): Pair<Float, Float> {
        val w0 = sqrt(STIFFNESS)
        val wd = w0 * sqrt(1 - DAMPING * DAMPING)
        val a = offset
        val b = (velocity + DAMPING * w0 * offset) / wd
        val decay = exp(-DAMPING * w0 * t)
        val cos = kotlin.math.cos(wd * t)
        val sin = kotlin.math.sin(wd * t)
        val pos = decay * (a * cos + b * sin)
        val vel = decay * ((b * wd - DAMPING * w0 * a) * cos - (a * wd + DAMPING * w0 * b) * sin)
        return pos to vel
    }

    private companion object {
        /** Natural frequency squared (1/s²) and damping ratio: quick, with a small overshoot. */
        const val STIFFNESS = 380f
        const val DAMPING = 0.72f
        const val REST_PX = 0.5f
        const val REST_VELOCITY = 20f
    }
}
