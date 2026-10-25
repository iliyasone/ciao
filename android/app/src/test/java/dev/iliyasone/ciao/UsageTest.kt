package dev.iliyasone.ciao

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import java.time.Instant
import java.util.TimeZone

/** The outputs of summarizeUsage (src/core/usage.ts) for the same entries, run with TZ=UTC. */
class UsageTest {
    private val saved = TimeZone.getDefault()

    @Before
    fun utc() = TimeZone.setDefault(TimeZone.getTimeZone("UTC"))

    @After
    fun restore() = TimeZone.setDefault(saved)

    private fun at(s: String) = Instant.parse(s).toEpochMilli()
    private fun paid(model: String, usd: Double) = Usage.Paid(model, usd)

    private val entries = listOf(
        Usage.Entry(at("2026-10-20T08:15:00Z"), 60_000, listOf(paid("gpt-live-transcribe", 0.017))),
        Usage.Entry(at("2026-10-20T09:40:00Z"), 120_000, listOf(paid("gemini-3.5-transcribe-live", 0.018), paid("gemini-3.5-transcribe", 0.01), paid("rules", 0.0))),
        Usage.Entry(at("2026-10-22T23:59:00Z"), 30_000, emptyList()),
        // 23 h 45 min before now: within the last 24 hours.
        Usage.Entry(at("2026-10-24T04:45:00Z"), 20_000, listOf(paid("gpt-live-transcribe", 0.005))),
        Usage.Entry(at("2026-10-24T22:30:00Z"), 90_000, listOf(paid("gemini-3.5-transcribe-live", 0.0135))),
        Usage.Entry(at("2026-10-25T03:10:00Z"), 45_000, listOf(paid("gpt-live-transcribe", 0.01275), paid("gpt-transcribe", 0.003375))),
        Usage.Entry(at("2026-09-01T12:00:00Z"), 600_000, listOf(paid("gpt-live-transcribe", 0.17))),
    )
    private val now = at("2026-10-25T04:30:00Z")

    private fun r(x: Double) = Math.round(x * 1e6) / 1e6

    private fun columns(s: Usage.Summary) = s.columns.filter { it.total.count > 0 }.map {
        listOf(it.start, it.total.count, it.total.ms, r(it.total.usd), r(it.byProvider.getValue("openai").usd), r(it.byProvider.getValue("gemini").usd), it.byProvider.getValue("other").count)
    }

    private fun models(s: Usage.Summary) = s.models.map { listOf(it.model, it.provider, it.totals.count, it.totals.ms, r(it.totals.usd)) }

    @Test
    fun lastDayByHour() {
        val s = Usage.summarize(entries, 1, now)
        assertEquals(1792816200000L, s.from)
        assertEquals(true, s.hourly)
        assertEquals(25, s.columns.size)
        assertEquals(1792814400000L, s.columns.first().start)
        assertEquals(listOf(3, 155000L, 0.034625), listOf(s.total.count, s.total.ms, r(s.total.usd)))
        assertEquals(2, s.activeDays)
        assertEquals(
            listOf(
                listOf(1792814400000L, 1, 20000L, 0.005, 0.005, 0.0, 0),
                listOf(1792879200000L, 1, 90000L, 0.0135, 0.0, 0.0135, 0),
                listOf(1792897200000L, 1, 45000L, 0.016125, 0.016125, 0.0, 0),
            ),
            columns(s),
        )
        assertEquals(
            listOf(listOf("gpt-live-transcribe", "openai", 2, 65000L, 0.01775), listOf("gemini-3.5-transcribe-live", "gemini", 1, 90000L, 0.0135), listOf("gpt-transcribe", "openai", 1, 45000L, 0.003375)),
            models(s),
        )
    }

    @Test
    fun weekByDay() {
        val s = Usage.summarize(entries, 7, now)
        assertEquals(1792368000000L, s.from)
        assertEquals(7, s.columns.size)
        assertEquals(listOf(6, 365000L, 0.079625), listOf(s.total.count, s.total.ms, r(s.total.usd)))
        assertEquals(4, s.activeDays)
        assertEquals(
            listOf(
                listOf(1792454400000L, 2, 180000L, 0.045, 0.017, 0.028, 0),
                listOf(1792627200000L, 1, 30000L, 0.0, 0.0, 0.0, 1),
                listOf(1792800000000L, 2, 110000L, 0.0185, 0.005, 0.0135, 0),
                listOf(1792886400000L, 1, 45000L, 0.016125, 0.016125, 0.0, 0),
            ),
            columns(s),
        )
        assertEquals(
            listOf(
                listOf("gpt-live-transcribe", "openai", 3, 125000L, 0.03475),
                listOf("gemini-3.5-transcribe-live", "gemini", 2, 210000L, 0.0315),
                listOf("gemini-3.5-transcribe", "gemini", 1, 120000L, 0.01),
                listOf("gpt-transcribe", "openai", 1, 45000L, 0.003375),
            ),
            models(s),
        )
    }

