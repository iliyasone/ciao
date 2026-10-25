package dev.iliyasone.ciao

import java.time.Instant
import java.time.ZoneId

/**
 * What dictation costs over a period, as summarizeUsage in src/core/usage.ts: totals, a column per
 * day (per hour for the last 24 hours) split by provider, and every model's share. UsageTest holds
 * that file's outputs.
 */
object Usage {
    /** Days back from now; [ALL] starts at the first dictation. */
    const val ALL = 0
    val WINDOWS = listOf(1, 7, 30, 90, ALL)

    /** As OPENAI/GEMINI in [Provider], plus "other" for the rest (none so far costs anything). */
    val PROVIDERS = listOf("openai", "gemini", "other")

    data class Paid(val model: String, val costUsd: Double)
    data class Entry(val createdAt: Long, val durationMs: Long, val transcripts: List<Paid>)

    class Totals {
        var count = 0
        var ms = 0L
        var usd = 0.0
    }

    class Column(val start: Long) {
        val total = Totals()
        val byProvider = PROVIDERS.associateWith { Totals() }
    }

    class Model(val model: String, val provider: String) {
        val totals = Totals()
    }

    class Summary(
        /** The first moment counted; with [ALL], the first dictation (now when there is none). */
        val from: Long,
        val hourly: Boolean,
        val total: Totals,
        /** Days with a dictation, for the average per day. */
        val activeDays: Int,
        val columns: List<Column>,
        /** Paid models only, the most expensive first. */
        val models: List<Model>,
    )

    /** List prices per minute of audio; as PER_MINUTE_USD in src/core/cost.ts. */
    private val PER_MINUTE_USD = mapOf(
        "gpt-live-transcribe" to 0.017,
        "gpt-realtime-whisper" to 0.017,
        "gpt-transcribe" to 0.0045,
        "gemini-3.5-transcribe-live" to 0.009,
        "gemini-3.5-transcribe" to 0.005,
    )

    fun pricePerMinute(model: String) = PER_MINUTE_USD[model] ?: 0.017

    /**
     * An entry of History as the desktop keeps it: each transcript costs its model's price for the
     * whole recording (src/main/dictation.ts), the rules-made layout nothing.
     */
    fun of(e: History.Entry) = Entry(
        e.createdAt,
        e.durationMs,
        e.transcripts.map { t -> Paid(t.model, if (t.source == History.Source.FORMATTED) 0.0 else pricePerMinute(t.model) * e.durationMs / 60_000) },
    )

    fun providerOf(model: String) = when {
        model.startsWith("gpt-") -> "openai"
        model.startsWith("gemini-") -> "gemini"
        else -> "other"
    }

    private const val HOUR = 3_600_000L

    /** Where midnight comes twice (the clocks go back at 01:00), the first one, as JavaScript's Date. */
    private fun startOfDay(at: Long): Long {
        val zone = ZoneId.systemDefault()
        return Instant.ofEpochMilli(at).atZone(zone).toLocalDate().atStartOfDay(zone).toInstant().toEpochMilli()
    }

    /**
     * The start of the next local day. A day around a clock change is 23 or 25 hours long, and where the
     * clocks change at midnight a day starts at 01:00: 26 hours on always lands within the next day.
     */
    private fun nextDay(day: Long) = startOfDay(day + 26 * HOUR)

    /**
     * A dictation counts once, with all its minutes, for the provider of its first paid transcript (the
     * live one, as a rule); its cost is every transcript's, each for its own model's provider.
     */
    fun summarize(entries: List<Entry>, window: Int, now: Long): Summary {
        val hourly = window == 1
        val from = when (window) {
            1 -> now - 24 * HOUR
            ALL -> startOfDay(entries.minOfOrNull { it.createdAt }?.coerceAtMost(now) ?: now)
            else -> (1 until window).fold(startOfDay(now)) { day, _ -> startOfDay(day - 12 * HOUR) }
        }
        // By the hour, the first column is the hour [from] falls in: 25 columns, the first and last partial.
        val columns = mutableListOf<Column>()
        var at = if (hourly) Math.floorDiv(from, HOUR) * HOUR else from
        while (at <= now) {
            columns += Column(at)
            at = if (hourly) at + HOUR else nextDay(at)
        }

        val total = Totals()
        val models = linkedMapOf<String, Model>()
        val days = mutableSetOf<Long>()
        for (e in entries) {
            if (e.createdAt < from || e.createdAt > now) continue
            val column = columns.last { it.start <= e.createdAt }
            val paid = e.transcripts.filter { it.costUsd > 0 }
            val owner = paid.firstOrNull()?.let { providerOf(it.model) } ?: "other"
            for (t in listOf(total, column.total, column.byProvider.getValue(owner))) {
                t.count++
                t.ms += e.durationMs
            }
            for (t in paid) {
                total.usd += t.costUsd
                column.total.usd += t.costUsd
                column.byProvider.getValue(providerOf(t.model)).usd += t.costUsd
            }
            // Per model, a dictation counts once for each model that transcribed it.
            for (model in paid.map { it.model }.distinct()) {
                val m = models.getOrPut(model) { Model(model, providerOf(model)) }
                m.totals.count++
                m.totals.ms += e.durationMs
                m.totals.usd += paid.filter { it.model == model }.sumOf { it.costUsd }
            }
            days += startOfDay(e.createdAt)
        }
        return Summary(
            from, hourly, total, days.size, columns,
            models.values.sortedWith(compareByDescending<Model> { it.totals.usd }.thenBy { it.model }),
        )
    }
}
