package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

/**
 * Every service the desktop can transcribe with is on Android too (AGENTS.md): a provider added to
 * src/core/providers.ts without its Kotlin port fails here, in CI.
 */
class ProviderParityTest {
    @Test
    fun androidHasEveryDesktopProvider() {
        // Gradle runs unit tests in the module's folder, android/app.
        val source = File("../../src/core/providers.ts").readText()
        val registry = source.substringAfter("export const PROVIDERS").substringBefore("\n};")
        val desktop = Regex("""^ {2}(\w+): \{""", RegexOption.MULTILINE).findAll(registry).map { it.groupValues[1] }.toSortedSet()
        assertEquals(desktop, Provider.entries.map { it.id }.toSortedSet())
        // The same models, so the usage counts and the history read alike on both.
        for (p in Provider.entries) {
            val block = registry.substringAfter("  ${p.id}: {").substringBefore("\n  },")
            assertEquals(p.id, Regex("""liveModel: "([^"]+)"""").find(block)?.groupValues?.get(1), p.liveModel)
            assertEquals(p.id, Regex("""fileModel: "([^"]+)"""").find(block)?.groupValues?.get(1), p.fileModel)
        }
    }
}
