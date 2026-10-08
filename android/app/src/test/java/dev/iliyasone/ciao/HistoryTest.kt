package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class HistoryTest {
    private val history = History(Files.createTempDirectory("history").toFile())

    @Test
    fun savesAndListsNewestFirst() {
        val old = history.create(Provider.OPENAI, now = 1_000)
        val new = history.create(Provider.GEMINI, now = 2_000)
        history.save(old.plus(History.Transcript(History.Source.LIVE, "gpt-live-transcribe", "привет", 1_500)).copy(durationMs = 1500, delivery = History.Delivery.PASTED))
        assertEquals(listOf(new.id, old.id), history.list().map { it.id })
        val e = history.get(old.id)!!
        assertEquals("привет", e.text)
        assertEquals(History.Status.DONE, e.status)
        assertEquals(1500L, e.durationMs)
        assertEquals(History.Delivery.PASTED, e.delivery)
        assertEquals(History.Source.LIVE, e.transcripts.single().source)
        assertEquals(Provider.GEMINI, history.get(new.id)!!.provider)
    }

    @Test
    fun recoversInterruptedRecordings() {
        val e = history.create(Provider.OPENAI)
        history.audioFile(e.id).writeBytes(ByteArray(Recorder.SAMPLE_RATE * 2 * 3)) // 3 s
        history.recover()
        val r = history.get(e.id)!!
        assertEquals(History.Status.FAILED, r.status)
        assertEquals(3000L, r.durationMs)
    }

    @Test
    fun deletedEntryIsNotWrittenBack() {
        val e = history.create(Provider.OPENAI)
        history.delete(e.id)
        history.save(e.copy(status = History.Status.DONE))
        assertNull(history.get(e.id))
    }

    @Test
    fun trimKeepsTextAndFailedAudio() {
        val failed = history.create(Provider.OPENAI, now = 1_000)
        val done = history.create(Provider.OPENAI, now = 2_000)
        val newest = history.create(Provider.OPENAI, now = 3_000)
        for (e in listOf(failed, done, newest)) history.audioFile(e.id).writeBytes(ByteArray(10))
        history.save(failed.copy(status = History.Status.FAILED))
        history.save(done.plus(History.Transcript(History.Source.LIVE, "m", "a", 0)))
        history.save(newest.plus(History.Transcript(History.Source.LIVE, "m", "b", 0)))
        history.trim(keepAudio = 1)
        assertTrue(history.audioFile(newest.id).exists())
        assertFalse(history.audioFile(done.id).exists())
        assertTrue(history.audioFile(failed.id).exists())
        assertEquals("a", history.get(done.id)!!.text)
    }

    @Test
    fun readsEntriesFromCiao083() {
        val e = history.create(Provider.GEMINI, now = 5_000)
        // As 0.8.3 wrote it: one "text", no transcripts.
        java.io.File(history.audioFile(e.id).parentFile, "entry.json").writeText(
            """{"id":"${e.id}","createdAt":5000,"durationMs":2000,"status":"done","text":"старое","provider":"gemini"}""",
        )
        val old = history.get(e.id)!!
        assertEquals("старое", old.text)
        assertEquals(History.Source.LIVE, old.transcripts.single().source)
        assertEquals(Provider.GEMINI.liveModel, old.transcripts.single().model)
        // Saved again, it keeps the text in the new form.
        history.save(old.plus(History.Transcript(History.Source.RETRY_FILE, Provider.GEMINI.fileModel, "новое", 6_000)))
        assertEquals(listOf("старое", "новое"), history.get(e.id)!!.transcripts.map { it.text })
    }
}
