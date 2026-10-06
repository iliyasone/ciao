package dev.iliyasone.ciao

import android.content.Context

/** Settings, with the same defaults as the desktop app (src/main/settings.ts). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ciao", Context.MODE_PRIVATE)

    var apiKey: String
        // Only printable ASCII: a stray zero-width space or line break from a copy would make every
        // request header invalid (OkHttp throws on it).
        get() = sp.getString("apiKey", "")!!.filter { it in '!'..'~' }
        set(v) = sp.edit().putString("apiKey", v).apply()

    val liveModel: String get() = "gpt-live-transcribe"
    val fileModel: String get() = "gpt-transcribe"
    val delay: String get() = "low"
    val languages: List<String> get() = listOf("ru", "en")

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
        const val DEFAULT_PROMPT =
            "Диктовка промптов для ИИ-агентов программирования. Русская речь с английскими техническими терминами, названиями библиотек, файлов и команд."
        val DEFAULT_KEYWORDS = listOf(
            "T3 Code", "Claude", "Claude Code", "Codex", "OpenAI", "GitHub", "WebSocket", "API", "JSON",
            "TypeScript", "Python", "Electron", "React", "commit", "pull request", "Wispr Flow", "Android",
        )
    }
}
