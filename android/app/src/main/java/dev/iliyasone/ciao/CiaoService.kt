package dev.iliyasone.ciao

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.HapticFeedbackConstants
import android.view.MotionEvent
import android.view.VelocityTracker
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import android.view.animation.DecelerateInterpolator
import android.widget.FrameLayout
import android.widget.Toast
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileOutputStream
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Shows the Ciao bubble whenever a keyboard is up over a text field. Tap it to dictate (tap again,
 * or say "чао-чао", to finish), or hold it to talk and let go. While you speak, the card at the top
 * of the screen shows the words live; when you finish, the text goes into the field you started in.
 */
class CiaoService : AccessibilityService() {
    private lateinit var prefs: Prefs
    private lateinit var pool: SessionPool
    private lateinit var wm: WindowManager
    private val main = Handler(Looper.getMainLooper())
    private val density get() = resources.displayMetrics.density
    private fun dp(v: Number) = (v.toFloat() * density).toInt()

    private var bubble: BubbleView? = null
    private lateinit var bubbleParams: WindowManager.LayoutParams
    private var cardHost: FrameLayout? = null
    private var card: CardView? = null
    private var imeTop = 0
    /** The keyboard top as last seen, and since when: the bubble waits for it to stop moving. */
    private var imeTopSeen = -1
    private var imeTopSince = 0L
    private val motion = Spring(onFrame = { x, y -> moveBubble(x.roundToInt(), y.roundToInt().coerceAtMost(glideFloor)) }, onEnd = { if (bubble?.alpha == 1f) setBubbleTouchable(true) })
    /** The lowest the current glide may go: one coming down stops at its spot instead of bouncing over the keys. */
    private var glideFloor = Int.MAX_VALUE
    private var dictation: Dictation? = null

    /** FAILED: not transcribed; the recording is kept on the card until you retry or dismiss it. */
    private enum class Phase { RECORDING, FINISHING, DONE, FAILED }

    private inner class Dictation(val target: AccessibilityNodeInfo?, val session: RealtimeSession, val pushToTalk: Boolean) {
        val startedAt = SystemClock.elapsedRealtime()
        var endedAt = 0L
        /** The recording, written as it comes in so a long one doesn't sit in memory; read back only for the file model. */
        val audioFile = File(cacheDir, "dictation-$startedAt.pcm")
        val audio = BufferedOutputStream(FileOutputStream(audioFile))
        var recorder: Recorder? = null
        var phase = Phase.RECORDING
        val liveText = StringBuilder()
        val pauses = mutableListOf<Pause>()
        var lastDeltaAt = 0L
        var final: String? = null
        var offline: String? = null
        var stoppedByPhrase = false

        @Volatile var heardAnything = false
    }

    private val refresh = Runnable { refreshBubble() }
    private val hideCardLater = Runnable { if (dictation == null) hideCard() }
    private val closePool = Runnable { pool.close() }

