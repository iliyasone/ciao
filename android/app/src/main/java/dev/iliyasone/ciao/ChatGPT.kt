package dev.iliyasone.ciao

import android.annotation.SuppressLint
import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Base64
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.TimeUnit

// ChatGPT's own dictation, as chatgpt.com uses it in its message box: not a public API. A port of
// src/core/chatgpt.ts (the session) and src/main/chatgpt.ts (signing in and renewing the token).
// The socket and the file endpoint take the access token of a signed-in ChatGPT account (free ones
// too), which chatgpt.com/api/auth/session hands out for about 10 days. It is ChatGPT's key here
// (Prefs.chatgptToken), synced like the other keys.

object ChatGPT {
    const val NAME = "ChatGPT"
    const val LIVE_URL = "wss://chatgpt.com/backend-api/dictation/stream?client_type=web&dictation_surface=composer"
    const val FILE_URL = "https://chatgpt.com/backend-api/transcribe"
    const val ORIGIN = "https://chatgpt.com"
    private const val LOGIN_URL = "https://chatgpt.com/auth/login"
    private const val SESSION_URL = "https://chatgpt.com/api/auth/session"
    /** A token lasts about 10 days; it is renewed once less than this is left. */
    private const val RENEW_BEFORE_MS = 3 * 24 * 3600_000L

    /** The socket to the dictation, opened the way chatgpt.com opens it: the token goes as a sub-protocol. */
    fun socketRequest(token: String): Request = Request.Builder().url(LIVE_URL)
        .header("Sec-WebSocket-Protocol", "chatgpt-dictation, openai-bearer.$token")
        .header("Origin", ORIGIN)
        .build()

    class Account(val email: String, val expiresAt: Long)

    /** The account a token is for and when it expires, read from the token itself (a JWT). Null for anything else. */
    fun account(token: String): Account? = runCatching {
        val claims = JSONObject(String(java.util.Base64.getUrlDecoder().decode(token.split(".")[1].trimEnd('='))))
        if (!claims.has("exp")) return null
        Account(claims.optJSONObject("https://api.openai.com/profile")?.optString("email") ?: "", claims.getLong("exp") * 1000)
    }.getOrNull()

    /**
     * Blocking. The access token of the account signed in on this phone (in [SignInActivity]'s
     * cookies), null when none is. Throws when chatgpt.com gave no answer to go by. Through the proxy
     * in the settings, as the dictation: chatgpt.com isn't available in every country.
     */
    fun currentToken(context: Context): String? {
        val cookies = CookieManager.getInstance()
        val jar = cookies.getCookie(ORIGIN) ?: return null
        val request = Request.Builder().url(SESSION_URL).header("Cookie", jar).build()
        val call = ApiProxy.client(context).newCall(request).apply { timeout().timeout(15, TimeUnit.SECONDS) }
        return call.execute().use { res ->
            // chatgpt.com may hand out a renewed session cookie with it: keep it for next time.
            for (c in res.headers("Set-Cookie")) cookies.setCookie(ORIGIN, c)
            cookies.flush()
            if (!res.isSuccessful) throw java.io.IOException("chatgpt.com answered ${res.code}")
            JSONObject(res.body?.string() ?: "").optString("accessToken").ifEmpty { null } // a challenge page instead of JSON throws
        }
    }

    /**
     * Blocking. Renews the saved token once it runs out soon ([force]: now, after ChatGPT refused it),
     * from this phone's sign-in. Never forgets it: it may have come through sync from a device still
     * signed in, which renews it for everyone. True if the saved token changed. Mirrors renewToken in
     * src/main/chatgpt.ts.
     */
    @Synchronized
    fun renew(context: Context, force: Boolean = false): Boolean {
        val prefs = Prefs(context)
        val saved = prefs.chatgptToken
        if (saved.isEmpty()) return false
        val expiresAt = account(saved)?.expiresAt ?: 0L
        if (!force && expiresAt - System.currentTimeMillis() > RENEW_BEFORE_MS) return false
        val token = try {
            currentToken(context)
        } catch (e: Exception) {
            android.util.Log.w("Ciao", "chatgpt: the token wasn't renewed: ${e.message}")
            return false
        }
        // Not signed in here, or this phone's cookies are another account's (the saved token came through sync).
        if (token == null || token == saved || account(token)?.email != account(saved)?.email) return false
        var changed = false
        // Under sync's lock: signed out, or another token synced in, while the request was out wins.
        GoogleSync.edit(context) {
            if (it.chatgptToken == saved) {
                it.chatgptToken = token
                changed = true
            }
        }
        if (changed) android.util.Log.i("Ciao", "chatgpt: token renewed")
        return changed
    }

