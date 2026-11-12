package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

/** The expected values are the outputs of src/core/silence.ts for the same chunks. */
class SilenceGateTest {
    /** 40 ms of a square wave: its level is [amp]. */
    private fun chunk(amp: Int) = ByteArray(Recorder.CHUNK_BYTES).also {
        for (i in 0 until it.size / 2) {
            val v = if (i % 2 == 1) amp else -amp
            it[i * 2] = v.toByte()
            it[i * 2 + 1] = (v shr 8).toByte()
        }
    }

    /** How many chunks each one let out, and the bytes left out in all. */
    private fun run(vararg parts: Pair<Int, Int>): Pair<String, Long> {
        val gate = SilenceGate()
        val sent = parts.flatMap { (n, amp) -> List(n) { amp } }.joinToString("") { gate.pass(chunk(it)).size.toString() }
        return sent to gate.skipped
    }

    @Test fun `a long pause loses its middle and keeps a second after speech and half a second before`() {
        val (sent, skipped) = run(5 to 3000, 100 to 20, 3 to 3000)
        assertEquals("1".repeat(30) + "0".repeat(75) + "1311", sent)
        assertEquals(120_960L, skipped)
    }

    @Test fun `nothing is silence until something loud is heard, and a soft voice sets the bar low`() {
        val (sent, skipped) = run(100 to 20, 3 to 300, 60 to 30)
        assertEquals("1".repeat(128) + "0".repeat(35), sent)
        // Ends in silence: the half second held for a sound that never came wasn't sent either.
        assertEquals(67_200L, skipped)
    }

    @Test fun `steady noise is sent whole`() {
        val (sent, skipped) = run(3 to 3000, 60 to 250)
        assertEquals("1".repeat(63), sent)
        assertEquals(0L, skipped)
    }

    /** A second of audio: each part is milliseconds of a square wave at an amplitude. */
    private fun second(vararg parts: Pair<Int, Int>) = ByteArray(48_000).also {
        var i = 0
        for ((ms, amp) in parts) repeat(ms * 24) { _ ->
            val v = if (i % 2 == 1) amp else -amp
            it[i * 2] = v.toByte()
            it[i * 2 + 1] = (v shr 8).toByte()
            i++
        }
    }

    @Test fun `a replay's one-second chunks are judged in 40 ms frames, so speech at the end of a quiet one is sent`() {
        val gate = SilenceGate()
        val sizes = listOf(second(1000 to 3000), second(1000 to 20), second(1000 to 20), second(1000 to 20), second(880 to 20, 120 to 1000))
            .map { chunk -> gate.pass(chunk).joinToString("+") { it.size.toString() } }
        assertEquals(listOf("48000", "48000", "", "", List(12) { "1920" }.joinToString("+") + "+5760"), sizes)
        assertEquals(115_200L, gate.skipped)
    }
}