    override fun onServiceConnected() {
        prefs = Prefs(this)
        pool = SessionPool(this, prefs)
        wm = getSystemService(WindowManager::class.java)
        // Recordings left behind by a crash or a kill mid-dictation.
        cacheDir.listFiles { f -> f.name.startsWith("dictation-") }?.forEach { it.delete() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        main.removeCallbacks(refresh)
        main.postDelayed(refresh, 80)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        dictation?.let { cancel() }
        hideBubble()
        main.removeCallbacksAndMessages(null)
        if (::pool.isInitialized) pool.close()
        super.onDestroy()
    }

    // ── Bubble ───────────────────────────────────────────────────────────

    private fun refreshBubble() {
        val ime = runCatching { windows.firstOrNull { it.type == AccessibilityWindowInfo.TYPE_INPUT_METHOD } }.getOrNull()
        val field = runCatching { findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()
            ?.takeIf { it.isEditable && !it.isPassword }
        if (ime != null) {
            val top = Rect().also { ime.getBoundsInScreen(it) }.top
            val now = SystemClock.uptimeMillis()
            if (top != imeTopSeen) {
                imeTopSeen = top
                imeTopSince = now
            }
            // A keyboard sliding in (or changing height) reports where it is mid-way: placed against
            // that, the bubble would sit over the keys and then jump. Wait until it stops moving.
            val wait = imeTopSince + IME_SETTLE_MS - now
            if (wait > 0) {
                if (!touching) setBubbleTouchable(false)
                main.removeCallbacks(refresh)
                main.postDelayed(refresh, wait)
                return
            }
            imeTop = top
        } else {
            imeTopSeen = -1
        }
        if (!idle || (ime != null && field != null)) showBubble() else hideBubble()
    }

    private fun overlayParams(width: Int, height: Int, gravity: Int) = WindowManager.LayoutParams(
        width,
        height,
        WindowManager.LayoutParams.TYPE_ACCESSIBILITY_OVERLAY,
        WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
            WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or
            WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN or
            WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
        PixelFormat.TRANSLUCENT,
    ).apply {
        this.gravity = gravity
        // Screen coordinates, like the keyboard bounds we place the bubble against.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) fitInsetsTypes = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
    }

    private fun showBubble() {
        main.removeCallbacks(closePool)
        pool.refill()
        val size = dp(BubbleView.SIZE_DP)
        val lift = prefs.bubbleLift.takeIf { it >= 0 } ?: dp(DEFAULT_LIFT_DP)
        val x = if (prefs.bubbleLeft) 0 else resources.displayMetrics.widthPixels - size
        val y = (imeTop - lift - size).coerceAtLeast(statusBarHeight())
        val view = bubble
        if (view == null) {
            // Fades in where it belongs; until it has, a tap meant for the keyboard or the app goes to them.
            bubbleParams = overlayParams(size, size, Gravity.TOP or Gravity.START)
            bubbleParams.flags = bubbleParams.flags or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
            bubbleParams.x = x
            bubbleParams.y = y
            val v = BubbleView(this)
            v.setOnTouchListener(BubbleTouch())
            v.contentDescription = getString(R.string.bubble_description)
            v.alpha = 0f
            v.scaleX = APPEAR_SCALE
            v.scaleY = APPEAR_SCALE
            wm.addView(v, bubbleParams)
            bubble = v
            v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(APPEAR_MS).setInterpolator(DecelerateInterpolator())
                .withEndAction { if (bubble === v && !motion.running) setBubbleTouchable(true) }
            return
        }
        if (touching) return
        // Moving our own window raises another windows-changed event; don't loop on it, and leave a
        // glide that is already headed there (a throw, which stays catchable) alone.
        if (motion.running && motion.toX == x.toFloat() && motion.toY == y.toFloat()) return
        if (x != bubbleParams.x || y != bubbleParams.y) {
            // The keyboard changed under it: glide over, letting taps through to the keyboard meanwhile.
            setBubbleTouchable(false)
            glide(x, y)
        } else if (!motion.running && view.alpha == 1f) {
            setBubbleTouchable(true)
        }
    }

    private fun glide(x: Int, y: Int, vx: Float = 0f, vy: Float = 0f) {
        glideFloor = if (bubbleParams.y <= y) y else Int.MAX_VALUE
        motion.animate(bubbleParams.x.toFloat(), bubbleParams.y.toFloat(), x.toFloat(), y.toFloat(), vx, vy)
    }

    private fun moveBubble(x: Int, y: Int) {
        val v = bubble ?: return
        if (x == bubbleParams.x && y == bubbleParams.y) return
        bubbleParams.x = x
        bubbleParams.y = y
        wm.updateViewLayout(v, bubbleParams)
    }

    private fun setBubbleTouchable(touchable: Boolean) {
        val v = bubble ?: return
        val flag = WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
        val flags = if (touchable) bubbleParams.flags and flag.inv() else bubbleParams.flags or flag
        if (flags == bubbleParams.flags) return
        bubbleParams.flags = flags
        wm.updateViewLayout(v, bubbleParams)
    }

    private fun hideBubble() {
        val v = bubble ?: return
        motion.cancel()
        v.animate().cancel()
        runCatching { wm.removeView(v) }
        bubble = null
        // A touch cut short by the keyboard closing never gets its ACTION_UP.
        touching = false
        // Keep the warm connection a little, in case the keyboard comes right back.
        main.removeCallbacks(closePool)
        if (::pool.isInitialized) main.postDelayed(closePool, 120_000)
    }

    /** A finger is on the bubble: nothing else moves it meanwhile. */
    private var touching = false

    /** Tap: start / finish. Hold: talk while held. Drag: move it; let go and it glides to the nearer edge. */
    private inner class BubbleTouch : android.view.View.OnTouchListener {
        private var downX = 0f
        private var downY = 0f
        private var startX = 0
        private var startY = 0
        private var held = false
        private var dragging = false
        /** This touch stopped a gliding bubble: letting go sends it on, it isn't a tap. */
        private var caught = false
        private var velocity: VelocityTracker? = null
        private val slop = ViewConfiguration.get(this@CiaoService).scaledTouchSlop
        private val hold = Runnable {
            // The keyboard closed under the finger (hiding the bubble): no release will come.
            if (!touching) return@Runnable
            held = true
            start(pushToTalk = true)
        }

        @SuppressLint("ClickableViewAccessibility")
        override fun onTouch(v: android.view.View, e: MotionEvent): Boolean {
            when (e.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    // Caught mid-glide: it stays under the finger.
                    caught = motion.running
                    motion.cancel()
                    touching = true
                    downX = e.rawX
                    downY = e.rawY
                    startX = bubbleParams.x
                    startY = bubbleParams.y
                    held = false
                    dragging = false
                    velocity?.recycle()
                    velocity = VelocityTracker.obtain().also { track(it, e) }
                    press(v, PRESS_SCALE)
                    if (idle && !caught) main.postDelayed(hold, HOLD_MS)
                }
                MotionEvent.ACTION_MOVE -> {
                    velocity?.let { track(it, e) }
                    if (!dragging && !held && idle && hypot(e.rawX - downX, e.rawY - downY) > slop) {
                        dragging = true
                        main.removeCallbacks(hold)
                        // Measure from here, so the bubble doesn't jump by the slop it just waited out.
                        downX = e.rawX
                        downY = e.rawY
                        press(v, DRAG_SCALE)
                    }
                    if (dragging) moveBubble(startX + (e.rawX - downX).roundToInt(), startY + (e.rawY - downY).roundToInt())
                }
                MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                    main.removeCallbacks(hold)
                    touching = false
                    press(v, 1f)
                    val tracker = velocity
                    velocity = null
                    when {
                        dragging -> {
                            dragging = false
                            tracker?.computeCurrentVelocity(1000, MAX_FLING_DP_S * density)
                            val vx = tracker?.xVelocity ?: 0f
                            val vy = tracker?.yVelocity ?: 0f
                            fling(vx, vy)
                        }
                        // Stopped mid-glide, not a tap: let it carry on, still catchable.
                        caught -> glide(motion.toX.roundToInt(), motion.toY.roundToInt())
                        e.actionMasked == MotionEvent.ACTION_CANCEL -> if (held) stop()
                        held -> stop()
                        idle -> start(pushToTalk = false)
                        dictation?.phase == Phase.RECORDING -> stop()
                    }
                    held = false
                    // Placing it was held back while the finger was down (a keyboard change, a catch).
                    main.post(refresh)
                    tracker?.recycle()
                }
            }
            return true
        }

        /** The window moves with the finger, so track screen coordinates rather than the view's. */
        private fun track(tracker: VelocityTracker, e: MotionEvent) {
            val screen = MotionEvent.obtain(e)
            screen.setLocation(e.rawX, e.rawY)
            tracker.addMovement(screen)
            screen.recycle()
        }

        private fun press(v: android.view.View, scale: Float) {
            v.animate().scaleX(scale).scaleY(scale).setDuration(PRESS_MS).setInterpolator(DecelerateInterpolator())
        }

        /** Let go: carry on where the throw points, then settle at that side, above the keyboard. */
        private fun fling(vx: Float, vy: Float) {
            val size = dp(BubbleView.SIZE_DP)
            val x = bubbleParams.x + vx * FLING_PROJECTION_S
            val y = bubbleParams.y + vy * FLING_PROJECTION_S
            prefs.bubbleLeft = x + size / 2 < resources.displayMetrics.widthPixels / 2
            val top = statusBarHeight()
            val restY = y.roundToInt().coerceIn(top, maxOf(top, imeTop - size))
            prefs.bubbleLift = (imeTop - restY - size).coerceAtLeast(0)
            val restX = if (prefs.bubbleLeft) 0 else resources.displayMetrics.widthPixels - size
            // Half the throw's speed carries into the glide: enough to feel it, not enough to fly off the screen.
            glide(restX, restY, vx / 2, vy / 2)
        }
    }