    /** Off the main thread. */
    fun renewSoon(context: Context, force: Boolean = false) {
        val app = context.applicationContext
        Thread { renew(app, force) }.start()
    }

    /** Forgets the token (on every synced device, as removing a key does) and this phone's sign-in. */
    fun signOut(context: Context) {
        GoogleSync.edit(context) { it.chatgptToken = "" }
        CookieManager.getInstance().removeAllCookies(null)
        WebStorage.getInstance().deleteAllData()
    }

    /**
     * chatgpt.com in a window of Ciao's: once /api/auth/session gives a token, it is saved and the
     * window closes (RESULT_OK). Checked after each page and every 2 s: some steps change the page
     * without navigating. Already signed in (the cookies hold a sign-in): it closes at once.
     */
    class SignInActivity : Activity() {
        private val main = Handler(Looper.getMainLooper())
        private var done = false
        private var checking = false
        private lateinit var web: WebView

        private val poll = object : Runnable {
            override fun run() {
                check()
                main.postDelayed(this, 2000)
            }
        }

        @SuppressLint("SetJavaScriptEnabled")
        override fun onCreate(savedInstanceState: Bundle?) {
            super.onCreate(savedInstanceState)
            title = NAME
            web = WebView(this)
            web.settings.javaScriptEnabled = true
            web.settings.domStorageEnabled = true
            // Google's sign-in turns away a page that says it is a WebView ("; wv"): chatgpt.com sees a plain Chrome.
            web.settings.userAgentString = web.settings.userAgentString.replace("; wv", "").replace(Regex(" Version/\\S+"), "")
            CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)
            web.webViewClient = object : WebViewClient() {
                override fun onPageFinished(view: WebView, url: String) = check()
            }
            setContentView(web)
            web.loadUrl(LOGIN_URL)
            main.postDelayed(poll, 2000)
        }

        private fun check() {
            if (done || checking) return
            checking = true
            val app = applicationContext
            Thread {
                val token = runCatching { currentToken(app) }.getOrNull()
                main.post {
                    checking = false
                    if (token == null || done || isFinishing) return@post
                    done = true
                    GoogleSync.edit(app) { it.chatgptToken = token }
                    setResult(RESULT_OK)
                    finish()
                }
            }.start()
        }

        override fun onDestroy() {
            main.removeCallbacksAndMessages(null)
            web.destroy()
            super.onDestroy()
        }
    }
}

/**
 * One ChatGPT dictation stream; a port of ChatGPTSession in src/core/chatgpt.ts.
 *
 * session.start configures it; audio goes in as is (it costs nothing, so silence isn't left out);
 * session.close ends it. The server finds speech itself and sends the text of each utterance as it
 * grows ("transcript.segment", the whole utterance so far, a higher revision replacing a lower one),
 * then once more as final ("transcript.final"). With session.updated "closed" every final is in.
 * In practice a dictation is one utterance however long, and the session lasts as long as audio keeps
 * coming (session_ttl_ms counts from the last audio).
 *
 * The server can give up on an utterance ("transcript.failed"): the live text stays on screen, and at
 * the end the session fails, so the whole recording goes to the file model, as chatgpt.com does.
 *
 * No terms, context or language: the language is detected as you speak.
 * Everything the socket reports is handled on the main thread.
 */
class ChatGPTSession(private val context: Context, token: String) : LiveSession {
    override val createdAt = SystemClock.elapsedRealtime()

    @Volatile override var failure: String? = null
        private set

    override var listener: LiveSession.Listener? = null

    @Volatile private var closedByUs = false
    private var completed = false
    private var committed = false
    private val main = Handler(Looper.getMainLooper())

    private class Utterance(val revision: Int, val text: String, val final: Boolean)

    /** By id, in the order spoken. */
    private val utterances = LinkedHashMap<String, Utterance>()
    private var shown = ""
    /** An utterance the server gave up on: the session fails once it is over. */
    private var lost: String? = null

