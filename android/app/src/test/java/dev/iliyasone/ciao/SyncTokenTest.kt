package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

// ChatGPT's token in the synced file. Expected values are the output of src/core/sync.ts on the same input.
class SyncTokenTest {
    private fun jwt(email: String, exp: Long) =
        "x." + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString("""{"exp":$exp,"https://api.openai.com/profile":{"email":"$email"}}""".toByteArray()) + ".y"

    private val x1 = jwt("x@e.c", 1000)
    private val x2 = jwt("x@e.c", 2000)
    private val y1 = jwt("y@e.c", 1500)
    private fun local(chatgpt: String) = Local(listOf(), "p", emptyMap(), true, "", chatgpt)
    private fun initial() = Sync.initialState(local(""), listOf(), "p")

    // Signed in on A at 100 and synced to B; A signs out at 200; B renews at 300 before it hears of that.
    private val a0 = Sync.recordEdit(initial(), local(x1), 100)!!
    private val b0 = Sync.mergeStates(initial(), a0)
    private val a1 = Sync.recordEdit(a0, local(""), 200)!!
    private val b1 = Sync.recordEdit(b0, local(x2), 300)!!

    @Test
    fun renewalDoesNotUndoSignOut() {
        assertEquals(100L, b1.chatgpt.at)
        assertEquals(Stamped("", 200), Sync.mergeStates(b1, a1).chatgpt)
        assertEquals(Stamped("", 200), Sync.mergeStates(a1, b1).chatgpt)
    }

    @Test
    fun laterRenewalAndNewSignInWin() {
        val c1 = Sync.recordEdit(b0, local(x2), 300)!!
        assertEquals(x2, Sync.mergeStates(b0, c1).chatgpt.value)
        assertEquals(x2, Sync.mergeStates(c1, b0).chatgpt.value)
        val y = Sync.recordEdit(a1, local(y1), 400)!!
        assertEquals(y1, Sync.mergeStates(b1, y).chatgpt.value)
        assertEquals(y1, Sync.mergeStates(y, b1).chatgpt.value)
    }

    /** A file from an older Ciao has no token: merging it keeps ours rather than signing out. */
    @Test
    fun olderFileAndSwitch() {
        val old = Sync.parse("""{"version":1,"terms":[],"prompt":{"value":"p","at":-1},"keys":{},"syncKeys":{"value":true,"at":-1}}""")!!
        assertEquals(Stamped(x2, 100), Sync.mergeStates(b1, old).chatgpt)
        // As parsed: org.json on the JVM orders the fields its own way.
        assertEquals(
            Sync.parse("""{"version":1,"terms":[],"prompt":{"value":"p","at":-1},"keys":{},"syncKeys":{"value":true,"at":-1},"chatgpt":{"value":"$x2","at":100}}"""),
            Sync.parse(Sync.serialize(Sync.shared(b1))),
        )
        val off = Sync.serialize(Sync.shared(b1.copy(syncKeys = Flag(false, 500))))
        assertEquals(Sync.parse("""{"version":1,"terms":[],"prompt":{"value":"p","at":-1},"keys":{},"syncKeys":{"value":false,"at":500}}"""), Sync.parse(off))
        assertEquals(false, off.contains("chatgpt"))
        assertEquals(Sync.serialize(b1), Sync.serialize(Sync.parse(Sync.serialize(b1))!!))
    }
}
