package dev.iliyasone.ciao

import android.content.Context
import android.os.Handler
import android.os.Looper
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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

    /** Gemini replays one at a time: two at 4× would be over the limit together. */
    private val geminiReplay = Any()

    /** Blocking; call off the main thread. Saves the new text into the entry and returns the entry. */
    fun run(context: Context, prefs: Prefs, history: History, id: String, mode: Mode, provider: Provider): History.Entry {
        val key = prefs.keyOf(provider)
        if (key.isEmpty()) throw IOException(context.getString(R.string.need_key, provider.displayName))
        val pcm = history.audioFile(id).readBytes()
        val text = when (mode) {
            Mode.FILE -> FileTranscriber.transcribe(context, prefs, pcm, provider, key, prefs.smart)
            Mode.LIVE -> if (provider == Provider.GEMINI) synchronized(geminiReplay) { live(context, prefs, pcm, provider, key) } else live(context, prefs, pcm, provider, key)
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

    /** Re-runs the streaming model over a saved recording, faster than real time. */
    private fun live(context: Context, prefs: Prefs, pcm: ByteArray, provider: Provider, key: String): String {
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
        val timeoutMs = 60_000 + pcm.size / BYTES_PER_MS / 2
        try {
            main.post { session.configure(prefs) }
            if (provider == Provider.GEMINI) {
                // 250 ms per message, fine enough for the session to find pauses to cut a long one at.
                val chunk = 250 * BYTES_PER_MS
                var i = 0
                while (i < pcm.size && done.count > 0) {
                    val part = pcm.copyOfRange(i, minOf(i + chunk, pcm.size))
                    main.post { session.append(part) }
                    i += chunk
                    Thread.sleep(250L / GEMINI_LIVE_SPEEDUP)
                }
            } else {
                val chunk = Recorder.SAMPLE_RATE * 2 // 1 s per message
                var i = 0
                while (i < pcm.size) {
                    val part = pcm.copyOfRange(i, minOf(i + chunk, pcm.size))
                    main.post { session.append(part) }
                    i += chunk
                }
            }
            main.post { session.commit() }
            if (!done.await(timeoutMs.toLong(), TimeUnit.MILLISECONDS)) throw IOException(context.getString(R.string.error_timeout, provider.displayName))
        } finally {
            main.post { session.close() }
        }
        error?.let { throw IOException(it) }
        return result ?: ""
    }
}