    @Test
    fun allTimeFromTheFirstDictation() {
        val s = Usage.summarize(entries, Usage.ALL, now)
        assertEquals(1788220800000L, s.from)
        assertEquals(55, s.columns.size)
        assertEquals(listOf(7, 965000L, 0.249625), listOf(s.total.count, s.total.ms, r(s.total.usd)))
        assertEquals(5, s.activeDays)
        assertEquals(listOf(1788220800000L, 1, 600000L, 0.17, 0.17, 0.0, 0), columns(s).first())
        assertEquals(listOf("gpt-live-transcribe", "openai", 4, 725000L, 0.20475), models(s).first())
    }

    @Test
    fun daysAfterAClockChangeAtMidnight() {
        // In Santiago the clocks go from 00:00 to 01:00 on 2026-09-06: that day starts at 01:00, the next at 00:00 again.
        TimeZone.setDefault(TimeZone.getTimeZone("America/Santiago"))
        val e = listOf(
            Usage.Entry(Instant.parse("2026-09-05T16:00:00Z").toEpochMilli(), 60_000, listOf(paid("gpt-live-transcribe", 0.017))),
            Usage.Entry(Instant.parse("2026-09-07T03:30:00Z").toEpochMilli(), 60_000, listOf(paid("gemini-3.5-transcribe-live", 0.009))),
        )
        val s = Usage.summarize(e, 7, Instant.parse("2026-09-08T13:00:00Z").toEpochMilli())
        assertEquals(1788321600000L, s.from)
        assertEquals(listOf(1788321600000L, 1788408000000L, 1788494400000L, 1788580800000L, 1788667200000L, 1788750000000L, 1788836400000L), s.columns.map { it.start })
        assertEquals(listOf(0, 0, 0, 1, 0, 1, 0), s.columns.map { it.total.count })
    }

    @Test
    fun daysWhereMidnightComesTwice() {
        // In Havana the clocks go from 01:00 back to 00:00 on 2026-11-01: the day starts at the first midnight.
        TimeZone.setDefault(TimeZone.getTimeZone("America/Havana"))
        val e = listOf(Usage.Entry(Instant.parse("2026-11-01T04:30:00Z").toEpochMilli(), 60_000, listOf(paid("gpt-live-transcribe", 0.017))))
        val all = Usage.summarize(e, Usage.ALL, Instant.parse("2026-11-02T15:00:00Z").toEpochMilli())
        assertEquals(1793505600000L, all.from)
        assertEquals(listOf(1793505600000L, 1793595600000L), all.columns.map { it.start })
        assertEquals(1, all.total.count)
        val week = Usage.summarize(e, 7, Instant.parse("2026-11-07T15:00:00Z").toEpochMilli())
        assertEquals(1793505600000L, week.from)
        assertEquals(listOf(1793505600000L, 1793595600000L, 1793682000000L), week.columns.take(3).map { it.start })
        assertEquals(0.017, week.total.usd, 1e-9)
    }

    @Test
    fun noDictations() {
        val s = Usage.summarize(emptyList(), Usage.ALL, now)
        assertEquals(at("2026-10-25T00:00:00Z"), s.from)
        assertEquals(1, s.columns.size)
        assertEquals(0, s.total.count)
    }

    @Test
    fun androidEntriesCostAsOnTheDesktop() {
        val e = History.Entry(
            "x", 0, durationMs = 120_000, status = History.Status.DONE,
            transcripts = listOf(
                History.Transcript(History.Source.LIVE, "gemini-3.5-transcribe-live", "a", 0),
                History.Transcript(History.Source.FORMATTED, "rules", "b", 0),
                History.Transcript(History.Source.RETRY_FILE, "gpt-transcribe", "c", 0),
            ),
        )
        assertEquals(listOf(0.018, 0.0, 0.009), Usage.of(e).transcripts.map { r(it.costUsd) })
    }
}