    // ── Card ─────────────────────────────────────────────────────────────

    private fun showCard(): CardView {
        main.removeCallbacks(hideCardLater)
        card?.let { return it }
        val c = CardView(this, onCancel = { cancel() }, onDone = { stop() }, onRetry = { retry() })
        val host = FrameLayout(this).apply {
            setPadding(dp(10), dp(6), dp(10), dp(12))
            addView(c, FrameLayout.LayoutParams(minOf(resources.displayMetrics.widthPixels - dp(20), dp(640)), FrameLayout.LayoutParams.WRAP_CONTENT))
            clipToPadding = false
        }
        // As wide as the card, so taps beside it (tablets, landscape) reach the app underneath.
        val params = overlayParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, Gravity.TOP or Gravity.CENTER_HORIZONTAL)
        params.y = statusBarHeight()
        wm.addView(host, params)
        cardHost = host
        card = c
        return c
    }

    private fun hideCard() {
        cardHost?.let { runCatching { wm.removeView(it) } }
        cardHost = null
        card = null
    }

    @SuppressLint("InternalInsetResource", "DiscouragedApi")
    private fun statusBarHeight(): Int {
        val id = resources.getIdentifier("status_bar_height", "dimen", "android")
        return if (id > 0) resources.getDimensionPixelSize(id) else dp(24)
    }

    // ── Dictation ────────────────────────────────────────────────────────

    /** No dictation running; a failed one waiting for a retry gives way to a new one. */
    private val idle: Boolean get() = dictation.let { it == null || it.phase == Phase.FAILED }

    private fun start(pushToTalk: Boolean) {
        if (!idle) return
        if (prefs.apiKey.isEmpty()) return openApp(R.string.need_key)
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return openApp(R.string.need_mic)

        val target = runCatching { findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()?.takeIf { it.isEditable && !it.isPassword }
        val session = pool.take()
        val d = Dictation(target, session, pushToTalk)
        session.listener = object : RealtimeSession.Listener {
            override fun onDelta(text: String) {
                if (dictation !== d) return
                val now = SystemClock.elapsedRealtime()
                val gap = if (d.lastDeltaAt == 0L) 0 else now - d.lastDeltaAt
                if (gap >= LiveLayout.PARAGRAPH_PAUSE_MS && d.liveText.isNotBlank()) d.pauses.add(Pause(d.liveText.length, gap))
                d.lastDeltaAt = now
                d.liveText.append(text)
                card?.delta(text, gap)
                if (!d.pushToTalk && prefs.stopPhrase && d.phase == Phase.RECORDING && VoiceCommands.endsWithStopPhrase(d.liveText.toString())) {
                    d.stoppedByPhrase = true
                    stop()
                }
            }

            override fun onCompleted(text: String) {
                d.final = text
                if (d.phase == Phase.FINISHING) settle(d)
            }

            override fun onError(message: String) {
                d.offline = message
                if (dictation !== d) return
                if (d.phase == Phase.RECORDING) card?.notice(getString(R.string.offline))
                else if (d.phase == Phase.FINISHING) settle(d)
            }
        }
        session.configure(prefs)

        val recorder = Recorder(onChunk = { pcm, level ->
            runCatching { d.audio.write(pcm) } // a full disk only costs the fallback
            session.append(pcm)
            if (level > 0) d.heardAnything = true
            main.post {
                if (dictation === d && d.phase == Phase.RECORDING) {
                    bubble?.level = level
                    card?.level(level)
                }
            }
        }, onError = { message ->
            main.post {
                if (dictation === d && d.phase == Phase.RECORDING) {
                    stop()
                    card?.notice(getString(R.string.mic_stopped, message))
                }
            }
        })
        try {
            recorder.start()
        } catch (e: Exception) {
            session.close()
            closeAudio(d)
            Toast.makeText(this, getString(R.string.mic_error, e.message ?: ""), Toast.LENGTH_LONG).show()
            return
        }
        d.recorder = recorder
        // Only now that the new one is running does a failed dictation waiting for a retry give way.
        dictation?.let { closeAudio(it) }
        dictation = d
        showBubble()
        bubble?.state = BubbleView.State.RECORDING
        bubble?.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        showCard().begin(prefs.showCost, PRICE_PER_MINUTE_USD, prefs.formatText)
        if (session.failure != null) card?.notice(getString(R.string.offline))
        // Android hands a background app pure digital silence instead of an error when it may not record.
        main.postDelayed({ if (dictation === d && d.phase == Phase.RECORDING && !d.heardAnything) card?.notice(getString(R.string.mic_silent)) }, 2500)
    }

    private fun stop() {
        val d = dictation ?: return
        if (d.phase != Phase.RECORDING) return
        d.phase = Phase.FINISHING
        d.endedAt = SystemClock.elapsedRealtime()
        d.recorder?.stop()
        runCatching { d.audio.close() }
        d.session.commit()
        bubble?.state = BubbleView.State.FINISHING
        bubble?.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY)
        card?.setPhase(CardView.Phase.FINISHING)
        if (d.final != null || d.offline != null) settle(d)
        else main.postDelayed({ if (dictation === d && d.phase == Phase.FINISHING) settle(d, timedOut = true) }, COMPLETION_TIMEOUT_MS)
    }

    /** The live transcript arrived, or the live connection failed: deliver it or fall back to the file model. */
    private fun settle(d: Dictation, timedOut: Boolean = false) {
        if (dictation !== d || d.phase != Phase.FINISHING) return
        d.phase = Phase.DONE
        d.session.close()
        val live = d.final
        if (live != null && !timedOut) return deliver(d, live)
        transcribeFile(d)
    }

    private fun transcribeFile(d: Dictation) {
        Thread {
            // runCatching also catches an OutOfMemoryError from reading a very long recording.
            val result = runCatching { FileTranscriber.transcribe(this, prefs, d.audioFile.readBytes()) }
            main.post {
                if (dictation !== d) return@post
                result.fold(onSuccess = { deliver(d, it) }, onFailure = { fail(d, it.message ?: getString(R.string.error_openai)) })
            }
        }.start()
    }

    private fun deliver(d: Dictation, raw: String) {
        var text = raw.trim()
        if (d.stoppedByPhrase) text = VoiceCommands.stripStopPhrase(text)
        if (prefs.formatText && text.isNotEmpty()) {
            // Pauses are offsets in the live deltas; the final text has the same words, so shift them over.
            val live = d.liveText.toString()
            val lead = live.length - live.trimStart().length
            val shift = live.trim().lowercase().indexOf(text.lowercase())
            val pauses = if (shift < 0) emptyList() else d.pauses.map { it.copy(at = it.at - lead - shift) }.filter { it.at > 0 && it.at < text.length }
            text = LiveLayout.apply(text, LiveLayout.layout(text, pauses))
        }
        val c = card
        if (text.isEmpty()) {
            if (d.endedAt - d.startedAt < 1500) return finish(0)
            c?.final("")
            c?.setPhase(CardView.Phase.FAILED, getString(R.string.nothing_heard))
            return finish(1400)
        }
        c?.final(text)
        val inserted = d.target != null && runCatching { TextInserter.insert(this, d.target, text) }.getOrDefault(false)
        if (inserted) {
            c?.setPhase(CardView.Phase.DONE)
            finish(600)
        } else {
            TextInserter.copy(this, text)
            c?.setPhase(CardView.Phase.CLIPBOARD, getString(R.string.copied))
            finish(3500)
        }
    }

    /** The file model failed too: deliver what the live model managed (as the desktop does), if anything. */
    private fun fail(d: Dictation, message: String) {
        val live = d.liveText.toString()
        if (live.isNotBlank()) return deliver(d, live)
        // Nothing to deliver: keep the recording (offline, say) until the user retries or dismisses it.
        d.phase = Phase.FAILED
        bubble?.state = BubbleView.State.IDLE
        card?.setPhase(CardView.Phase.FAILED, getString(R.string.failed, message), retry = true)
        refreshBubble()
    }

    private fun retry() {
        val d = dictation?.takeIf { it.phase == Phase.FAILED } ?: return
        d.phase = Phase.DONE
        showBubble()
        bubble?.state = BubbleView.State.FINISHING
        card?.setPhase(CardView.Phase.FINISHING)
        transcribeFile(d)
    }

    /** Hides the card after [delayMs] and returns the bubble to idle. */
    private fun finish(delayMs: Long) {
        val d = dictation
        dictation = null
        d?.let { closeAudio(it) }
        bubble?.state = BubbleView.State.IDLE
        main.removeCallbacks(hideCardLater)
        main.postDelayed(hideCardLater, delayMs)
        d?.session?.close()
        refreshBubble()
    }

    private fun cancel() {
        val d = dictation ?: return
        d.recorder?.stop()
        d.session.close()
        closeAudio(d)
        dictation = null
        bubble?.state = BubbleView.State.IDLE
        hideCard()
        refreshBubble()
    }

    private fun closeAudio(d: Dictation) {
        runCatching { d.audio.close() }
        d.audioFile.delete()
    }

    private fun openApp(message: Int) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    private companion object {
        const val HOLD_MS = 400L
        /** How long the keyboard's top must hold still before the bubble is placed against it. */
        const val IME_SETTLE_MS = 250L
        const val APPEAR_MS = 160L
        const val APPEAR_SCALE = 0.6f
        const val PRESS_MS = 120L
        const val PRESS_SCALE = 0.9f
        const val DRAG_SCALE = 1.08f
        /** A throw carries the bubble this far ahead (in seconds of its speed) before it settles. */
        const val FLING_PROJECTION_S = 0.12f
        const val MAX_FLING_DP_S = 1500f
        const val COMPLETION_TIMEOUT_MS = 6000L
        const val DEFAULT_LIFT_DP = 72
        // gpt-live-transcribe list price (src/core/cost.ts).
        const val PRICE_PER_MINUTE_USD = 0.017
    }
}
