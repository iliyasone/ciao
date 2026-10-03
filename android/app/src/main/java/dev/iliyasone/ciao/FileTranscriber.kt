package dev.iliyasone.ciao

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Transcribes a whole recording with the (more accurate, cheaper) file model: the fallback when the
 * live connection dropped. Mirrors transcribeFile in src/main/transcribe.ts.
 */
object FileTranscriber {
    // The endpoint takes up to 25 MB, i.e. ~8.5 min of 24 kHz PCM16. Longer recordings are split at
    // the quietest moment near each boundary so no word is cut in half.
    private const val MAX_PART_MS = 8 * 60_000
    private const val SEARCH_MS = 10_000
    private const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000

    /** Blocking; call off the main thread. */
    fun transcribe(context: Context, prefs: Prefs, pcm: ByteArray): String {
        val texts = mutableListOf<String>()
        val hints = listOf(prefs.prompt.trim(), if (prefs.keywords.isNotEmpty()) "Термины: ${prefs.keywords.joinToString(", ")}." else "")
            .filter { it.isNotEmpty() }.joinToString(" ")
        for ((start, end) in split(pcm)) {
            // Continuity across parts.
            val prompt = if (texts.isEmpty()) hints else "$hints ${texts.last().takeLast(400)}".trim()
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", "audio.wav", wav(pcm, start, end).toRequestBody("audio/wav".toMediaType()))
                .addFormDataPart("model", prefs.fileModel)
                .apply {
                    prefs.languages.firstOrNull()?.let { addFormDataPart("language", it) }
                    if (prompt.isNotEmpty()) addFormDataPart("prompt", prompt)
                }
                .build()
            val request = Request.Builder()
                .url("https://api.openai.com/v1/audio/transcriptions")
                .header("Authorization", "Bearer ${prefs.apiKey}")
                .post(body)
                .build()
            val response = try {
                http.newCall(request).execute()
            } catch (e: IOException) {
                throw IOException(context.getString(R.string.error_cannot_reach), e)
            }
            response.use {
                val json = runCatching { JSONObject(it.body!!.string()) }.getOrDefault(JSONObject())
                if (!it.isSuccessful) {
                    throw IOException(json.optJSONObject("error")?.optString("message")?.takeIf { m -> m.isNotEmpty() } ?: context.getString(R.string.error_status, it.code))
                }
                texts.add(json.optString("text").trim())
            }
        }
        return texts.filter { it.isNotEmpty() }.joinToString(" ")
    }

    private fun split(pcm: ByteArray): List<Pair<Int, Int>> {
        val parts = mutableListOf<Pair<Int, Int>>()
        var start = 0
        val maxBytes = MAX_PART_MS * BYTES_PER_MS
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
