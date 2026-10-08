package dev.iliyasone.ciao

import android.content.Context
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Anonymous usage counts, the desktop's two events (src/main/telemetry.ts, README → Telemetry):
 * app_started and dictation. A random install id and facts about how things went; never text,
 * audio, app names or API keys. Off with the switch in Settings.
 */
object Telemetry {
    // A PostHog project key is public by design: it can only send events, not read them.
    private const val KEY = "phc_v7UzA6jJYZNZa7e2RPbQJspyqUfQ6vAWmuLJCQ4hr2rV"
    private const val URL = "https://eu.i.posthog.com/batch/"
    private const val MAX_QUEUED = 200

    private val queue = mutableListOf<JSONObject>()
    private val sender = Executors.newSingleThreadExecutor()

    fun capture(context: Context, event: String, properties: Map<String, Any?> = emptyMap()) {
        val prefs = Prefs(context)
        if (!prefs.telemetry) return
        val props = JSONObject()
            .put("\$lib", "ciao")
            .put("app_version", runCatching { context.packageManager.getPackageInfo(context.packageName, 0).versionName }.getOrNull())
            .put("os", "android")
            .put("os_version", Build.VERSION.RELEASE)
            .put("arch", Build.SUPPORTED_ABIS.firstOrNull())
            // Counts only: no person profiles, one anonymous id per install, no location from the IP.
            .put("\$process_person_profile", false)
            .put("\$geoip_disable", true)
        for ((k, v) in properties) if (v != null) props.put(k, v)
        val stamp = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date())
        val e = JSONObject()
            .put("uuid", UUID.randomUUID().toString())
            .put("event", event)
            .put("timestamp", stamp)
            .put("distinct_id", installId(prefs))
            .put("properties", props)
        synchronized(queue) {
            queue.add(e)
            if (queue.size > MAX_QUEUED) queue.subList(0, queue.size - MAX_QUEUED).clear()
        }
        sender.execute { flush(context) }
    }

    private fun flush(context: Context) {
        if (!Prefs(context).telemetry) {
            synchronized(queue) { queue.clear() }
            return
        }
        val batch = synchronized(queue) { queue.toList().also { queue.clear() } }
        if (batch.isEmpty()) return
        val body = JSONObject().put("api_key", KEY).put("batch", JSONArray(batch)).toString()
        val ok = runCatching {
            http.newCall(Request.Builder().url(URL).post(body.toRequestBody("application/json".toMediaType())).build()).execute().use { r ->
                // A 4xx other than 429 won't get better on retry: drop the batch.
                r.isSuccessful || (r.code in 400..499 && r.code != 429)
            }
        }.getOrDefault(false)
        // Offline or the server busy: keep them for the next event.
        if (!ok) synchronized(queue) {
            queue.addAll(0, batch)
            if (queue.size > MAX_QUEUED) queue.subList(0, queue.size - MAX_QUEUED).clear()
        }
    }

    private fun installId(prefs: Prefs): String = prefs.telemetryId.ifEmpty { UUID.randomUUID().toString().also { prefs.telemetryId = it } }
}
