package dev.iliyasone.ciao

import android.content.Context
import okhttp3.Request
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Asks the service whether it takes the key, the cheapest way it has: both list their models. A
 * Vertex key is refused by the Gemini API in a way that names its project: that counts as working.
 * Mirrors checkKey in src/main/transcribe.ts.
 */
object KeyCheck {
    sealed interface Result {
        data class Works(val ms: Long) : Result
        /** The service refused the key. */
        data class Rejected(val reason: String) : Result
        /** The service isn't available where the request came from: a proxy is needed. */
        data class Region(val reason: String) : Result
        /** No answer: no connection, or the proxy didn't let it through. */
        data class Offline(val reason: String) : Result
    }

    /** Blocking: call it off the main thread. */
    fun check(context: Context, provider: Provider, key: String): Result {
        val started = System.currentTimeMillis()
        if (provider == Provider.LOCAL) return if (LocalAsr.available()) Result.Works(0) else Result.Rejected(context.getString(R.string.error_provider, LocalAsr.NAME))
        if (provider == Provider.CHATGPT) return checkSocket(context, ChatGPT.socketRequest(key), ChatGPT.NAME, started)
        if (provider == Provider.NEMOTRON) return checkSocket(context, Request.Builder().url(NemotronSession.URL).header("Authorization", "Bearer $key").build(), NemotronSession.NAME, started)
        return try {
            val request = if (provider == Provider.GEMINI) {
                val (base, serverKey) = GeminiEndpoint.access(key)
                Request.Builder().url("$base/v1beta/models?pageSize=1").header("x-goog-api-key", serverKey).build()
            } else {
                Request.Builder().url("https://api.openai.com/v1/models").header("Authorization", "Bearer $key").build()
            }
            val call = ApiProxy.client(context).newCall(request).apply { timeout().timeout(10, TimeUnit.SECONDS) }
            call.execute().use { res ->
                val body = res.body?.string() ?: ""
                val vertex = provider == Provider.GEMINI && !res.isSuccessful && !GeminiEndpoint.parse(res.code, body).isNullOrEmpty()
                if (res.isSuccessful || vertex) return Result.Works(System.currentTimeMillis() - started)
                val message = runCatching { JSONObject(body).getJSONObject("error").getString("message") }.getOrNull() ?: "HTTP ${res.code}"
                // Gemini: "User location is not supported for the API use."; OpenAI: unsupported_country_region_territory.
                when {
                    body.contains("location is not supported", true) || body.contains("unsupported_country", true) -> Result.Region(message)
                    // Only these say the key itself is wrong; 429 or a 5xx says nothing about it.
                    res.code == 400 || res.code == 401 || res.code == 403 -> Result.Rejected(message)
                    else -> Result.Offline(message)
                }
            }
        } catch (e: Exception) {
            var cause: Throwable = e
            while (cause.cause != null) cause = cause.cause!!
            Result.Offline(cause.message ?: cause.toString())
        }
    }

    /**
     * .wave and ChatGPT have no request to ask with: their live socket opens with a key they take
     * (no audio, no charge); 401 or 403 is one they don't. As checkKey on the desktop.
     */
    private fun checkSocket(context: Context, request: Request, name: String, started: Long): Result {
        val answer = java.util.concurrent.ArrayBlockingQueue<Result>(1)
        val socket = ApiProxy.client(context).newBuilder().callTimeout(10, TimeUnit.SECONDS).build().newWebSocket(
            request,
            object : okhttp3.WebSocketListener() {
                override fun onOpen(webSocket: okhttp3.WebSocket, response: okhttp3.Response) {
                    answer.offer(Result.Works(System.currentTimeMillis() - started))
                    webSocket.close(1000, null)
                }

                override fun onFailure(webSocket: okhttp3.WebSocket, t: Throwable, response: okhttp3.Response?) {
                    answer.offer(when (response?.code) {
                        401, 403 -> Result.Rejected(if (name == ChatGPT.NAME) context.getString(R.string.error_signed_out, name) else context.getString(R.string.error_bad_key, name))
                        null -> Result.Offline(t.message ?: t.toString())
                        else -> Result.Offline("HTTP ${response.code}")
                    })
                }
            },
        )
        return answer.poll(12, TimeUnit.SECONDS) ?: Result.Offline(context.getString(R.string.error_timeout, name)).also { socket.cancel() }
    }
}
