package dev.iliyasone.ciao

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicLong

/**
 * Telegram's on-device recognizer, tinyasr (GPL-3.0-or-later): no key, no network, free. The recognizing is
 * native/asr's Rust (src/android.rs over src/lib.rs), the same the desktop's helper runs; this is a port of
 * src/core/local.ts around it. The models are assets kept uncompressed in the APK, read from it once.
 */
object LocalAsr {
    const val NAME = "tinyasr"
    /** As LOCAL_LANGS in src/core/local.ts: each language allowed costs a full pass at every pause. */
    const val LANGS = "ru,en"

    private var models = 0L

    /** Loaded on the first session and kept (~40 MB): a few seconds the first time. Blocking. */
    @Synchronized
    fun models(context: Context): Long {
        if (models == 0L) {
            System.loadLibrary("ciao_asr")
            val assets = context.applicationContext.assets
            assets.openFd("tinyasr/en-ru-uk.tzf").use { asr ->
                assets.openFd("tinyasr/silero_vad.onnx").use { vad ->
                    models = load(asr.parcelFileDescriptor.fd, asr.startOffset, asr.length, vad.parcelFileDescriptor.fd, vad.startOffset, vad.length)
                }
            }
        }
        return models
    }

    /** The library is there for this phone's processor (KeyCheck). */
    fun available(): Boolean = runCatching { System.loadLibrary("ciao_asr") }.isSuccess

    /** A saved recording from byte [from] on: the full-context pass, more accurate than the live text. Blocking. */
    fun transcribe(context: Context, audio: File, from: Long): String = transcribe(models(context), audio.path, from, LANGS)

    // native/asr/src/android.rs. A live session's calls must all come from one thread.
    @JvmStatic private external fun load(asrFd: Int, asrOffset: Long, asrLength: Long, vadFd: Int, vadOffset: Long, vadLength: Long): Long
    @JvmStatic external fun liveStart(models: Long, langs: String): Long
    /** The text shown so far if it changed (it may rewrite words already shown), else null. */
    @JvmStatic external fun livePush(live: Long, pcm: ByteArray, length: Int): String?
    /** The final text; frees the session. */
    @JvmStatic external fun liveFinish(live: Long): String
    @JvmStatic external fun liveFree(live: Long)
    @JvmStatic private external fun transcribe(models: Long, path: String, from: Long, langs: String): String
}

/**
 * A live dictation recognized on the phone, as LocalSession in src/core/local.ts: every call into it runs, in order,
 * on the session's own thread, so the microphone and the main thread never wait for it. Made ahead by the pool, it
 * loads the models meanwhile. It re-decodes the open sentence at pauses, so the text shown may change, not only grow.
 * All the audio goes in: nothing is billed, and the recognizer finds the pauses itself.
 */
class LocalSession(private val context: Context) : LiveSession {
    override val createdAt = SystemClock.elapsedRealtime()

    @Volatile override var failure: String? = null
        private set

    override var listener: LiveSession.Listener? = null

    @Volatile private var closedByUs = false
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "tinyasr") }
    private val pending = AtomicLong()
    // The worker's only.
    private var models = 0L
    private var live = 0L

    init {
        run { models = LocalAsr.models(context) }
    }

    override val usable: Boolean get() = failure == null && !closedByUs

    override val queued: Long get() = pending.get()

    override val skippedBytes: Long get() = 0

    override fun configure(prefs: Prefs) = run { if (models != 0L) live = LocalAsr.liveStart(models, LocalAsr.LANGS) }

    override fun append(pcm: ByteArray, length: Int) {
        if (length <= 0) return
        val part = pcm.copyOf(length)
        pending.addAndGet(part.size.toLong())
        run {
            pending.addAndGet(-part.size.toLong())
            if (live != 0L && !closedByUs) LocalAsr.livePush(live, part, part.size)?.let { text -> main.post { listener?.onRevise(text) } }
        }
    }

    override fun commit() = run {
        if (live == 0L || closedByUs) return@run
        val text = LocalAsr.liveFinish(live)
        live = 0
        main.post { listener?.onCompleted(text) }
    }

    override fun close() {
        closedByUs = true
        run {
            if (live != 0L) LocalAsr.liveFree(live)
            live = 0
        }
        worker.shutdown()
    }

    private fun run(task: () -> Unit) {
        try {
            worker.execute {
                try {
                    task()
                } catch (e: Throwable) {
                    fail(e.message ?: context.getString(R.string.error_provider, LocalAsr.NAME))
                }
            }
        } catch (e: RejectedExecutionException) {
            // Closed.
        }
    }

    private fun fail(message: String) {
        if (failure != null || closedByUs) return
        failure = message
        main.post { listener?.onError(message) }
    }
}
