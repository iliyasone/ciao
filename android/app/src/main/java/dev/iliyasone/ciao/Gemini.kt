package dev.iliyasone.ciao

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONArray
import org.json.JSONObject

// Gemini Live transcription (gemini-3.5-transcribe-live), a port of src/core/gemini.ts.

/** Terms for custom_vocabulary: the same cleanup as OpenAI's keywords, at most the API's 1,000. */
fun geminiVocabulary(keywords: List<String>): List<String> =
    keywords.map { it.trim() }.filter { k -> k.isNotEmpty() && k.none { it in "<>\r\n" } }.take(1000)

/**
 * One Gemini Live transcription session.
 *
 * The turn is ours, not the server's: automatic voice detection is off, so a pause to think doesn't
 * end the dictation; configure() starts the turn and commit() ends it. While you speak the server
 * sends interim guesses, each replacing the last, and a final transcript per finished segment; in
 * smart mode the finals drop fillers and false starts and apply spoken corrections ("в два, нет, в
 * три" → "в три"), so a final may differ from the guesses before it.
 *
 * The server ends an activity on its own about 220 s after it started and ignores the audio after
 * that, so a long dictation is cut into several, each with its own final: [ROLL_AFTER_MS] into one,
 * it ends at the next pause, or at [ROLL_BY_MS] without one. The next may start only once the server
 * reports the end (ACTIVITY_END), so the audio in between is held and sent after it. Should the
 * server end one first, the next starts right away. Mirrors src/core/gemini.ts.
 *
 * Never send language codes along with smart mode: on Gemini's transcription endpoints that silently
 * turns smart mode off. Without them the language is detected per utterance.
 *
 * Everything the socket reports is handled on the main thread, so the state needs no locks, except
 * what [append] shares from the recorder's thread: that is under [lock].
 */
class GeminiSession(private val context: Context, apiKey: String) : LiveSession {
    override val createdAt = SystemClock.elapsedRealtime()

    @Volatile override var failure: String? = null
        private set

    override var listener: LiveSession.Listener? = null

    @Volatile private var closedByUs = false
    private val main = Handler(Looper.getMainLooper())
    private val finals = mutableListOf<String>()
    private var interim = ""
    /** What onDelta/onRevise have shown so far. */
    private var shown = ""
    private var committed = false
    private var completed = false
    private val lock = Any()
    private var activityAt = 0L
    /** Finals from the activities before the current one (main thread, like [finals]). */
    private var earlierFinals = 0
    /** Quiet at the end of the audio so far. */
    private var quietMs = 0.0
    /** We ended an activity early and wait for the server to confirm; audio meanwhile is held. */
    private var rolling = false
    private val held = mutableListOf<ByteArray>()
    /** Whether any of the held audio is more than quiet. */
    private var heldVoice = false
    private val settle = Runnable { complete() }
    private var settling = false

    // The key goes in a header, not ?key=: query strings end up in logs.
    private val socket: WebSocket = http.newWebSocket(
        Request.Builder().url(URL).header("x-goog-api-key", apiKey).build(),
        object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post { handle(text) }
            }

