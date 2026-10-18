package dev.iliyasone.ciao

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
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
 * Where a Gemini key works. A key from Google AI Studio calls the Gemini API; a Google Cloud key bound
 * to a service account calls the same models through Vertex AI, in the key's project, without AI
 * Studio's usage tiers. Mirrors geminiEndpoint in src/core/gemini.ts.
 */
object GeminiEndpoint {
    const val VERTEX_LIVE_URL = "wss://aiplatform.googleapis.com/ws/google.cloud.aiplatform.v1.LlmBidiService/BidiGenerateContent"

    /** Per key: its Vertex project number, or "" for AI Studio. */
    private val known = ConcurrentHashMap<String, String>()

    /** Through another proxy Google may answer differently (one country refused, another let in): check again. */
    fun forget() = known.clear()

    /**
     * Blocking. The Vertex project number of [key], or null for an AI Studio key, by the answer to
     * GET /v1beta/models on the Gemini API (see [parse]). Remembered per key. Offline throws; a check
     * with no answer to go by (a 5xx) counts as AI Studio this once. Mirrors geminiEndpoint in
     * src/main/transcribe.ts.
     */
    fun vertexProject(context: Context, key: String): String? {
        known[key]?.let { return it.ifEmpty { null } }
        val request = Request.Builder()
            .url("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
            .header("x-goog-api-key", key)
            .build()
        // Every live session and file transcription waits for this: a stalled request must not hold them.
        val call = ApiProxy.client(context).newCall(request).apply { timeout().timeout(10, TimeUnit.SECONDS) }
        val found = call.execute().use { parse(it.code, it.body?.string() ?: "") } ?: return null
        known[key] = found
        return found.ifEmpty { null }
    }

    /**
     * Both kinds of key look alike ("AQ.…"). An AI Studio key gets the models: "". A Vertex key is
     * refused, and the refusal names its project ("consumer": "projects/906271403959"), which Vertex
     * URLs need: API_KEY_SERVICE_BLOCKED when the key is limited to Vertex AI, SERVICE_DISABLED when
     * it isn't but the project has no Gemini API. Another 400, 401 or 403 is a wrong key: "", so its
     * errors read as before. Null: no answer to go by. Mirrors parseGeminiEndpoint in src/core/gemini.ts.
     */
    fun parse(status: Int, body: String): String? {
        if (status in 200..299) return ""
        val details = runCatching { JSONObject(body).getJSONObject("error").getJSONArray("details") }.getOrNull() ?: JSONArray()
        for (i in 0 until details.length()) {
            val d = details.optJSONObject(i) ?: continue
            if (d.optString("reason") != "API_KEY_SERVICE_BLOCKED" && d.optString("reason") != "SERVICE_DISABLED") continue
            val consumer = d.optJSONObject("metadata")?.optString("consumer") ?: continue
            Regex("""^projects/(\d+)$""").find(consumer)?.let { return it.groupValues[1] }
        }
        return if (status == 400 || status == 401 || status == 403) "" else null
    }

    /** On Vertex the models carry "-preview" and live in the "global" location only. */
    fun vertexModel(project: String, model: String) = "projects/$project/locations/global/publishers/google/models/$model-preview"
}

/**
 * One Gemini Live transcription session.
 *
 * The turn is ours, not the server's: automatic voice detection is off, so a pause to think doesn't
 * end the dictation; configure() starts the turn and commit() ends it. While you speak the server
 * sends interim guesses, each replacing the last, and a final transcript per finished segment, which
 * may differ from the guesses before it.
 *
 * The server ends an activity on its own about 220 s after it started and ignores the audio after
 * that, so a long dictation is cut into several, each with its own final: [ROLL_AFTER_MS] into one,
 * it ends at the next pause, or at [ROLL_BY_MS] without one. The next may start only once the server
 * reports the end (ACTIVITY_END), so the audio in between is held and sent after it. Should the
 * server end one first, the next starts right away. Mirrors src/core/gemini.ts.
 *
 * Vertex AI speaks the same protocol at another address, with the model named by its full path; the
 * socket opens once [GeminiEndpoint] knows which, and what is sent before waits in [pending].
 *
 * No language codes are sent: without them the language is detected per utterance.
 *
 * Everything the socket reports is handled on the main thread, so the state needs no locks, except
 * what [append] shares from the recorder's thread: that is under [lock].
 */
class GeminiSession(private val context: Context, private val apiKey: String) : LiveSession {
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

    /** Null until the endpoint is known; then [pending] goes out. Both under [lock]. */
    private var socket: WebSocket? = null
    private val pending = mutableListOf<JSONObject>()
    /** Roughly what [pending] holds, for [queued]: a replay must not pile up while the endpoint is found. */
    private var pendingBytes = 0L
    /** The Vertex project of the key, null for AI Studio; set before [socket]. */
    private var vertexProject: String? = null

    init {
        Thread {
            val project = try {
                Result.success(GeminiEndpoint.vertexProject(context, apiKey))
            } catch (e: IOException) {
                Result.failure(e)
            }
            main.post {
                if (closedByUs) return@post
                project.onSuccess { open(it) }.onFailure { fail(context.getString(R.string.error_cannot_reach, NAME)) }
            }
        }.start()
    }

    private fun open(project: String?) {
        vertexProject = project
        // The key goes in a header, not ?key=: query strings end up in logs.
        val ws = ApiProxy.client(context).newWebSocket(
            Request.Builder().url(if (project != null) GeminiEndpoint.VERTEX_LIVE_URL else URL).header("x-goog-api-key", apiKey).build(),
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
        synchronized(lock) {
            socket = ws
            for (msg in pending) ws.send(wire(msg))
            pending.clear()
            pendingBytes = 0
        }
    }

    override val usable: Boolean get() = failure == null && !closedByUs

    override val queued: Long get() = synchronized(lock) { socket?.queueSize() ?: pendingBytes }

    override fun configure(prefs: Prefs) {
        val transcription = JSONObject().put("mode", "VERBATIM")
        val terms = geminiVocabulary(prefs.keywords)
        if (terms.isNotEmpty()) transcription.put("customVocabulary", JSONArray(terms))
        val setup = JSONObject()
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
        synchronized(lock) { socket?.close(1000, null) }
    }

    /** OkHttp queues anything sent before the socket opens; before there is one, [pending] does. */
    private fun send(msg: JSONObject) {
        synchronized(lock) {
            val ws = socket
            if (ws != null) return ws.send(wire(msg)).let {}
            pending.add(msg)
            pendingBytes += msg.toString().length
        }
    }

    /** The JSON for a message; the setup gets the model's name for the endpoint. */
    private fun wire(msg: JSONObject): String {
        val setup = msg.optJSONObject("setup") ?: return msg.toString()
        val model = Provider.GEMINI.liveModel
        setup.put("model", vertexProject?.let { GeminiEndpoint.vertexModel(it, model) } ?: "models/$model")
        return msg.toString()
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
