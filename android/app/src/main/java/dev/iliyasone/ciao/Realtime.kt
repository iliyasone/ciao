package dev.iliyasone.ciao

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

// The OpenAI Realtime transcription protocol, as in src/core/realtime.ts.

val http: OkHttpClient = OkHttpClient.Builder()
    .pingInterval(20, TimeUnit.SECONDS)
    .readTimeout(120, TimeUnit.SECONDS)
    .build()

/**
 * One OpenAI Realtime transcription session. Opening the socket takes 0.3–1 s, so it is opened
 * ahead of time and kept idle until speech starts (idle sessions carry no audio and cost nothing).
 * OkHttp queues anything sent before the socket opens. Callbacks arrive on the main thread.
 */
class RealtimeSession(private val context: Context, apiKey: String) {
    interface Listener {
        fun onDelta(text: String)
        fun onCompleted(text: String)
        fun onError(message: String)
    }

    val createdAt = SystemClock.elapsedRealtime()

    @Volatile var failure: String? = null
        private set

    var listener: Listener? = null

    @Volatile private var closedByUs = false
    private val main = Handler(Looper.getMainLooper())

    private val socket: WebSocket = http.newWebSocket(
        Request.Builder().url(URL).header("Authorization", "Bearer $apiKey").build(),
        object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = handle(text)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val status = response?.code
                fail(
                    when (status) {
                        null -> context.getString(R.string.error_cannot_reach)
                        401 -> context.getString(R.string.error_bad_key)
                        else -> context.getString(R.string.error_status, status)
                    },
                )
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                fail(context.getString(R.string.error_closed, reason))
            }
        },
    )

    /** Still worth handing to a new dictation. */
    val usable: Boolean get() = failure == null && !closedByUs

    fun configure(prefs: Prefs, delay: String = prefs.delay) {
        val transcription = JSONObject().put("model", prefs.liveModel).put("delay", delay)
        if (prefs.languages.isNotEmpty()) transcription.put("languages", JSONArray(prefs.languages))
        if (prefs.prompt.isNotBlank()) transcription.put("prompt", prefs.prompt.trim())
        // The API rejects keywords containing <, > or line breaks.
        val keywords = prefs.keywords.filter { k -> k.none { it in "<>\r\n" } }
        if (keywords.isNotEmpty()) transcription.put("keywords", JSONArray(keywords))
        val format = JSONObject().put("type", "audio/pcm").put("rate", Recorder.SAMPLE_RATE)
        val input = JSONObject().put("format", format).put("transcription", transcription).put("turn_detection", JSONObject.NULL)
        val session = JSONObject().put("type", "transcription").put("audio", JSONObject().put("input", input))
        send(JSONObject().put("type", "session.update").put("session", session))
    }

    fun append(pcm: ByteArray, length: Int = pcm.size) {
        send(JSONObject().put("type", "input_audio_buffer.append").put("audio", Base64.encodeToString(pcm, 0, length, Base64.NO_WRAP)))
    }

    fun commit() = send(JSONObject().put("type", "input_audio_buffer.commit"))

    fun close() {
        closedByUs = true
        socket.close(1000, null)
    }

    private fun send(msg: JSONObject) {
        socket.send(msg.toString())
    }

    private fun fail(message: String) {
        if (failure != null || closedByUs) return
        failure = message
        main.post { listener?.onError(message) }
    }

    private fun handle(raw: String) {
        val msg = try {
            JSONObject(raw)
        } catch (e: Exception) {
            return
        }
        when (msg.optString("type")) {
            "conversation.item.input_audio_transcription.delta" -> {
                val delta = msg.optString("delta")
                main.post { listener?.onDelta(delta) }
            }
            "conversation.item.input_audio_transcription.completed" -> {
                val transcript = msg.optString("transcript")
                main.post { listener?.onCompleted(transcript) }
            }
            "error" -> fail(msg.optJSONObject("error")?.optString("message")?.takeIf { it.isNotEmpty() } ?: context.getString(R.string.error_openai))
        }
    }

    companion object {
        const val URL = "wss://api.openai.com/v1/realtime?intent=transcription"
    }
}

/** Keeps one connected session in reserve so dictation starts streaming instantly. */
class SessionPool(private val context: Context, private val prefs: Prefs) {
    private var spare: RealtimeSession? = null

    /** Called on every keyboard event; a failed spare (offline, bad key) is retried at most every 30 s. */
    fun refill() {
        val s = spare
        val now = SystemClock.elapsedRealtime()
        if (s != null && s.usable && now - s.createdAt < MAX_AGE_MS) return
        if (s != null && s.failure != null && now - s.createdAt < RETRY_MS) return
        s?.close()
        spare = prefs.apiKey.takeIf { it.isNotEmpty() }?.let { RealtimeSession(context, it) }
    }

    fun take(): RealtimeSession {
        val s = spare?.takeIf { it.usable && SystemClock.elapsedRealtime() - it.createdAt < MAX_AGE_MS }
        if (s == null) spare?.close()
        spare = null
        val session = s ?: RealtimeSession(context, prefs.apiKey)
        refill()
        return session
    }

    fun close() {
        spare?.close()
        spare = null
    }

    private companion object {
        const val MAX_AGE_MS = 10 * 60_000L
        const val RETRY_MS = 30_000L
    }
}
