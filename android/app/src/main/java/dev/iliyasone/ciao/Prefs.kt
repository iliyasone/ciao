package dev.iliyasone.ciao

import android.content.Context

/**
 * Who transcribes; as PROVIDERS in src/core/providers.ts. [id] is what the desktop calls it (the
 * synced keys use it too). [maxSpareAgeMs]: how long a connected spare socket stays worth using.
 */
enum class Provider(val id: String, val displayName: String, val liveModel: String, val fileModel: String, val pricePerMinute: Double, val maxSpareAgeMs: Long) {
    OPENAI("openai", "OpenAI", "gpt-live-transcribe", "gpt-transcribe", 0.017, 10 * 60_000L),
    // Google drops a socket that has waited ~5 min without a setup, and a live session lasts at most 10 min.
    GEMINI("gemini", "Gemini", "gemini-3.5-transcribe-live", "gemini-3.5-transcribe", 0.009, 2 * 60_000L),
}

/** Settings, with the same defaults as the desktop app (src/main/settings.ts). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ciao", Context.MODE_PRIVATE)

    var apiKey: String
        // Only printable ASCII: a stray zero-width space or line break from a copy would make every
        // request header invalid (OkHttp throws on it).
        get() = sp.getString("apiKey", "")!!.filter { it in '!'..'~' }
        set(v) = sp.edit().putString("apiKey", v).apply()

    var geminiKey: String
        get() = sp.getString("geminiKey", "")!!.filter { it in '!'..'~' }
        set(v) = sp.edit().putString("geminiKey", v).apply()

    /** With Google sync: the API keys go into the synced file too (Sync.kt). */
    var syncKeys: Boolean
        get() = sp.getBoolean("syncKeys", true)
        set(v) = sp.edit().putBoolean("syncKeys", v).apply()

    /** What GoogleSync compares with its history. */
    fun local() = Local(keywords, prompt, mapOf("openai" to apiKey, "gemini" to geminiKey), syncKeys)

    /** Not synced, as on the desktop: each device picks its own. */
    var provider: Provider
        get() = Provider.entries.firstOrNull { it.id == sp.getString("provider", null) } ?: Provider.OPENAI
        set(v) = sp.edit().putString("provider", v.id).apply()

    fun keyOf(p: Provider): String = if (p == Provider.GEMINI) geminiKey else apiKey

    /** The key of the service in use. */
    val currentKey: String get() = keyOf(provider)

    /** Gemini's smart mode: drops fillers and false starts, applies spoken corrections. */
    var smart: Boolean
        get() = sp.getBoolean("smart", true)
        set(v) = sp.edit().putBoolean("smart", v).apply()

    val liveModel: String get() = provider.liveModel
    val fileModel: String get() = provider.fileModel
    /** OpenAI's recognizer delay; shown only with [showDelay], as on the desktop. */
    var delay: String
        get() = sp.getString("delay", "low")!!.takeIf { it in DELAYS } ?: "low"
        set(v) = sp.edit().putString("delay", v).apply()

    var showDelay: Boolean
        get() = sp.getBoolean("showDelay", false)
        set(v) = sp.edit().putBoolean("showDelay", v).apply()

    /** OpenAI only; Gemini detects the language itself. */
    var languages: List<String>
        get() = (sp.getString("languages", null)?.split(",") ?: listOf("ru", "en")).map { it.trim().lowercase() }.filter { it.isNotEmpty() }
        set(v) = sp.edit().putString("languages", v.joinToString(",")).apply()

    /** Off: the text only goes to the clipboard. */
    var autoPaste: Boolean
        get() = sp.getBoolean("autoPaste", true)
        set(v) = sp.edit().putBoolean("autoPaste", v).apply()

    /** After a paste, put back what was on the clipboard. */
    var restoreClipboard: Boolean
        get() = sp.getBoolean("restoreClipboard", true)
        set(v) = sp.edit().putBoolean("restoreClipboard", v).apply()

    /** Anonymous usage counts (Telemetry.kt). */
    var telemetry: Boolean
        get() = sp.getBoolean("telemetry", true)
        set(v) = sp.edit().putBoolean("telemetry", v).apply()

    /** A random UUID made on first use; it says nothing about the phone or the person. */
    var telemetryId: String
        get() = sp.getString("telemetryId", "")!!
        set(v) = sp.edit().putString("telemetryId", v).apply()

    /** "system", "light" or "dark". */
    var theme: String
        get() = sp.getString("theme", "system")!!
        set(v) = sp.edit().putString("theme", v).apply()

    /** "system", "ru" or "en". */
    var language: String
        get() = sp.getString("language", "system")!!
        set(v) = sp.edit().putString("language", v).apply()

    /** The text of the last dictation, for "Paste last" (PasteLastTile). */
    var lastText: String
        get() = sp.getString("lastText", "")!!
        set(v) = sp.edit().putString("lastText", v).apply()

    var prompt: String
        get() = sp.getString("prompt", DEFAULT_PROMPT)!!
        set(v) = sp.edit().putString("prompt", v).apply()

    /** One per line, like on the desktop: a synced term may contain a comma. */
    var keywords: List<String>
        get() = (sp.getString("terms", null)?.split("\n") ?: sp.getString("keywords", null)?.split(",") ?: DEFAULT_KEYWORDS)
            .map { it.trim() }.filter { it.isNotEmpty() }
        set(v) = sp.edit().putString("terms", v.joinToString("\n")).remove("keywords").apply()

    /** Google account terms and the prompt sync through (GoogleSync); empty when signed out. */
    var googleEmail: String
        get() = sp.getString("googleEmail", "")!!
        set(v) = sp.edit().putString("googleEmail", v).apply()

    /** When Updater last asked GitHub for a newer version. */
    var updateCheckedAt: Long
        get() = sp.getLong("updateCheckedAt", 0)
        set(v) = sp.edit().putLong("updateCheckedAt", v).apply()

    /** Sent to "Install unknown apps" to allow an update: carry on with it once back. */
    var updateAfterPermission: Boolean
        get() = sp.getBoolean("updateAfterPermission", false)
        set(v) = sp.edit().putBoolean("updateAfterPermission", v).apply()

    var syncedAt: Long
        get() = sp.getLong("syncedAt", 0)
        set(v) = sp.edit().putLong("syncedAt", v).apply()

    /** Every term change this device knows, as in the synced file (Sync.serialize); empty before the first edit. */
    var syncState: String
        get() = sp.getString("syncState", "")!!
        set(v) = sp.edit().putString("syncState", v).apply()

    var formatText: Boolean
        get() = sp.getBoolean("formatText", true)
        set(v) = sp.edit().putBoolean("formatText", v).apply()

    var stopPhrase: Boolean
        get() = sp.getBoolean("stopPhrase", true)
        set(v) = sp.edit().putBoolean("stopPhrase", v).apply()

    var showCost: Boolean
        get() = sp.getBoolean("showCost", true)
        set(v) = sp.edit().putBoolean("showCost", v).apply()

    /** Which screen edge the bubble sits at, and how far above the keyboard (px). Set by dragging it. */
    var bubbleLeft: Boolean
        get() = sp.getBoolean("bubbleLeft", false)
        set(v) = sp.edit().putBoolean("bubbleLeft", v).apply()

    var bubbleLift: Int
        get() = sp.getInt("bubbleLift", -1)
        set(v) = sp.edit().putInt("bubbleLift", v).apply()

    companion object {
        val DELAYS = listOf("minimal", "low", "medium", "high", "xhigh")
        const val DEFAULT_PROMPT =
            "Диктовка промптов для ИИ-агентов программирования. Русская речь с английскими техническими терминами, названиями библиотек, файлов и команд."
        val DEFAULT_KEYWORDS = listOf(
            "T3 Code", "Claude", "Claude Code", "Codex", "OpenAI", "GitHub", "WebSocket", "API", "JSON",
            "TypeScript", "Python", "Electron", "React", "commit", "pull request", "Wispr Flow", "Android",
        )
    }
}
