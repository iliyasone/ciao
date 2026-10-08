package dev.iliyasone.ciao

import android.Manifest
import android.accessibilityservice.AccessibilityService
import android.annotation.SuppressLint
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.PixelFormat
import android.graphics.Rect
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Gravity
import android.view.View
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
import java.util.concurrent.Executors
import kotlin.math.hypot
import kotlin.math.roundToInt

/**
 * Shows the Ciao bubble whenever a keyboard is up over a text field. Tap it to dictate (tap again,
 * or say "чао-чао", to finish), or hold it to talk and let go. While you speak, the card at the top
 * of the screen shows the words live; when you finish, the text goes into the field you started in.
 */
class CiaoService : AccessibilityService() {
    private lateinit var prefs: Prefs
    private lateinit var history: History
    /** History writes, in order and off the main thread (trimming reads every entry). */
    private val disk = Executors.newSingleThreadExecutor()
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
    private val imeSettled get() = imeTopSeen == -1 || SystemClock.uptimeMillis() >= imeTopSince + IME_SETTLE_MS
    private val motion = Spring(onFrame = { x, y -> moveBubble(x.roundToInt(), y.roundToInt().coerceAtMost(glideFloor)) }, onEnd = { if (bubble?.alpha == 1f && imeSettled) setBubbleTouchable(true) })
    /** The lowest the current glide may go: never below its start or its spot, so it doesn't bounce over the keys. */
    private var glideFloor = Int.MAX_VALUE
    private var dictation: Dictation? = null
    /** The shade is down: the bubble and the card step aside until it's back up. */
    private var shade = false

    /** FAILED: not transcribed; the recording is kept on the card until you retry or dismiss it. */
    private enum class Phase { RECORDING, FINISHING, DONE, FAILED }

    private inner class Dictation(val target: AccessibilityNodeInfo?, val session: LiveSession, val pushToTalk: Boolean) {
        /** As when it started: the settings may change before it is delivered. */
        val provider = prefs.provider
        val smart = prefs.smart
        val startedAt = SystemClock.elapsedRealtime()
        var endedAt = 0L
        val entry = history.create(provider)
        /** The recording, written into the history as it comes in so a long one doesn't sit in memory. */
        val audioFile = history.audioFile(entry.id)
        val audio = BufferedOutputStream(FileOutputStream(audioFile))
        var recorder: Recorder? = null
        var phase = Phase.RECORDING
        val liveText = StringBuilder()
        val pauses = mutableListOf<Pause>()
        var lastDeltaAt = 0L
        var final: String? = null
        var offline: String? = null
        var stoppedByPhrase = false
        /** For the usage counts (Telemetry): when the first words showed, what ended it, whether it was counted. */
        var firstTextAt = 0L
        var endedBy = "cancel"
        var reported = false

        @Volatile var heardAnything = false
    }

