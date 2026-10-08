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
        history.save(old.copy(status = History.Status.DONE, text = "привет", durationMs = 1500))
        assertEquals(listOf(new.id, old.id), history.list().map { it.id })
        val e = history.get(old.id)!!
        assertEquals("привет", e.text)
        assertEquals(History.Status.DONE, e.status)
        assertEquals(1500L, e.durationMs)
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
        history.save(e.copy(status = History.Status.DONE, text = "x"))
        assertNull(history.get(e.id))
    }

    @Test
    fun trimKeepsTextAndFailedAudio() {
        val failed = history.create(Provider.OPENAI, now = 1_000)
        val done = history.create(Provider.OPENAI, now = 2_000)
        val newest = history.create(Provider.OPENAI, now = 3_000)
        for (e in listOf(failed, done, newest)) history.audioFile(e.id).writeBytes(ByteArray(10))
        history.save(failed.copy(status = History.Status.FAILED))
        history.save(done.copy(status = History.Status.DONE, text = "a"))
        history.save(newest.copy(status = History.Status.DONE, text = "b"))
        history.trim(keepAudio = 1)
        assertTrue(history.audioFile(newest.id).exists())
        assertFalse(history.audioFile(done.id).exists())
        assertTrue(history.audioFile(failed.id).exists())
        assertEquals("a", history.get(done.id)!!.text)
    }
}
