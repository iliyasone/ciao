package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Test

// Expected values are the output of src/core/sync.ts on the same input, so the phone and the
// desktop merge the synced file the same way.
class SyncTest {
    private fun state(json: String) = Sync.parse(json)!!

    private val edited = Sync.recordEdit(Sync.initialState(listOf("A", "B", " A "), "p", listOf(), ""), listOf("B", "C", " C ", ""), "p", 100)!!
    private val remote = SyncState(
        listOf(TermChange("D", 10), TermChange("A", 50), TermChange("B", 200, removed = true)),
        Stamped("q", 150),
    )

    @Test
    fun recordEdit() {
        assertEquals(
            state("""{"version":1,"terms":[{"term":"A","at":0},{"term":"B","at":0}],"prompt":{"value":"p","at":0}}"""),
            Sync.initialState(listOf("A", "B", " A "), "p", listOf(), ""),
        )
        assertEquals(
            state("""{"version":1,"terms":[{"term":"A","at":100,"removed":true},{"term":"B","at":0},{"term":"C","at":100}],"prompt":{"value":"p","at":0}}"""),
            edited,
        )
        assertNull(Sync.recordEdit(edited, listOf("C", "B"), "p", 200))
    }

    @Test
    fun merge() {
        val merged = Sync.mergeStates(edited, remote)
        assertEquals(
            state("""{"version":1,"terms":[{"term":"A","at":100,"removed":true},{"term":"B","at":200,"removed":true},{"term":"C","at":100},{"term":"D","at":10}],"prompt":{"value":"q","at":150}}"""),
            merged,
        )
        assertEquals(listOf("C", "D"), Sync.termsOf(merged))
        assertTrue(Sync.sameState(merged, Sync.mergeStates(remote, edited)))
        assertFalse(Sync.sameState(edited, remote))
    }

    @Test
    fun defaults() {
        assertEquals(
            state("""{"version":1,"terms":[{"term":"Mine","at":0},{"term":"D1","at":-1},{"term":"D2","at":0,"removed":true}],"prompt":{"value":"default prompt","at":-1}}"""),
            Sync.initialState(listOf("Mine", "D1", ""), "default prompt", listOf("D1", "D2"), "default prompt"),
        )
        // A fresh install meets a device with a custom prompt and a deleted default: both win.
        val fresh = Sync.initialState(listOf("D1", "D2", "D3"), "default prompt", listOf("D1", "D2", "D3"), "default prompt")
        val custom = Sync.initialState(listOf("Mine", "D1"), "Custom", listOf("D1", "D2"), "default prompt")
        val merged = Sync.mergeStates(fresh, custom)
        assertEquals(
            state("""{"version":1,"terms":[{"term":"D1","at":-1},{"term":"D2","at":0,"removed":true},{"term":"D3","at":-1},{"term":"Mine","at":0}],"prompt":{"value":"Custom","at":0}}"""),
            merged,
        )
        assertEquals(listOf("D1", "D3", "Mine"), Sync.termsOf(merged))
    }

    @Test
    fun arrange() {
        assertEquals(listOf("Z", "B", "A", "New"), Sync.arrangeTerms(listOf("Z", " B", "A", "", "gone"), listOf("A", "B", "New", "Z")))
    }

    @Test
    fun tie() {
        val a = SyncState(listOf(TermChange("X", 5)), Stamped("a", 1))
        val b = SyncState(listOf(TermChange("X", 5, removed = true)), Stamped("b", 1))
        val expected = state("""{"version":1,"terms":[{"term":"X","at":5,"removed":true}],"prompt":{"value":"b","at":1}}""")
        assertEquals(expected, Sync.mergeStates(a, b))
        assertEquals(expected, Sync.mergeStates(b, a))
    }

    @Test
    fun parse() {
        assertNull(Sync.parse("""{"version":2,"terms":[],"prompt":{"value":"","at":0}}"""))
        assertNull(Sync.parse("nope"))
        assertNull(Sync.parse("""{"version":1,"terms":[{"term":" ","at":1}],"prompt":{"value":"","at":0}}"""))
        val merged = Sync.mergeStates(edited, remote)
        assertEquals(merged, Sync.parse(Sync.serialize(merged)))
    }
}
