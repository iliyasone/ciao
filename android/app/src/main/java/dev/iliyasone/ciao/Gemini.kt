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
 * Never send language codes along with smart mode: on Gemini's transcription endpoints that silently
 * turns smart mode off. Without them the language is detected per utterance.
 *
 * Everything the socket reports is handled on the main thread, so the state needs no locks.
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
    private val settle = Runnable { complete() }

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
        send(JSONObject().put("realtimeInput", JSONObject().put("activityStart", JSONObject())))
    }

    override fun append(pcm: ByteArray, length: Int) {
        val audio = JSONObject().put("data", Base64.encodeToString(pcm, 0, length, Base64.NO_WRAP)).put("mimeType", AUDIO_MIME)
        send(JSONObject().put("realtimeInput", JSONObject().put("audio", audio)))
    }

    /** On the main thread, like everything that reads [committed]. */
    override fun commit() {
        committed = true
        send(JSONObject().put("realtimeInput", JSONObject().put("activityEnd", JSONObject())))
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
        main.removeCallbacks(settle)
        main.postDelayed(settle, ms)
    }

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
        // Nothing was said: after the turn ends no final comes at all, only this. With speech, the
        // final arrives before it.
        if (msg.optJSONObject("voiceActivity")?.optString("type") == "ACTIVITY_END" && committed && finals.isEmpty() && shown.isEmpty()) settleIn(500)
        val content = msg.optJSONObject("serverContent") ?: return
        // A frame may carry both; the final wins.
        val final = content.optJSONObject("inputTranscription")
        val guess = content.optJSONObject("interimInputTranscription")
        if (final != null && final.has("text")) {
            finals.add(final.optString("text"))
            interim = ""
            show()
            // After the turn ended, the final is followed by generationComplete; don't hang on it.
            if (committed) settleIn(300)
        } else if (guess != null && guess.has("text")) {
            interim = guess.optString("text")
            show()
        }
        if ((content.optBoolean("generationComplete") || content.optBoolean("turnComplete")) && committed) complete()
    }

    companion object {
        const val URL = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
        const val NAME = "Gemini"
        private const val AUDIO_MIME = "audio/pcm;rate=${Recorder.SAMPLE_RATE}"
    }
}
