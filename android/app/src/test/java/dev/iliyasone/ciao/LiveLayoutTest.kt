package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

// Expected values are the output of src/core/liveLayout.ts and src/core/voiceCommands.ts on the
// same input, so the phone lays text out exactly like the desktop app.
class LiveLayoutTest {
    private fun check(text: String, pauses: List<Pause>, expected: String) =
        assertEquals(expected, LiveLayout.apply(text, LiveLayout.layout(text, pauses)))

    @Test
    fun matchesDesktop() {
        check("Привет. Первое, надо сделать коммит. Второе: запушить. И ещё проверить CI. Потом отдохнуть.", listOf(), "Привет.\n\n1. Надо сделать коммит.\n2. Запушить.\n3. Проверить CI. Потом отдохнуть.")
        check("Сделай вот что. Во-первых, открой файл. Во-вторых закрой его. Дальше сохрани.", listOf(Pause(40, 2500)), "Сделай вот что.\n\n1. Открой файл.\n2. Закрой его.\n3. Сохрани.")
        check("First, open it. Second, close it. Also save. Next run", listOf(), "1. Open it.\n2. Close it.\n3. Save.\n4. Run")
        check("Это первый абзац. Это второй после паузы", listOf(Pause(17, 1500)), "Это первый абзац.\n\nЭто второй после паузы")
        check("Это первый абзац без точки Это второй", listOf(Pause(26, 1500)), "Это первый абзац без точки\n\nЭто второй")
        check("Третий момент очень важен. Четвёртое", listOf(), "3. Очень важен.\n4.")
        check("Первое", listOf(), "1.")
        check("Первое ", listOf(), "1.")
    }

    @Test
    fun stopPhrase() {
        assertEquals(true, VoiceCommands.endsWithStopPhrase("Ну всё, чао-чао."))
        assertEquals("Ну всё", VoiceCommands.stripStopPhrase("Ну всё, чао-чао."))
        assertEquals(true, VoiceCommands.endsWithStopPhrase("Ciao, ciao"))
        assertEquals("", VoiceCommands.stripStopPhrase("Ciao, ciao"))
        assertEquals(true, VoiceCommands.endsWithStopPhrase("не чаочао"))
        assertEquals("не", VoiceCommands.stripStopPhrase("не чаочао"))
        assertEquals(false, VoiceCommands.endsWithStopPhrase("Скажи мне чао"))
        assertEquals("Скажи мне чао", VoiceCommands.stripStopPhrase("Скажи мне чао"))
    }
}
