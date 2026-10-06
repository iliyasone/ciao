package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

class UpdaterTest {
    @Test
    fun comparesVersions() {
        assertEquals(true, Updater.newer("0.8.0", "0.7.0"))
        assertEquals(true, Updater.newer("v0.10.0", "0.9.9"))
        assertEquals(true, Updater.newer("1.0.0", "0.99.99"))
        assertEquals(false, Updater.newer("0.7.0", "0.7.0"))
        assertEquals(false, Updater.newer("v0.6.9", "0.7.0"))
        assertEquals(false, Updater.newer("nightly", "0.7.0"))
    }
}