            // Gemini sends its JSON as binary frames.
            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val text = bytes.utf8()
                main.post { handle(text) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val message = socketError(context, NAME, response)
                main.post { fail(message) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                main.post { if (!completed) fail(context.getString(R.string.error_closed, reason)) }
            }
        },
    )

    override val usable: Boolean get() = failure == null && !closedByUs

    override fun configure(prefs: Prefs) {
        val transcription = JSONObject().put("mode", if (prefs.smart) "SMART" else "VERBATIM")
        val terms = geminiVocabulary(prefs.keywords)
        if (terms.isNotEmpty()) transcription.put("customVocabulary", JSONArray(terms))
        val setup = JSONObject()
            .put("model", "models/${Provider.GEMINI.liveModel}")
            .put("generationConfig", JSONObject().put("responseModalities", JSONArray().put("TEXT")))
            .put("inputAudioTranscription", transcription)
            .put("realtimeInputConfig", JSONObject().put("automaticActivityDetection", JSONObject().put("disabled", true)))
        send(JSONObject().put("setup", setup))
        synchronized(lock) { startActivity() }
    }

    override fun append(pcm: ByteArray, length: Int) {
        synchronized(lock) { appendLocked(pcm, length) }
    }

    private fun appendLocked(pcm: ByteArray, length: Int) {
        val ms = length / 2 * 1000.0 / Recorder.SAMPLE_RATE
        val quiet = Recorder.level(pcm, 0, length) < QUIET_LEVEL
        quietMs = if (quiet) quietMs + ms else 0.0
        if (rolling) {
            if (!quiet) heldVoice = true
            held.add(pcm.copyOf(length))
            return
        }
        val age = SystemClock.elapsedRealtime() - activityAt
        if ((age >= ROLL_AFTER_MS && quietMs >= PAUSE_MS) || age >= ROLL_BY_MS) {
            rolling = true
            held.add(pcm.copyOf(length))
            heldVoice = !quiet
            send(JSONObject().put("realtimeInput", JSONObject().put("activityEnd", JSONObject())))
            return
        }
        sendAudio(pcm, length)
    }

    /** Under [lock]. */
    private fun startActivity() {
        activityAt = SystemClock.elapsedRealtime()
        earlierFinals = finals.size
        send(JSONObject().put("realtimeInput", JSONObject().put("activityStart", JSONObject())))
    }

    private fun sendAudio(pcm: ByteArray, length: Int) {
        val audio = JSONObject().put("data", Base64.encodeToString(pcm, 0, length, Base64.NO_WRAP)).put("mimeType", AUDIO_MIME)
        send(JSONObject().put("realtimeInput", JSONObject().put("audio", audio)))
    }

    /**
     * On the main thread, like everything that reads [committed]. While rolling over, the turn ends
     * once the held audio is sent (see handle).
     */
    override fun commit() {
        committed = true
        synchronized(lock) { if (!rolling) send(JSONObject().put("realtimeInput", JSONObject().put("activityEnd", JSONObject()))) }
    }

    override fun close() {
        closedByUs = true
        main.removeCallbacks(settle)
        socket.close(1000, null)
    }

    /** OkHttp queues anything sent before the socket opens. */
    private fun send(msg: JSONObject) {
        socket.send(msg.toString())
    }

    private fun fail(message: String) {
        if (failure != null || closedByUs) return
        failure = message
        listener?.onError(message)
    }

    /** Finals so far plus the current guess, as one text; shown as a delta when it only grew. */
    private fun show() {
        val text = (finals + interim).map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" ")
        if (text == shown) return
        if (text.startsWith(shown)) listener?.onDelta(text.substring(shown.length)) else listener?.onRevise(text)
        shown = text
    }

    private fun complete() {
        if (completed || closedByUs) return
        completed = true
        main.removeCallbacks(settle)
        listener?.onCompleted(finals.map { it.trim() }.filter { it.isNotEmpty() }.joinToString(" "))
    }

    private fun settleIn(ms: Long) {
        settling = true
        main.removeCallbacks(settle)
        main.postDelayed(settle, ms)
    }

    private fun isRolling() = synchronized(lock) { rolling }

    private fun handle(raw: String) {
        if (closedByUs) return
        val msg = try {
            JSONObject(raw)
        } catch (e: Exception) {
            return
        }
        msg.optJSONObject("error")?.let { e ->
            return fail(e.optString("message").takeIf { it.isNotEmpty() } ?: context.getString(R.string.error_provider, NAME))
        }
        if (msg.has("goAway") && !committed) return fail(context.getString(R.string.error_closed, "goAway"))
        // Each activity ends with this, after its final.
        if (msg.optJSONObject("voiceActivity")?.optString("type") == "ACTIVITY_END") {
            var done = false
            val settleNow = synchronized(lock) {
                if (rolling) {
                    rolling = false
                    if (committed && !heldVoice) {
                        // Released in the pause the cut was made at: the final for what was said is
                        // in, and the quiet tail isn't worth another round trip.
                        held.clear()
                        done = true
                        return@synchronized false
                    }
                    startActivity()
                    for (pcm in held) sendAudio(pcm, pcm.size)
                    held.clear()
                    if (committed) send(JSONObject().put("realtimeInput", JSONObject().put("activityEnd", JSONObject())))
                    false
                } else if (!committed) {
                    // The server cut the activity short: start another, or it ignores the rest.
                    startActivity()
                    false
                } else true
            }
            if (done) return complete()
            // The turn is over and no guess awaits its final. Nothing was said in this activity, so no
            // final comes at all, only this; with speech, the final arrives before it. A wait already
            // set (below) knows better.
            if (settleNow && interim.isEmpty() && !settling) settleIn(500)
        }
        val content = msg.optJSONObject("serverContent") ?: return
        // A frame may carry both; the final wins.
        val final = content.optJSONObject("inputTranscription")
        val guess = content.optJSONObject("interimInputTranscription")
        if (final != null && final.has("text")) {
            finals.add(final.optString("text"))
            interim = ""
            show()
            // After the turn ended, the final is followed by generationComplete; don't hang on it.
            if (committed && !isRolling()) settleIn(300)
        } else if (guess != null && guess.has("text")) {
            interim = guess.optString("text")
            show()
        }
        // While rolling over, this ends the activity cut short, not the turn.
        if ((content.optBoolean("generationComplete") || content.optBoolean("turnComplete")) && committed && !isRolling()) {
            if (finals.size > earlierFinals) return complete()
            // A turn that ends with no final is either silence or the server giving up (it closes with
            // "Resource has been exhausted" a moment later): wait for that close, so it fails instead
            // of passing for silence. Mirrors core/gemini.ts.
            settleIn(1500)
        }
    }

    companion object {
        const val URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        const val NAME = "Gemini"
        const val ROLL_AFTER_MS = 150_000
        const val ROLL_BY_MS = 200_000
        /** Quiet this long (below QUIET_LEVEL) counts as a pause to cut at. */
        private const val PAUSE_MS = 300
        private const val QUIET_LEVEL = 400
        private const val AUDIO_MIME = "audio/pcm;rate=${Recorder.SAMPLE_RATE}"
    }
}
