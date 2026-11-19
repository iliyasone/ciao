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
import org.json.JSONObject

/**
 * NVIDIA's Nemotron 3.5 ASR Streaming, run by .wave (dotwave.ai) behind OpenAI's Realtime
 * transcription events; a port of NemotronSession in src/core/nemotron.ts.
 *
 * .wave transcribes against a clock that starts with the first audio: audio more than 640 ms ahead
 * of it ends the session, audio behind it counts as silence. So audio goes out no faster than it was
 * spoken: a backlog (audio from before the socket opened, a replay) drains at the speed of speech.
 * The first audio is [LEAD_MS] of silence, so a chunk that comes a little late is still in time.
 *
 * For the same reason silence is sent too, unlike with OpenAI and Gemini; .wave bills the session's
 * length anyway. A session that gets no audio closes after 30 s (hence the pool's short spare age).
 * No terms, context or language: the language is detected as you speak.
 *
 * Everything but [append] (the recorder's thread) runs on the main thread; the backlog is under [lock].
 */
class NemotronSession(private val context: Context, apiKey: String) : LiveSession {
    override val createdAt = SystemClock.elapsedRealtime()

    @Volatile override var failure: String? = null
        private set

    override var listener: LiveSession.Listener? = null

    @Volatile private var closedByUs = false
    @Volatile private var connected = false
    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()
    private val pending = ArrayDeque<ByteArray>()
    /** When the first audio went out; 0 before. */
    private var startedAt = 0L
    private var sentBytes = 0L
    private var committed = false
    private var commitSent = false
    private val drainLater = Runnable { drain() }

    private val socket: WebSocket = ApiProxy.client(context).newWebSocket(
        Request.Builder().url(URL).header("Authorization", "Bearer $apiKey").build(),
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                connected = true
                main.post { drain() }
            }

            override fun onMessage(webSocket: WebSocket, text: String) = handle(text)

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = fail(socketError(context, NAME, response))

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                fail(context.getString(R.string.error_closed, reason))
            }
        },
    )

    override val usable: Boolean get() = failure == null && !closedByUs

    override val queued: Long get() = socket.queueSize() + synchronized(lock) { pending.sumOf { it.size.toLong() } }

    override val skippedBytes: Long get() = 0

    override fun configure(prefs: Prefs) {
        val format = JSONObject().put("type", "audio/pcm").put("rate", Recorder.SAMPLE_RATE)
        val input = JSONObject().put("format", format).put("transcription", JSONObject().put("model", Provider.NEMOTRON.liveModel)).put("turn_detection", JSONObject.NULL)
        val session = JSONObject().put("type", "transcription").put("audio", JSONObject().put("input", input))
        socket.send(JSONObject().put("type", "session.update").put("session", session).toString())
    }

    override fun append(pcm: ByteArray, length: Int) {
        synchronized(lock) { pending.addLast(pcm.copyOf(length)) }
        main.post { drain() }
    }

    /** Once the backlog is out. */
    override fun commit() {
        committed = true
        drain()
    }

    override fun close() {
        closedByUs = true
        main.removeCallbacks(drainLater)
        socket.close(1000, null)
    }

    /** Sends what the clock allows, and comes back for the rest. Main thread. */
    private fun drain() {
        main.removeCallbacks(drainLater)
        if (!connected || !usable) return
        val more = synchronized(lock) {
            if (startedAt == 0L && pending.isNotEmpty()) {
                startedAt = SystemClock.elapsedRealtime()
                pending.addFirst(ByteArray(LEAD_MS * BYTES_PER_MS))
            }
            var allowed = ((SystemClock.elapsedRealtime() - startedAt + LEAD_MS) * BYTES_PER_MS / 2) * 2 - sentBytes
            while (pending.isNotEmpty() && allowed > 0) {
                val pcm = pending.removeFirst()
                val n = minOf(pcm.size.toLong(), allowed).toInt()
                if (n < pcm.size) pending.addFirst(pcm.copyOfRange(n, pcm.size))
                socket.send(JSONObject().put("type", "input_audio_buffer.append").put("audio", Base64.encodeToString(pcm, 0, n, Base64.NO_WRAP)).toString())
                sentBytes += n
                allowed -= n
            }
            pending.isNotEmpty()
        }
        if (more) main.postDelayed(drainLater, 40)
        else if (committed && !commitSent) {
            commitSent = true
            socket.send(JSONObject().put("type", "input_audio_buffer.commit").toString())
        }
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
            "error" -> fail(msg.optJSONObject("error")?.optString("message")?.takeIf { it.isNotEmpty() } ?: context.getString(R.string.error_provider, NAME))
        }
    }

    companion object {
        const val URL = "wss://api.dotwave.ai/v1/realtime?model=nemotron-asr-streaming"
        const val NAME = "Nemotron"
        private const val LEAD_MS = 300
        private const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000
    }
}
