package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

// Expected values are the output of src/core/proxy.ts and src/core/sync.ts on the same input.
class ProxyTest {
    @Test
    fun parse() {
        val cases = mapOf(
            "" to null,
            "h:1" to ProxyAddress("http://h:1", "h", 1, "", ""),
            "u:p@h:8080" to ProxyAddress("http://u:p@h:8080", "h", 8080, "u", "p"),
            "http://u:p%40x@h:1/" to ProxyAddress("http://u:p%40x@h:1", "h", 1, "u", "p@x"),
            "https://h:1" to null,
            "socks5://h:1" to null,
            "h" to null,
            "http://h:1/x" to null,
            " http://ciao:abc@212.118.40.237:43129 " to ProxyAddress("http://ciao:abc@212.118.40.237:43129", "212.118.40.237", 43129, "ciao", "abc"),
            "http://u:a+b@h:1" to ProxyAddress("http://u:a+b@h:1", "h", 1, "u", "a+b"),
            "http://U@Host.Example:3128" to ProxyAddress("http://U@host.example:3128", "host.example", 3128, "U", ""),
        )
        for ((typed, expected) in cases) assertEquals(typed, expected, ApiProxy.parse(typed))
        assertEquals("ciao@212.118.40.237:43129", ApiProxy.parse("http://ciao:abc@212.118.40.237:43129")!!.label)
    }

    private fun local(proxy: String, syncKeys: Boolean = true) = Local(listOf("A"), "p", emptyMap(), syncKeys, proxy)
    private val initial = Sync.initialState(local(""), listOf(), "")
    private val edited = Sync.recordEdit(initial, local("http://u:p@h:1"), 100)!!

    @Test
    fun sync() {
        // A file without a proxy has none, as from an older Ciao.
        assertEquals(false, Sync.serialize(initial).contains("proxy"))
        assertEquals(false, Sync.serialize(Sync.shared(Sync.recordEdit(edited, local("http://u:p@h:1", syncKeys = false), 200)!!)).contains("proxy"))
        assertEquals(edited, Sync.parse(Sync.serialize(edited)))
        assertEquals(
            Sync.parse("""{"version":1,"terms":[{"term":"A","at":0}],"prompt":{"value":"p","at":0},"keys":{},"syncKeys":{"value":true,"at":-1}}"""),
            initial,
        )
        assertEquals(
            Sync.parse("""{"version":1,"terms":[{"term":"A","at":0}],"prompt":{"value":"p","at":0},"keys":{},"syncKeys":{"value":true,"at":-1},"proxy":{"value":"http://u:p@h:1","at":100}}"""),
            edited,
        )
        // A file from an older Ciao has no proxy: this device's stays.
        val old = Sync.parse("""{"version":1,"terms":[{"term":"A","at":0}],"prompt":{"value":"p","at":0}}""")!!
        assertEquals(edited, Sync.mergeStates(old, edited))
        // Keys off: the file keeps no proxy, and none comes in from another device.
        val off = Sync.recordEdit(edited, local("http://u:p@h:1", syncKeys = false), 200)!!
        assertEquals(
            Sync.parse("""{"version":1,"terms":[{"term":"A","at":0}],"prompt":{"value":"p","at":0},"keys":{},"syncKeys":{"value":false,"at":200}}"""),
            Sync.shared(off),
        )
        val other = Sync.recordEdit(initial, local("http://x:y@z:2"), 300)!!
        assertEquals(
            Sync.parse("""{"version":1,"terms":[{"term":"A","at":0}],"prompt":{"value":"p","at":0},"keys":{},"syncKeys":{"value":false,"at":200},"proxy":{"value":"http://u:p@h:1","at":100}}"""),
            Sync.mergeStates(off, other),
        )
        assertEquals(
            Sync.parse("""{"version":1,"terms":[{"term":"A","at":0}],"prompt":{"value":"p","at":0},"keys":{},"syncKeys":{"value":true,"at":-1},"proxy":{"value":"http://x:y@z:2","at":300}}"""),
            Sync.mergeStates(edited, other),
        )
    }
}
