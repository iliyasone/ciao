package dev.iliyasone.ciao

import android.content.Context
import android.util.Base64
import android.util.Base64OutputStream
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Transcribes a whole recording with the (more accurate, cheaper) file model of the service in use:
 * the fallback when the live connection dropped. Mirrors transcribeFile in src/main/transcribe.ts.
 * The audio is read from its file while it is sent, never held whole: an hour is ~170 MB.
 */
object FileTranscriber {
    // The endpoint takes up to 25 MB, i.e. ~8.5 min of 24 kHz PCM16. Longer recordings are split at
    // the quietest moment near each boundary so no word is cut in half.
    // Gemini takes the audio inline as base64 in a JSON body; 4 min is ~15 MB of it.
    private const val MAX_PART_MS = 8 * 60_000
    private const val GEMINI_MAX_PART_MS = 4 * 60_000
    private const val SEARCH_MS = 10_000
    private const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000
    private const val WAV_HEADER = 44
    /** Stands for the audio in Gemini's JSON until it is sent. */
    private const val DATA = "@ciao-audio@"

    /**
     * Blocking; call off the main thread. [provider] and [smart] are the dictation's own, as when it
     * started; [key] is that provider's current key (a retry after fixing a bad key must use the new one).
     */
    fun transcribe(context: Context, prefs: Prefs, audio: File, provider: Provider, key: String, smart: Boolean): String {
        if (provider == Provider.GEMINI) return transcribeGemini(context, prefs, audio, key, smart)
        val texts = mutableListOf<String>()
        val hints = listOf(prefs.prompt.trim(), if (prefs.keywords.isNotEmpty()) "Термины: ${prefs.keywords.joinToString(", ")}." else "")
            .filter { it.isNotEmpty() }.joinToString(" ")
        for ((start, end) in split(audio, MAX_PART_MS)) {
            // Continuity across parts.
            val prompt = if (texts.isEmpty()) hints else "$hints ${texts.last().takeLast(400)}".trim()
            val wav = object : RequestBody() {
                override fun contentType() = "audio/wav".toMediaType()
                override fun contentLength() = WAV_HEADER + end - start
                override fun writeTo(sink: BufferedSink) = writeWav(audio, start, end, sink.outputStream())
            }
            val body = MultipartBody.Builder().setType(MultipartBody.FORM)
                .addFormDataPart("file", "audio.wav", wav)
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
    private fun transcribeGemini(context: Context, prefs: Prefs, audio: File, key: String, smart: Boolean): String {
        val config = JSONObject()
        if (smart) config.put("mode", "smart")
        val terms = geminiVocabulary(prefs.keywords)
        if (terms.isNotEmpty()) config.put("custom_vocabulary", JSONArray(terms))
        val texts = mutableListOf<String>()
        for ((start, end) in split(audio, GEMINI_MAX_PART_MS)) {
            val part = JSONObject().put("type", "audio").put("mime_type", "audio/wav").put("data", DATA)
            val json = JSONObject()
                .put("model", Provider.GEMINI.fileModel)
                // Interactions are kept on Google's side by default; recordings stay on this phone.
                .put("store", false)
                .put("input", JSONArray().put(part))
            if (config.length() > 0) json.put("generation_config", JSONObject().put("transcription_config", config))
            // The audio goes in as base64 inside the JSON: written in place of DATA as it is read.
            val text = json.toString()
            val head = text.substringBefore(DATA).toByteArray()
            val tail = text.substringAfter(DATA).toByteArray()
            val body = object : RequestBody() {
                override fun contentType() = "application/json".toMediaType()
                override fun contentLength() = head.size + (WAV_HEADER + end - start + 2) / 3 * 4 + tail.size
                override fun writeTo(sink: BufferedSink) {
                    sink.write(head)
                    val base64 = Base64OutputStream(sink.outputStream(), Base64.NO_WRAP or Base64.NO_CLOSE)
                    writeWav(audio, start, end, base64)
                    base64.close()
                    sink.write(tail)
                }
            }
            val request = Request.Builder()
                .url("https://generativelanguage.googleapis.com/v1beta/interactions")
                .header("x-goog-api-key", key)
                .post(body)
                .build()
            // Tier 1 takes 10,000 audio tokens (~6.5 min) a minute, so the parts of a long recording run
            // into the limit; the error says when to come back ("Please retry in 8s").
            var attempt = 0
            while (true) {
                val response = try {
                    http.newCall(request).execute()
                } catch (e: IOException) {
                    throw IOException(context.getString(R.string.error_cannot_reach, GeminiSession.NAME), e)
                }
                if (response.code == 429 && attempt++ < 2) {
                    val message = response.use { it.body?.string() ?: "" }
                    val wait = Regex("""retry in ([\d.]+)\s*s""", RegexOption.IGNORE_CASE).find(message)?.groupValues?.get(1)?.toDoubleOrNull() ?: 20.0
                    Thread.sleep((minOf(wait + 1, 60.0) * 1000).toLong())
                    continue
                }
                response.use {
                    val raw = it.body?.string() ?: ""
                    // Errors come wrapped in an array here, unlike on :generateContent.
                    val first = runCatching { JSONObject(raw) }.getOrNull() ?: runCatching { JSONArray(raw).getJSONObject(0) }.getOrNull() ?: JSONObject()
                    val error = first.optJSONObject("error")?.optString("message")?.takeIf { m -> m.isNotEmpty() }
                    if (!it.isSuccessful) throw IOException(error ?: context.getString(R.string.error_status, GeminiSession.NAME, it.code))
                    val status = first.optString("status")
                    if (status != "completed") throw IOException(error ?: context.getString(R.string.error_status_text, GeminiSession.NAME, status.ifEmpty { it.code.toString() }))
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
                break
            }
        }
        return texts.filter { it.isNotEmpty() }.joinToString(" ")
    }

    /** Parts of at most [maxPartMs], as byte ranges of [audio], each cut at the quietest 100 ms before its end. */
    private fun split(audio: File, maxPartMs: Int): List<Pair<Long, Long>> {
        val parts = mutableListOf<Pair<Long, Long>>()
        val size = audio.length()
        var start = 0L
        val maxBytes = maxPartMs.toLong() * BYTES_PER_MS
        val step = 100 * BYTES_PER_MS
        val window = ByteArray(SEARCH_MS * BYTES_PER_MS)
        RandomAccessFile(audio, "r").use { file ->
            while (size - start > maxBytes) {
                val hardEnd = start + maxBytes
                val from = hardEnd - window.size
                file.seek(from)
                file.readFully(window)
                var cut = hardEnd
                var quietest = Double.MAX_VALUE
                var at = 0
                while (at < window.size) {
                    val l = Recorder.level(window, at, step)
                    if (l < quietest) {
                        quietest = l
                        cut = from + at
                    }
                    at += step
                }
                parts.add(start to cut)
                start = cut
            }
        }
        parts.add(start to size)
        return parts
    }

    /** [audio]'s bytes [start, end) as a WAV file, into [out] a piece at a time. */
    private fun writeWav(audio: File, start: Long, end: Long, out: OutputStream) {
        val n = (end - start).toInt()
        val h = ByteBuffer.allocate(WAV_HEADER).order(ByteOrder.LITTLE_ENDIAN)
        h.put("RIFF".toByteArray()).putInt(36 + n).put("WAVE".toByteArray())
        h.put("fmt ".toByteArray()).putInt(16).putShort(1).putShort(1)
        h.putInt(Recorder.SAMPLE_RATE).putInt(Recorder.SAMPLE_RATE * 2).putShort(2).putShort(16)
        h.put("data".toByteArray()).putInt(n)
        out.write(h.array())
        RandomAccessFile(audio, "r").use { file ->
            file.seek(start)
            val buf = ByteArray(64 * 1024)
            var left = n
            while (left > 0) {
                val got = file.read(buf, 0, minOf(buf.size, left))
                if (got < 0) throw IOException("${audio.name} is shorter than expected")
                out.write(buf, 0, got)
                left -= got
            }
        }
    }
}
