package dev.iliyasone.ciao

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Every dictation in its own folder, as on the desktop (src/main/history.ts):
 * history/<id>/{audio.pcm, entry.json}. The audio is written there as it is recorded, so nothing
 * said is lost if the app, the network or the service fails; a failed dictation stays for a retry.
 */
class History(private val dir: File) {
    enum class Status { RECORDING, DONE, FAILED, CANCELLED }

    /** Where the text went, as on the desktop: typed into the field, left on the clipboard, or nowhere. */
    enum class Delivery { PASTED, CLIPBOARD, NONE }

    /** How a text came about: [Source.LIVE] while speaking, the others from History's buttons; as TranscriptSource in src/core/types.ts. */
    enum class Source(val id: String) { LIVE("live"), RETRY_LIVE("retry-live"), RETRY_FILE("retry-file"), FORMATTED("formatted") }

    data class Transcript(val source: Source, val model: String, val text: String, val createdAt: Long)

    data class Entry(
        val id: String,
        val createdAt: Long,
        val durationMs: Long = 0,
        val status: Status = Status.RECORDING,
        val provider: Provider = Provider.OPENAI,
        /** Oldest first; the last one is the text. */
        val transcripts: List<Transcript> = emptyList(),
        val delivery: Delivery = Delivery.NONE,
        /** Why the last attempt failed. */
        val error: String? = null,
    ) {
        val text: String get() = transcripts.lastOrNull()?.text ?: ""

        fun plus(t: Transcript) = copy(transcripts = transcripts + t, status = Status.DONE, error = null)
    }

    init {
        dir.mkdirs()
    }

    fun audioFile(id: String) = File(File(dir, id), "audio.pcm")

    fun create(provider: Provider, now: Long = System.currentTimeMillis()): Entry {
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(now))
        val id = "$stamp-${(1..4).map { ALPHABET.random() }.joinToString("")}"
        File(dir, id).mkdirs()
        return Entry(id, now, provider = provider).also { save(it) }
    }

    fun save(e: Entry) {
        val target = File(File(dir, e.id), "entry.json")
        if (!target.parentFile!!.isDirectory) return // deleted meanwhile
        val transcripts = JSONArray()
        for (t in e.transcripts) transcripts.put(JSONObject().put("source", t.source.id).put("model", t.model).put("text", t.text).put("createdAt", t.createdAt))
        val json = JSONObject()
            .put("id", e.id)
            .put("createdAt", e.createdAt)
            .put("durationMs", e.durationMs)
            .put("status", e.status.name.lowercase())
            .put("provider", e.provider.id)
            .put("transcripts", transcripts)
            .put("delivery", e.delivery.name.lowercase())
        if (e.error != null) json.put("error", e.error)
        val tmp = File(target.path + ".tmp")
        tmp.writeText(json.toString())
        tmp.renameTo(target) // atomic: a crash never leaves a half-written entry
    }

    fun get(id: String): Entry? = runCatching {
        val o = JSONObject(File(File(dir, id), "entry.json").readText())
        val provider = Provider.entries.firstOrNull { it.id == o.optString("provider") } ?: Provider.OPENAI
        val createdAt = o.getLong("createdAt")
        val list = o.optJSONArray("transcripts")
        val transcripts = if (list != null) {
            (0 until list.length()).map { list.getJSONObject(it) }.map { t ->
                Transcript(Source.entries.firstOrNull { it.id == t.optString("source") } ?: Source.LIVE, t.optString("model"), t.optString("text"), t.optLong("createdAt"))
            }
        } else {
            // Ciao 0.8.3 kept one "text": it came from the live model or its file fallback.
            o.optString("text").takeIf { it.isNotEmpty() }?.let { listOf(Transcript(Source.LIVE, provider.liveModel, it, createdAt)) } ?: emptyList()
        }
        Entry(
            id = o.getString("id"),
            createdAt = createdAt,
            durationMs = o.optLong("durationMs"),
            status = Status.entries.firstOrNull { it.name.equals(o.optString("status"), true) } ?: Status.FAILED,
            provider = provider,
            transcripts = transcripts,
            // 0.8.3 didn't say; a text it had was inserted or copied, which of the two is unknown.
            delivery = Delivery.entries.firstOrNull { it.name.equals(o.optString("delivery"), true) } ?: Delivery.NONE,
            error = o.optString("error").takeIf { it.isNotEmpty() },
        )
    }.getOrNull()

    /** Newest first. */
    fun list(): List<Entry> = (dir.list()?.toList() ?: emptyList()).mapNotNull { get(it) }.sortedByDescending { it.createdAt }

    fun delete(id: String) {
        File(dir, id).deleteRecursively()
    }

    /** Entries left mid-recording by a crash or a kill: mark them failed, so they can be transcribed again. */
    fun recover(): List<Entry> = list().filter { it.status == Status.RECORDING }.map { e ->
        val ms = audioFile(e.id).length() / BYTES_PER_MS
        e.copy(status = Status.FAILED, durationMs = ms).also { save(it) }
    }

    /** Recordings take ~2.9 MB a minute: keep the audio of the newest [keepAudio] entries only (the text stays). */
    fun trim(keepAudio: Int = KEEP_AUDIO) {
        list().drop(keepAudio).filter { it.status == Status.DONE }.forEach { audioFile(it.id).delete() }
    }

    companion object {
        const val KEEP_AUDIO = 200
        private const val BYTES_PER_MS = Recorder.SAMPLE_RATE * 2 / 1000
        private const val ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789"
    }
}
