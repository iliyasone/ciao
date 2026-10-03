package dev.iliyasone.ciao

import android.content.Context

/** Settings, with the same defaults as the desktop app (src/main/settings.ts). */
class Prefs(context: Context) {
    private val sp = context.getSharedPreferences("ciao", Context.MODE_PRIVATE)

    var apiKey: String
        get() = sp.getString("apiKey", "")!!.trim()
        set(v) = sp.edit().putString("apiKey", v.trim()).apply()

    val liveModel: String get() = "gpt-live-transcribe"
    val fileModel: String get() = "gpt-transcribe"
    val delay: String get() = "low"
    val languages: List<String> get() = listOf("ru", "en")

    var prompt: String
        get() = sp.getString("prompt", DEFAULT_PROMPT)!!
        set(v) = sp.edit().putString("prompt", v).apply()

    var keywords: List<String>
        get() = (sp.getString("keywords", null)?.split(",") ?: DEFAULT_KEYWORDS).map { it.trim() }.filter { it.isNotEmpty() }
        set(v) = sp.edit().putString("keywords", v.joinToString(", ")).apply()

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
