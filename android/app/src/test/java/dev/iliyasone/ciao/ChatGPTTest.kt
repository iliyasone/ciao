package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class ChatGPTTest {
    /** As chatgptAccount in src/core/chatgpt.ts: the email and expiry are read from the token's claims. */
    @Test
    fun account() {
        val claims = """{"exp":1795000000,"https://api.openai.com/profile":{"email":"a@b.c"}}"""
        val part = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(claims.toByteArray())
        val account = ChatGPT.account("x.$part.y")!!
        assertEquals("a@b.c", account.email)
        assertEquals(1795000000_000L, account.expiresAt)
        assertNull(ChatGPT.account("not a token"))
        assertNull(ChatGPT.account("x.${java.util.Base64.getUrlEncoder().encodeToString("{}".toByteArray())}.y"))
    }

    /** ChatGPT's dictations count, at no cost, as summarizeUsage in src/core/usage.ts. */
    @Test
    fun usageCountsChatGPT() {
        val entries = listOf(
            Usage.Entry(1_000L, 60_000, listOf(Usage.Paid("chatgpt-dictation", 0.0))),
            Usage.Entry(2_000L, 120_000, listOf(Usage.Paid("nemotron-asr-streaming", 0.0009))),
        )
        val s = Usage.summarize(entries, Usage.ALL, 3_000L)
        assertEquals(1, s.columns.sumOf { it.byProvider.getValue("chatgpt").count })
        assertEquals(1, s.columns.sumOf { it.byProvider.getValue("nemotron").count })
        assertEquals(0, s.columns.sumOf { it.byProvider.getValue("other").count })
        assertEquals(listOf("nemotron-asr-streaming", "chatgpt-dictation"), s.models.map { it.model })
    }
}
