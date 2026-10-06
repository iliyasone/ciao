package dev.iliyasone.ciao

import android.content.Context
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Transcribes a whole recording with the (more accurate, cheaper) file model of the service in use:
 * the fallback when the live connection dropped. Mirrors transcribeFile in src/main/transcribe.ts.
 */
object FileTranscriber {
    // The endpoint takes up to 25 MB, i.e. ~8.5 min of 24 kHz PCM16. Longer recordings are split at
    // the quietest moment near each boundary so no word is cut in half.
    // Gemini takes the audio inline as base64 in a JSON body; 4 min is ~15 MB of it.
    private const val MAX_PART_MS = 8 * 60_000
    private const val GEMINI_MAX_PART_MS = 4 * 60_000
    private const val SEARCH_MS = 10_000
    private const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000

    /**
     * Blocking; call off the main thread. [provider] and [smart] are the dictation's own, as when it
     * started; [key] is that provider's current key (a retry after fixing a bad key must use the new one).
     */
    fun transcribe(context: Context, prefs: Prefs, pcm: ByteArray, provider: Provider, key: String, smart: Boolean): String {
        if (provider == Provider.GEMINI) return transcribeGemini(context, prefs, pcm, key, smart)
        val texts = mutableListOf<String>()
        val hints = listOf(prefs.prompt.trim(), if (prefs.keywords.isNotEmpty()) "Термины: ${prefs.keywords.joinToString(", ")}." else "")
            .filter { it.isNotEmpty() }.joinToString(" ")
        for ((start, end) in split(pcm, MAX_PART_MS)) {
            // Continuity across parts.
            val prompt = if (texts.isEmpty()) hints else "$hints ${texts.last().takeLast(400)}".trim()
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", "audio.wav", wav(pcm, start, end).toRequestBody("audio/wav".toMediaType()))
                .addFormDataPart("model", Provider.OPENAI.fileModel)
                .apply {
                    prefs.languages.firstOrNull()?.let { addFormDataPart("language", it) }
                    if (prompt.isNotEmpty()) addFormDataPart("prompt", prompt)
                }
                .build()
            val request = Request.Builder()
                .url("https://api.openai.com/v1/audio/transcriptions")
                .header("Authorization", "Bearer $key")
                .post(body)
                .build()
            val response = try {
                http.newCall(request).execute()
            } catch (e: IOException) {
                throw IOException(context.getString(R.string.error_cannot_reach, RealtimeSession.NAME), e)
            }
            response.use {
                val json = runCatching { JSONObject(it.body!!.string()) }.getOrDefault(JSONObject())
                if (!it.isSuccessful) {
                    throw IOException(json.optJSONObject("error")?.optString("message")?.takeIf { m -> m.isNotEmpty() } ?: context.getString(R.string.error_status, RealtimeSession.NAME, it.code))
                }
                texts.add(json.optString("text").trim())
            }
        }
        return texts.filter { it.isNotEmpty() }.joinToString(" ")
    }

    /**
     * gemini-3.5-transcribe through the Interactions API: the only Gemini endpoint where smart mode
     * works. Never add language codes, see Gemini.kt. Mirrors transcribeFileGemini.
     */
    private fun transcribeGemini(context: Context, prefs: Prefs, pcm: ByteArray, key: String, smart: Boolean): String {
        val config = JSONObject()
        if (smart) config.put("mode", "smart")
        val terms = geminiVocabulary(prefs.keywords)
        if (terms.isNotEmpty()) config.put("custom_vocabulary", JSONArray(terms))
        val texts = mutableListOf<String>()
        for ((start, end) in split(pcm, GEMINI_MAX_PART_MS)) {
            val audio = JSONObject().put("type", "audio").put("mime_type", "audio/wav")
                .put("data", Base64.encodeToString(wav(pcm, start, end), Base64.NO_WRAP))
            val body = JSONObject()
                .put("model", Provider.GEMINI.fileModel)
                // Interactions are kept on Google's side by default; recordings stay on this phone.
                .put("store", false)
                .put("input", JSONArray().put(audio))
            if (config.length() > 0) body.put("generation_config", JSONObject().put("transcription_config", config))
            val request = Request.Builder()
                .url("https://generativelanguage.googleapis.com/v1beta/interactions")
                .header("x-goog-api-key", key)
                .post(body.toString().toRequestBody("application/json".toMediaType()))
                .build()
            val response = try {
                http.newCall(request).execute()
            } catch (e: IOException) {
                throw IOException(context.getString(R.string.error_cannot_reach, GeminiSession.NAME), e)
            }
            response.use {
                val raw = it.body?.string() ?: ""
                // Errors come wrapped in an array here, unlike on :generateContent.
                val first = runCatching { JSONObject(raw) }.getOrNull() ?: runCatching { JSONArray(raw).getJSONObject(0) }.getOrNull() ?: JSONObject()
                val error = first.optJSONObject("error")?.optString("message")?.takeIf { m -> m.isNotEmpty() }
                if (!it.isSuccessful) throw IOException(error ?: context.getString(R.string.error_status, GeminiSession.NAME, it.code))
                val status = first.optString("status")
                if (status != "completed") throw IOException(error ?: context.getString(R.string.error_status_text, GeminiSession.NAME, status))
                val text = StringBuilder()
                val steps = first.optJSONArray("steps") ?: JSONArray()
                for (i in 0 until steps.length()) {
                    val step = steps.optJSONObject(i) ?: continue
                    if (step.optString("type") != "model_output") continue
                    val content = step.optJSONArray("content") ?: continue
                    for (j in 0 until content.length()) {
                        val c = content.optJSONObject(j) ?: continue
                        if (c.optString("type") == "text") text.append(c.optString("text"))
                    }
                }
                texts.add(text.toString().trim())
            }
        }
        return texts.filter { it.isNotEmpty() }.joinToString(" ")
    }

    private fun split(pcm: ByteArray, maxPartMs: Int): List<Pair<Int, Int>> {
        val parts = mutableListOf<Pair<Int, Int>>()
        var start = 0
        val maxBytes = maxPartMs * BYTES_PER_MS
        val step = 100 * BYTES_PER_MS
        while (pcm.size - start > maxBytes) {
            val hardEnd = start + maxBytes
            var cut = hardEnd
            var quietest = Double.MAX_VALUE
            var at = hardEnd - SEARCH_MS * BYTES_PER_MS
            while (at < hardEnd) {
                val l = Recorder.level(pcm, at, step)
                if (l < quietest) {
                    quietest = l
                    cut = at
                }
                at += step
            }
            parts.add(start to cut)
            start = cut
        }
        parts.add(start to pcm.size)
        return parts
    }

    private fun wav(pcm: ByteArray, start: Int, end: Int): ByteArray {
        val n = end - start
        val h = ByteBuffer.allocate(44 + n).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + n).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
        h.putInt(Recorder.SAMPLE_RATE).putInt(Recorder.SAMPLE_RATE * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(n)
        h.put(pcm, start, n)
        return h.array()
    }
}
