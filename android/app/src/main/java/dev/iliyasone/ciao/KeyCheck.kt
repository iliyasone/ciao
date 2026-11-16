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
}