    private val refresh = Runnable { refreshBubble() }
    private val hideCardLater = Runnable { if (dictation == null) hideCard() }
    private val closePool = Runnable { pool.close() }

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Ui.wrap(base))

    override fun onServiceConnected() {
        prefs = Prefs(this)
        GoogleSync.load(this)
        pool = SessionPool(this, prefs)
        wm = getSystemService(WindowManager::class.java)
        history = History(File(filesDir, "history"))
        instance = this
        Telemetry.capture(this, "app_started", mapOf(
            "has_api_key" to prefs.currentKey.isNotEmpty(),
            "provider" to prefs.provider.id,
            "wake_word_enabled" to false,
            "format_text_enabled" to prefs.formatText,
        ))
        RecordingService.channel(this)
        // Recordings cut off by a crash or Android killing Ciao (out of memory, say): transcribe what was recorded.
        disk.execute { runCatching { history.recover() }.getOrNull()?.takeIf { it.isNotEmpty() }?.let { Thread { Recovery.run(this, prefs, history, it) }.start() } }
        // Where recordings went before the history (Ciao 0.8.2 and older).
        cacheDir.listFiles { f -> f.name.startsWith("dictation-") }?.forEach { it.delete() }
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent) {
        main.removeCallbacks(refresh)
        main.postDelayed(refresh, 80)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (instance === this) instance = null
        dictation?.let { cancel() }
        RecordingService.hide(this)
        hideBubble()
        main.removeCallbacksAndMessages(null)
        if (::pool.isInitialized) pool.close()
        disk.shutdown() // after the writes already queued
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
        // Over the shade they'd cover its notifications, ours with Done and Cancel among them.
        val open = shadeOpen()
        if (open != shade) {
            shade = open
            if (open) setBubbleTouchable(false) else if (bubble?.alpha == 1f && !motion.running) setBubbleTouchable(true)
        }
        bubble?.visibility = if (shade) View.INVISIBLE else View.VISIBLE
        cardHost?.visibility = if (shade) View.GONE else View.VISIBLE
    }

    /** The notification shade or quick settings are pulled down (the lock screen doesn't count: the card belongs there). */
    private fun shadeOpen(): Boolean {
        if (getSystemService(KeyguardManager::class.java).isKeyguardLocked) return false
        val height = resources.displayMetrics.heightPixels
        val r = Rect()
        return runCatching {
            windows.any { w -> w.type == AccessibilityWindowInfo.TYPE_SYSTEM && r.also { w.getBoundsInScreen(it) }.height() > height / 2 }
        }.getOrDefault(false)
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
        // Terms edited on another device, in time for the dictation about to start.
        GoogleSync.syncIfStale(this)
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
            v.setOnTouchListener(BubbleTouch().also { bubbleTouch = it })
            v.contentDescription = getString(R.string.bubble_description)
            v.alpha = 0f
            v.scaleX = APPEAR_SCALE
            v.scaleY = APPEAR_SCALE
            wm.addView(v, bubbleParams)
            bubble = v
            v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(APPEAR_MS).setInterpolator(DecelerateInterpolator())
                .withEndAction { if (bubble === v && !motion.running && imeSettled) setBubbleTouchable(true) }
            return
        }
        if (touching) return
        // Moving our own window raises another windows-changed event; don't loop on it, and leave a
        // glide that is already headed there (a throw, which stays catchable) alone.
        if (motion.running && motion.toX == x.toFloat() && motion.toY == y.toFloat()) return
        if (motion.running || x != bubbleParams.x || y != bubbleParams.y) {
            // The keyboard changed under it: glide over, letting taps through to the keyboard meanwhile.
            setBubbleTouchable(false)
            glide(x, y)
        } else if (!motion.running && view.alpha == 1f && imeSettled) {
            setBubbleTouchable(true)
        }
    }

    private fun glide(x: Int, y: Int, vx: Float = 0f, vy: Float = 0f) {
        glideFloor = maxOf(bubbleParams.y, y)
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
        val flags = if (touchable && !shade) bubbleParams.flags and flag.inv() else bubbleParams.flags or flag
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
        bubbleTouch?.abandon()
        bubbleTouch = null
        // Keep the warm connection a little, in case the keyboard comes right back.
        main.removeCallbacks(closePool)
        if (::pool.isInitialized) main.postDelayed(closePool, 120_000)
    }

    /** A finger is on the bubble: nothing else moves it meanwhile. */
    private var touching = false
    private var bubbleTouch: BubbleTouch? = null

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
                        e.actionMasked == MotionEvent.ACTION_CANCEL -> if (held) stop("release")
                        held -> stop("release")
                        idle -> start(pushToTalk = false)
                        dictation?.phase == Phase.RECORDING -> stop("press")
                    }
                    held = false
                    // Placing it was held back while the finger was down (a keyboard change, a catch).
                    main.post(refresh)
                    tracker?.recycle()
                }
            }
            return true
        }

        /** The bubble went away mid-touch: no release will come. */
        fun abandon() {
            main.removeCallbacks(hold)
            velocity?.recycle()
            velocity = null
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
        val c = CardView(this, onCancel = { cancel() }, onDone = { stop("press") }, onRetry = { retry() })
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
        if (prefs.currentKey.isEmpty()) return openApp(getString(R.string.need_key, prefs.provider.displayName))
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) return openApp(getString(R.string.need_mic))

        val target = runCatching { findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()?.takeIf { it.isEditable && !it.isPassword }
        val session = pool.take()
        val d = Dictation(target, session, pushToTalk)
        session.listener = object : LiveSession.Listener {
            override fun onDelta(text: String) {
                if (dictation !== d) return
                val now = SystemClock.elapsedRealtime()
                val gap = if (d.lastDeltaAt == 0L) 0 else now - d.lastDeltaAt
                if (gap >= LiveLayout.PARAGRAPH_PAUSE_MS && d.liveText.isNotBlank()) d.pauses.add(Pause(d.liveText.length, gap))
                d.lastDeltaAt = now
                if (d.firstTextAt == 0L) d.firstTextAt = now
                d.liveText.append(text)
                card?.delta(text, gap)
                checkStopPhrase(d)
            }

            override fun onRevise(text: String) {
                if (dictation !== d) return
                val now = SystemClock.elapsedRealtime()
                val gap = if (d.lastDeltaAt == 0L) 0 else now - d.lastDeltaAt
                val pauses = Revision.revisePauses(d.liveText.toString(), text, d.pauses, gap).second
                d.pauses.clear()
                d.pauses.addAll(pauses)
                d.lastDeltaAt = now
                d.liveText.setLength(0)
                d.liveText.append(text)
                card?.revise(text, gap)
                checkStopPhrase(d)
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
                    stop("mic_error")
                    card?.notice(getString(R.string.mic_stopped, message))
                }
            }
        })
        // Before the microphone opens: with it, the recording goes on with the screen off or locked.
        RecordingService.show(this, System.currentTimeMillis())
        try {
            recorder.start()
        } catch (e: Exception) {
            RecordingService.hide(this)
            session.close()
            closeAudio(d)
            forget(d)
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
        showCard().begin(prefs.showCost, d.provider.pricePerMinute, prefs.formatText)
        if (session.failure != null) card?.notice(getString(R.string.offline))
        // Android hands a background app pure digital silence instead of an error when it may not record.
        main.postDelayed({ if (dictation === d && d.phase == Phase.RECORDING && !d.heardAnything) card?.notice(getString(R.string.mic_silent)) }, 2500)
    }

    private fun checkStopPhrase(d: Dictation) {
        if (!d.pushToTalk && prefs.stopPhrase && d.phase == Phase.RECORDING && VoiceCommands.endsWithStopPhrase(d.liveText.toString())) {
            d.stoppedByPhrase = true
            stop("stop_phrase")
        }
    }

    private fun stop(by: String) {
        val d = dictation ?: return
        if (d.phase != Phase.RECORDING) return
        d.phase = Phase.FINISHING
        d.endedAt = SystemClock.elapsedRealtime()
        d.endedBy = by
        d.recorder?.stop()
        runCatching { d.audio.close() }
        d.session.commit()
        RecordingService.show(this, 0, finishing = true)
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
            val result = runCatching { FileTranscriber.transcribe(this, prefs, d.audioFile.readBytes(), d.provider, prefs.keyOf(d.provider), d.smart) }
            main.post {
                if (dictation !== d) return@post
                result.fold(onSuccess = { deliver(d, it, History.Source.RETRY_FILE) }, onFailure = { fail(d, it.message ?: getString(R.string.error_provider, d.provider.displayName)) })
            }
        }.start()
    }

    /** [source]: the live model, or the file model it fell back to. */
    private fun deliver(d: Dictation, raw: String, source: History.Source = History.Source.LIVE) {
        var text = raw.trim()
        if (d.stoppedByPhrase) text = VoiceCommands.stripStopPhrase(text)
        val heard = text
        // Gemini's smart mode often lays out paragraphs itself; leave its layout alone when it did.
        val laidOutByModel = d.provider == Provider.GEMINI && d.smart && text.contains('\n')
        if (prefs.formatText && text.isNotEmpty() && !laidOutByModel) {
            // Pauses are offsets in the live deltas; the final text has the same words, so shift them over.
            val live = d.liveText.toString()
            val lead = live.length - live.trimStart().length
            val shift = live.trim().lowercase().indexOf(text.lowercase())
            val pauses = if (shift < 0) emptyList() else d.pauses.map { it.copy(at = it.at - lead - shift) }.filter { it.at > 0 && it.at < text.length }
            text = LiveLayout.apply(text, LiveLayout.layout(text, pauses))
        }
        val c = card
        if (text.isEmpty()) {
            if (d.endedAt - d.startedAt < 1500) {
                forget(d)
                return finish(0)
            }
            record(d, History.Status.FAILED, error = getString(R.string.nothing_heard))
            c?.final("")
            c?.setPhase(CardView.Phase.FAILED, getString(R.string.nothing_heard))
            return finish(1400)
        }
        c?.final(text)
        prefs.lastText = text
        val inserted = prefs.autoPaste && d.target != null && runCatching { TextInserter.insert(this, d.target, text, prefs.restoreClipboard) }.getOrDefault(false)
        // As on the desktop: what the model heard, then the laid-out text if the layout changed it.
        val now = System.currentTimeMillis()
        val model = if (source == History.Source.LIVE) d.provider.liveModel else d.provider.fileModel
        val transcripts = listOf(History.Transcript(source, model, heard, now)) +
            (if (text != heard) listOf(History.Transcript(History.Source.FORMATTED, model, text, now)) else emptyList())
        record(d, History.Status.DONE, transcripts, if (inserted) History.Delivery.PASTED else History.Delivery.CLIPBOARD)
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
        record(d, History.Status.FAILED, error = message)
        RecordingService.hide(this)
        bubble?.state = BubbleView.State.IDLE
        card?.setPhase(CardView.Phase.FAILED, getString(R.string.failed, message), retry = true)
        refreshBubble()
    }

    private fun retry() {
        val d = dictation?.takeIf { it.phase == Phase.FAILED } ?: return
        d.phase = Phase.DONE
        RecordingService.show(this, 0, finishing = true)
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
        RecordingService.hide(this)
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
        // A failed one is in the history already; a cancelled one stays there too, unless it was a slip.
        if (d.phase != Phase.FAILED) {
            if (d.endedAt == 0L) d.endedAt = SystemClock.elapsedRealtime()
            if (d.endedAt - d.startedAt < 1500) forget(d) else record(d, History.Status.CANCELLED)
        }
        dictation = null
        RecordingService.hide(this)
        bubble?.state = BubbleView.State.IDLE
        hideCard()
        refreshBubble()
    }

    private fun closeAudio(d: Dictation) {
        runCatching { d.audio.close() }
    }

    private fun record(
        d: Dictation,
        status: History.Status,
        transcripts: List<History.Transcript> = emptyList(),
        delivery: History.Delivery = History.Delivery.NONE,
        error: String? = null,
    ) {
        val end = if (d.endedAt != 0L) d.endedAt else SystemClock.elapsedRealtime()
        report(d, status, transcripts, delivery, end)
        val e = d.entry.copy(status = status, transcripts = transcripts, delivery = delivery, error = error, durationMs = end - d.startedAt)
        disk.execute {
            runCatching {
                history.save(e)
                history.trim()
            }
        }
    }

    /** The desktop's "dictation" event (README → Telemetry), once per dictation kept in the history. */
    private fun report(d: Dictation, status: History.Status, transcripts: List<History.Transcript>, delivery: History.Delivery, end: Long) {
        if (d.reported) return
        d.reported = true
        val outcome = when {
            status == History.Status.CANCELLED -> "cancelled"
            status == History.Status.FAILED && d.liveText.isBlank() && d.final == null -> "failed"
            transcripts.isEmpty() -> "empty"
            delivery == History.Delivery.PASTED -> "pasted"
            else -> "clipboard"
        }
        val by = transcripts.firstOrNull()?.source
        val seconds = (end - d.startedAt) / 1000.0
        Telemetry.capture(this, "dictation", mapOf(
            "outcome" to outcome,
            "transcribed_by" to when (by) { null -> "none"; History.Source.RETRY_FILE -> "file"; else -> "live" },
            "trigger" to "bubble",
            "ended_by" to d.endedBy,
            "hands_free" to !d.pushToTalk,
            "provider" to d.provider.id,
            "smart" to if (d.provider == Provider.GEMINI) d.smart else null,
            "duration_s" to Math.round(seconds * 10) / 10.0,
            "first_text_ms" to if (d.firstTextAt != 0L) d.firstTextAt - d.startedAt else null,
            "final_after_release_ms" to if (d.endedAt != 0L && transcripts.isNotEmpty()) SystemClock.elapsedRealtime() - d.endedAt else null,
            "cost_usd" to Math.round(seconds / 60 * d.provider.pricePerMinute * 10000) / 10000.0,
        ))
    }

    private fun forget(d: Dictation) {
        disk.execute { history.delete(d.entry.id) }
    }

    /** From the quick-settings tile: close the shade, then paste into the field that has the focus again. */
    fun pasteLast(text: String) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) performGlobalAction(GLOBAL_ACTION_DISMISS_NOTIFICATION_SHADE)
        main.postDelayed({
            val field = runCatching { findFocus(AccessibilityNodeInfo.FOCUS_INPUT) }.getOrNull()?.takeIf { it.isEditable && !it.isPassword }
            val inserted = field != null && runCatching { TextInserter.insert(this, field, text, prefs.restoreClipboard) }.getOrDefault(false)
            if (!inserted) {
                TextInserter.copy(this, text)
                Toast.makeText(this, R.string.copied, Toast.LENGTH_SHORT).show()
            }
        }, SHADE_CLOSE_MS)
    }

    /** Done and Cancel in the notification: the same as on the card. */
    fun stopFromNotification() = main.post { stop("notification") }

    fun cancelFromNotification() = main.post { cancel() }

    private fun openApp(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
        startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    companion object {
        /** The running service, for the notification's buttons (RecordingService). */
        var instance: CiaoService? = null
            private set
        private const val HOLD_MS = 400L
        /** The shade's closing animation, before the app's field has the focus again. */
        private const val SHADE_CLOSE_MS = 450L
        /** How long the keyboard's top must hold still before the bubble is placed against it. */
        private const val IME_SETTLE_MS = 250L
        private const val APPEAR_MS = 160L
        private const val APPEAR_SCALE = 0.6f
        private const val PRESS_MS = 120L
        private const val PRESS_SCALE = 0.9f
        private const val DRAG_SCALE = 1.08f
        /** A throw carries the bubble this far ahead (in seconds of its speed) before it settles. */
        private const val FLING_PROJECTION_S = 0.12f
        private const val MAX_FLING_DP_S = 1500f
        private const val COMPLETION_TIMEOUT_MS = 6000L
        private const val DEFAULT_LIFT_DP = 72
    }
}
