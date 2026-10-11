package dev.iliyasone.ciao

import android.util.Log
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

// The term a "чао, запомни слово …" command asked for (VoiceCommands.takeRememberCommands); a port
// of src/core/terms.ts. A small text model of the same provider, with the same key, writes what the
// recognizer heard (misheard, in Cyrillic, spelled letter by letter) the usual way.

object Terms {
    /** The same models and prompt as TERM_MODELS and TERM_PROMPT in src/core/terms.ts. */
    fun model(p: Provider) = if (p == Provider.GEMINI) "gemini-3.5-flash-lite" else "gpt-5.4-mini"

    const val PROMPT = """The user is dictating and asked the app to remember a term for the speech recognizer's vocabulary. You get what the recognizer heard after the command: the term, possibly misheard, written in Cyrillic though meant in Latin, or spelled out letter by letter (in Russian or English letter names: "пэ, о, эс, тэ", "эйч", "дабл ю", "P-O-S-T").
Answer with the term only, written the way it is normally written: the script, capitalization and spacing of a known product, library, command or name (PostHog, Kubernetes, pnpm, Next.js). Spelled letters are joined into the word, cased as that word is usually written. A Russian word meant in Russian stays in Cyrillic. No quotes, no explanation, nothing else. If there is no term in it, answer with an empty string."""

    /** Longer than this, the answer is not a term but the model talking. */
    private const val MAX_TERM = 60
    /** A model that takes longer is not coming: the word as heard is kept instead ([fallback]). */
    private val client by lazy { http.newBuilder().callTimeout(10, TimeUnit.SECONDS).build() }

    private fun isLatin(c: Char) = Character.UnicodeScript.of(c.code) == Character.UnicodeScript.LATIN

    /**
     * The term as heard, when that is already how it's written: one Latin word with a recognizer's
     * deliberate spelling in it (inner capitals, digits, dots: "PostHog", "Next.js", "gpt-5", "API").
     */
    fun plain(c: VoiceCommands.RememberCommand): String? {
        val w = c.heard
        if (c.spelled || w.isEmpty() || !w.all { isLatin(it) || it.isDigit() || it in ".+#_'’-" } || w.none { it.isLetter() }) return null
        val marked = w.drop(1).any { it.isUpperCase() } || w.any { it.isDigit() || it in ".+#_-" } || (w.length >= 2 && w.all { it.isUpperCase() })
        return if (marked) w else null
    }

    /** Without the model (no network, an error): a short term as heard, or Latin letters joined. */
    fun fallback(c: VoiceCommands.RememberCommand): String? {
        if (c.spelled) {
            val letters = c.heard.split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }
            return if (letters.all { it.length == 1 && (isLatin(it[0]) || it[0].isDigit()) }) letters.joinToString("") else null
        }
        return if (c.heard.isNotEmpty() && c.heard.split(Regex("\\s+")).size <= 3) c.heard else null
    }

    /** The model's answer as a term: one line, without quotes or a final period; null if none. */
    fun clean(answer: String): String? {
        val term = answer.replace(Regex("(?U)^[\\s\"'«“`]+|[\\s\"'»”`.]+$"), "")
        return term.takeIf { it.isNotEmpty() && it.length <= MAX_TERM && it.none { ch -> ch in "\r\n<>" } }
    }

    /** Blocking: asks the provider's text model for the term; throws on a network or API error. */
    fun fromModel(provider: Provider, key: String, heard: String): String? {
        val request = if (provider == Provider.GEMINI) {
            val body = JSONObject()
                .put("systemInstruction", JSONObject().put("parts", JSONArray().put(JSONObject().put("text", PROMPT))))
                .put("contents", JSONArray().put(JSONObject().put("role", "user").put("parts", JSONArray().put(JSONObject().put("text", heard)))))
                .put("generationConfig", JSONObject().put("thinkingConfig", JSONObject().put("thinkingLevel", "minimal")))
            Request.Builder()
                .url("https://generativelanguage.googleapis.com/v1beta/models/${model(provider)}:generateContent")
                .header("x-goog-api-key", key)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
        } else {
            val body = JSONObject()
                .put("model", model(provider))
                .put("reasoning_effort", "none")
                .put("messages", JSONArray()
                    .put(JSONObject().put("role", "system").put("content", PROMPT))
                    .put(JSONObject().put("role", "user").put("content", heard)))
            Request.Builder()
                .url("https://api.openai.com/v1/chat/completions")
                .header("Authorization", "Bearer $key")
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
        }
        client.newCall(request).execute().use { res ->
            val json = runCatching { JSONObject(res.body!!.string()) }.getOrDefault(JSONObject())
            if (!res.isSuccessful) throw IOException(json.optJSONObject("error")?.optString("message")?.takeIf { it.isNotEmpty() } ?: "${provider.displayName} ${res.code}")
            val answer = if (provider == Provider.GEMINI) {
                val parts = json.optJSONArray("candidates")?.optJSONObject(0)?.optJSONObject("content")?.optJSONArray("parts")
                (0 until (parts?.length() ?: 0)).joinToString("") { parts!!.optJSONObject(it)?.optString("text") ?: "" }
            } else {
                json.optJSONArray("choices")?.optJSONObject(0)?.optJSONObject("message")?.optString("content") ?: ""
            }
            return clean(answer)
        }
    }

    /** Blocking: the term a command asked for, as heard when that's enough, else from the model, else a fallback. */
    fun resolve(provider: Provider, key: String, c: VoiceCommands.RememberCommand): String? {
        if (c.heard.isEmpty()) return null
        plain(c)?.let { return it }
        return try {
            fromModel(provider, key, c.heard) ?: fallback(c)
        } catch (e: Exception) {
            Log.w("Ciao", "term from model: ${e.message}")
            fallback(c)
        }
    }

    /**
     * The terms with [term] added; one differing only in case is replaced (the user just said how it
     * is written). Null when it's there already.
     */
    fun add(keywords: List<String>, term: String): List<String>? {
        if (keywords.any { it.trim() == term }) return null
        return keywords.filter { !it.trim().equals(term, ignoreCase = true) } + term
    }
}