    private val socket: WebSocket = ApiProxy.client(context).newWebSocket(
        ChatGPT.socketRequest(token),
        object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                main.post { handle(text) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (response?.code == 401) ChatGPT.renewSoon(context, force = true)
                main.post { fail(if (response?.code == 401) context.getString(R.string.error_signed_out, ChatGPT.NAME) else socketError(context, ChatGPT.NAME, response)) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                main.post { if (!completed) fail(context.getString(R.string.error_closed, reason)) }
            }
        },
    )

    override val usable: Boolean get() = failure == null && !closedByUs

    override val queued: Long get() = socket.queueSize()

    override val skippedBytes: Long get() = 0

    override fun configure(prefs: Prefs) {
        val vad = JSONObject().put("type", "server_vad").put("threshold", 0.5).put("prefix_padding_ms", 300).put("silence_duration_ms", 500)
        val config = JSONObject()
            .put("language", JSONObject.NULL)
            .put("input_audio_format", "pcm16")
            .put("sample_rate_hz", Recorder.SAMPLE_RATE)
            .put("num_channels", 1)
            .put("max_buffer_size_bytes", 4194304)
            .put("max_utterance_duration_ms", 30000)
            .put("session_ttl_ms", 300000)
            .put("provider_mode", "streaming_sse")
            .put("transcript_delivery_mode", "segment")
            .put("vad", vad)
        send(JSONObject().put("type", "session.start").put("dictation_session_id", UUID.randomUUID().toString()).put("attempt_id", UUID.randomUUID().toString()).put("config", config))
    }

    /** From the recorder's thread too: OkHttp's send is thread-safe. */
    override fun append(pcm: ByteArray, length: Int) {
        send(JSONObject().put("type", "audio.append").put("audio", Base64.encodeToString(pcm, 0, length, Base64.NO_WRAP)))
    }

    /** chatgpt.com ends with 250 ms of silence before session.close. */
    override fun commit() {
        if (committed) return
        committed = true
        append(ByteArray(TAIL_MS * Recorder.SAMPLE_RATE * 2 / 1000))
        send(JSONObject().put("type", "session.close"))
    }

    override fun close() {
        closedByUs = true
        socket.close(1000, null)
    }

    private fun send(msg: JSONObject) {
        socket.send(msg.toString())
    }

    private fun fail(message: String) {
        if (failure != null || closedByUs || completed) return
        failure = message
        listener?.onError(message)
    }

    /** Each utterance's final, or its latest text before one, in order. */
    private fun text() = utterances.values.map { it.text.trim() }.filter { it.isNotEmpty() }.joinToString(" ")

    private fun show() {
        val text = text()
        if (text == shown) return
        if (text.startsWith(shown)) listener?.onDelta(text.substring(shown.length)) else listener?.onRevise(text)
        shown = text
    }

    private fun handle(raw: String) {
        val msg = try {
            JSONObject(raw)
        } catch (e: Exception) {
            return
        }
        val error = msg.optJSONObject("error")?.optString("message")?.takeIf { it.isNotEmpty() } ?: context.getString(R.string.error_provider, ChatGPT.NAME)
        when (val type = msg.optString("type")) {
            "transcript.segment", "transcript.final" -> {
                val id = msg.optString("utterance_id")
                val revision = msg.optInt("revision")
                val final = type == "transcript.final"
                val u = utterances[id]
                // As chatgpt.com: a final replaces anything but a later final; a guess, only an earlier guess.
                if (u != null && (if (final) u.final && revision < u.revision else u.final || revision < u.revision)) return
                utterances[id] = Utterance(revision, msg.optString("text"), final)
                show()
            }
            "transcript.failed" -> if (lost == null) lost = error
            "session.error" -> if (msg.optBoolean("fatal")) fail(error)
            "session.updated" -> {
                if (msg.optJSONObject("session")?.optString("status") != "closed") return
                // Before the end of the dictation: the server closed it on its own.
                if (!committed) return fail(context.getString(R.string.error_closed, ""))
                lost?.let { return fail(it) }
                completed = true
                listener?.onCompleted(text())
            }
        }
    }

    private companion object {
        const val TAIL_MS = 250
    }
}
