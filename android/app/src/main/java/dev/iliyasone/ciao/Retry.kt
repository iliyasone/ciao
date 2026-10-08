package dev.iliyasone.ciao

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.File
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Transcribing a saved recording again, as History's buttons do on the desktop (retry in
 * src/main/main.ts): "More accurate" through the file model, "Live" through the streaming model.
 */
object Retry {
    enum class Mode { FILE, LIVE }

    /**
     * Gemini takes a saved recording at most this many times faster than real time: sent all at once,
     * its live model hits the audio-per-minute limit (see src/main/transcribe.ts).
     */
    private const val GEMINI_LIVE_SPEEDUP = 4
    private const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000
    /** Pieces handed to the main thread and not yet sent, and bytes the socket has yet to send, before the replay waits. */
    private const val MAX_PENDING = 8
    private const val MAX_QUEUED_BYTES = 4L * 1024 * 1024

    /** Gemini replays one at a time: two at 4× would be over the limit together. */
    private val geminiReplay = Any()

    /** Blocking; call off the main thread. Saves the new text into the entry and returns the entry. */
    fun run(context: Context, prefs: Prefs, history: History, id: String, mode: Mode, provider: Provider): History.Entry {
        val key = prefs.keyOf(provider)
        if (key.isEmpty()) throw IOException(context.getString(R.string.need_key, provider.displayName))
        val audio = history.audioFile(id)
        val text = when (mode) {
            Mode.FILE -> FileTranscriber.transcribe(context, prefs, audio, provider, key, prefs.smart)
            Mode.LIVE -> if (provider == Provider.GEMINI) synchronized(geminiReplay) { live(context, prefs, audio, provider, key) } else live(context, prefs, audio, provider, key)
        }.trim()
        // Re-read: the entry may have changed while we waited.
        val fresh = history.get(id) ?: throw IOException(context.getString(R.string.history_gone))
        val source = if (mode == Mode.FILE) History.Source.RETRY_FILE else History.Source.RETRY_LIVE
        val model = if (mode == Mode.FILE) provider.fileModel else provider.liveModel
        val e = if (text.isEmpty()) fresh.copy(error = context.getString(R.string.nothing_heard))
        else fresh.plus(History.Transcript(source, model, text, System.currentTimeMillis()))
        history.save(e)
        return e
    }

    /**
     * Re-runs the streaming model over a saved recording, faster than real time. It is read from the
     * file a piece at a time, and sent no faster than the socket takes it: OkHttp closes a socket
     * with over 16 MB waiting, about 3 minutes of audio.
     */
    private fun live(context: Context, prefs: Prefs, audio: File, provider: Provider, key: String): String {
        val done = CountDownLatch(1)
        var result: String? = null
        var error: String? = null
        val main = Handler(Looper.getMainLooper())
        val session: LiveSession = if (provider == Provider.GEMINI) GeminiSession(context, key) else RealtimeSession(context, key)
        session.listener = object : LiveSession.Listener {
            override fun onDelta(text: String) {}
            override fun onRevise(text: String) {}
            override fun onCompleted(text: String) {
                if (done.count == 0L) return
                result = text
                done.countDown()
            }

            override fun onError(message: String) {
                if (done.count == 0L) return
                error = message
                done.countDown()
            }
        }
        val timeoutMs = 60_000 + audio.length() / BYTES_PER_MS / 2
        try {
            main.post { session.configure(prefs) }
            // Gemini: 250 ms per message, fine enough for the session to find pauses to cut a long one at.
            val chunk = if (provider == Provider.GEMINI) 250 * BYTES_PER_MS else Recorder.SAMPLE_RATE * 2 // 1 s per message
            val pending = AtomicInteger()
            audio.inputStream().use { input ->
                val buf = ByteArray(chunk)
                while (done.count > 0) {
                    var n = 0
                    while (n < chunk) n += input.read(buf, n, chunk - n).takeIf { it > 0 } ?: break
                    if (n == 0) break
                    val part = buf.copyOf(n)
                    while (done.count > 0 && (pending.get() > MAX_PENDING || session.queued > MAX_QUEUED_BYTES)) Thread.sleep(20)
                    pending.incrementAndGet()
                    main.post {
                        session.append(part)
                        pending.decrementAndGet()
                    }
                    if (provider == Provider.GEMINI) Thread.sleep(250L / GEMINI_LIVE_SPEEDUP)
                }
            }
            main.post { session.commit() }
            if (!done.await(timeoutMs, TimeUnit.MILLISECONDS)) throw IOException(context.getString(R.string.error_timeout, provider.displayName))
        } finally {
            main.post { session.close() }
        }
        error?.let { throw IOException(it) }
        return result ?: ""
    }
}
