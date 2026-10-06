package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

// Expected values are the output of src/core/revision.ts on the same input.
class RevisionTest {
    private fun check(prev: String, next: String, pauses: List<Pause>, gapMs: Long, same: Int, expected: List<Pause>) =
        assertEquals(same to expected, Revision.revisePauses(prev, next, pauses, gapMs))

    @Test
    fun matchesDesktop() {
        check("Ну, привет. Как дела", "Привет. Как дела", listOf(Pause(11, 1500)), 0, 0, listOf(Pause(7, 1500)))
        check(
            "Привет как дела у тебя сегодня", "Привет, как дела у тебя сегодня?", listOf(Pause(15, 2000), Pause(23, 1300)), 1500,
            6, listOf(Pause(7, 1500), Pause(16, 2000), Pause(23, 1300)),
        )
        check("first part second", "first part. Second part", listOf(), 1800, 10, listOf(Pause(11, 1800)))
        check("Один два три", "Один два три четыре", listOf(Pause(4, 1300)), 200, 12, listOf(Pause(4, 1300)))
        check("в два, нет, в три часа. Потом", "в три часа. Потом", listOf(Pause(23, 1400)), 0, 2, listOf(Pause(11, 1400)))
    }
}
