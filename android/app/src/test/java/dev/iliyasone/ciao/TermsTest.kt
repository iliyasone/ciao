package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

// "Чао, запомни слово …": expected values are the output of takeRememberCommands in
// src/core/voiceCommands.ts and of src/core/terms.ts on the same input, so the phone cuts the same
// command out and adds the same term as the desktop app.
class TermsTest {
    private fun cmd(heard: String, spelled: Boolean) = VoiceCommands.RememberCommand(heard, spelled)

    private fun check(text: String, rest: String, vararg commands: VoiceCommands.RememberCommand) =
        assertEquals(rest to commands.toList(), VoiceCommands.takeRememberCommands(text))

    /** A dictation the wake word started: the command may come without its "чао". */
    private fun checkWake(text: String, rest: String, vararg commands: VoiceCommands.RememberCommand) =
        assertEquals(rest to commands.toList(), VoiceCommands.takeRememberCommands(text, wakeStarted = true))

    private fun terms(c: VoiceCommands.RememberCommand, plain: String?, fallback: String?) {
        assertEquals(plain, Terms.plain(c))
        assertEquals(fallback, Terms.fallback(c))
    }

    @Test
    fun matchesDesktop() {
        check("Чао, запомни слово PostHog.", "", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Сделай коммит. Чао, запомни слово PostHog. И запушь.", "Сделай коммит. И запушь.", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Чао, запомни слово: пэ, о, эс, тэ, эйч, о, джи. Дальше текст.", "Дальше текст.", cmd("пэ, о, эс, тэ, эйч, о, джи", true))
        terms(cmd("пэ, о, эс, тэ, эйч, о, джи", true), plain = null, fallback = null)
        check("Ciao, remember the word P-O-S-T-H-O-G", "", cmd("P-O-S-T-H-O-G", true))
        terms(cmd("P-O-S-T-H-O-G", true), plain = null, fallback = "POSTHOG")
        check("ао, запомни слово Кубернетес", "", cmd("Кубернетес", false))
        terms(cmd("Кубернетес", false), plain = null, fallback = "Кубернетес")
        check("Открой файл, чао, добавь в термины Next.js, и сохрани", "Открой файл, и сохрани", cmd("Next.js", false))
        terms(cmd("Next.js", false), plain = "Next.js", fallback = "Next.js")
        check("Чао запомни слово пост хог, по буквам: P, O, S, T, H, O, G. Готово.", "Готово.", cmd("пост хог, по буквам: P, O, S, T, H, O, G", true))
        terms(cmd("пост хог, по буквам: P, O, S, T, H, O, G", true), plain = null, fallback = null)
        check("Чао, запомни.", "Чао, запомни.")
        check("Я сказал ей: запомни слово PostHog.", "Я сказал ей: запомни слово PostHog.")
        check("Чао, запомни слово Claude Code и ещё что-то длинное потом", "И ещё что-то длинное потом", cmd("Claude Code", false))
        terms(cmd("Claude Code", false), plain = null, fallback = "Claude Code")
        check("Чао, запомни термин эн, пэ, эм. Чао, запомни слово Supabase.", "", cmd("эн, пэ, эм", true), cmd("Supabase", false))
        terms(cmd("эн, пэ, эм", true), plain = null, fallback = null)
        terms(cmd("Supabase", false), plain = null, fallback = "Supabase")
        check("Чао, запомни слово P. O. S. T. Да.", "Да.", cmd("P. O. S. T", true))
        terms(cmd("P. O. S. T", true), plain = null, fallback = "POST")
        check("Чао, запомни слово PostHog это важно", "Это важно", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Чао, запомни слово gpt-5 mini.", "", cmd("gpt-5 mini", false))
        terms(cmd("gpt-5 mini", false), plain = null, fallback = "gpt-5 mini")
        check("iPhone тоже, чао, запомни слово Expo.", "iPhone тоже", cmd("Expo", false))
        terms(cmd("Expo", false), plain = null, fallback = "Expo")
        check("Чао, запомни слово по буквам: N P M. А потом проверь сборку.", "А потом проверь сборку.", cmd("N P M", true))
        terms(cmd("N P M", true), plain = null, fallback = "NPM")
        check("Чао, запомни слово: эн. пэ. эм.", "", cmd("эн. пэ. эм", true))
        terms(cmd("эн. пэ. эм", true), plain = null, fallback = null)
        check("Чао, запомни слово по буквам: N P M, а потом проверь сборку.", "А потом проверь сборку.", cmd("N P M", true))
        terms(cmd("N P M", true), plain = null, fallback = "NPM")
        check("Чао, запомни: пэ, о, эс, тэ, эйч, о, джи и всё", "Чао, запомни: пэ, о, эс, тэ, эйч, о, джи и всё")
        check("Чао, add term Claude Code then go", "Then go", cmd("Claude Code", false))
        terms(cmd("Claude Code", false), plain = null, fallback = "Claude Code")
        check("Чао, добавь тесты на парсер", "Чао, добавь тесты на парсер")
        check("Чао, добавь в README раздел про установку.", "Чао, добавь в README раздел про установку.")
        check("Чао, запомни: мы используем pnpm, а не npm.", "Чао, запомни: мы используем pnpm, а не npm.")
        check("Ciao, add a retry to the fetch call", "Ciao, add a retry to the fetch call")
        check("Ну всё, чао, добавь меня в друзья.", "Ну всё, чао, добавь меня в друзья.")
        check("Привет. Чао, запомни слово «PostHog». Дальше.", "Привет. Дальше.", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Чао, запомни слово \"PostHog\", ок", "Ок", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Чао, запомни слово эн пэ эм и я пошёл", "И я пошёл", cmd("эн пэ эм", true))
        terms(cmd("эн пэ эм", true), plain = null, fallback = null)
        check("Чао, добавь в термины Supabase", "", cmd("Supabase", false))
        terms(cmd("Supabase", false), plain = null, fallback = "Supabase")
        check("Чао, добавь в словарь слово PostHog.", "", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Чао, добавь в термины слово постхог", "", cmd("постхог", false))
        terms(cmd("постхог", false), plain = null, fallback = "постхог")
        check("Чао, добавь слово PostHog в словарь. Дальше.", "Дальше.", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Ciao, add the word PostHog to my dictionary.", "", cmd("PostHog", false))
        terms(cmd("PostHog", false), plain = "PostHog", fallback = "PostHog")
        check("Ciao, add the term Kubernetes to the list and deploy", "To the list and deploy", cmd("Kubernetes", false))
        terms(cmd("Kubernetes", false), plain = null, fallback = "Kubernetes")
        check("Чао, добавь слово «срочно» в заголовок письма.", "В заголовок письма.", cmd("срочно", false))
        terms(cmd("срочно", false), plain = null, fallback = "срочно")
        check("Он сказал: «Чао, запомни слово мама»", "Он сказал", cmd("мама", false))
        terms(cmd("мама", false), plain = null, fallback = "мама")
        check("Чао,\u00A0запомни слово\u00A0Posthog", "", cmd("Posthog", false))
        terms(cmd("Posthog", false), plain = null, fallback = "Posthog")
        checkWake("Запомни слово PostHog.", "", cmd("PostHog", false))
        check("Запомни слово PostHog.", "Запомни слово PostHog.")
        checkWake("ао, запомни слово PostHog. Дальше", "Дальше", cmd("PostHog", false))
        check("ао, запомни слово PostHog. Дальше", "Дальше", cmd("PostHog", false))
        checkWake("Запомни слово PostHog, и дальше", "И дальше", cmd("PostHog", false))
        check("Запомни слово PostHog, и дальше", "Запомни слово PostHog, и дальше")
    }

    @Test
    fun cleansAnswers() {
        assertEquals("PostHog", Terms.clean("«PostHog»."))
        assertEquals("PostHog", Terms.clean("“PostHog”."))
        assertEquals("A.I.", Terms.clean("A.I."))
        assertEquals("Next.js", Terms.clean("Next.js."))
        assertEquals("PostHog", Terms.clean("PostHog"))
        assertEquals("PostHog", Terms.clean(" «PostHog». "))
        assertEquals("npm", Terms.clean("\"npm\""))
        assertEquals(null, Terms.clean(""))
        assertEquals(null, Terms.clean("line\nbreak"))
        assertEquals(null, Terms.clean("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"))
    }

    @Test
    fun addsTerms() {
        assertEquals(listOf("API", "PostHog"), Terms.add(listOf("API", "Posthog"), "PostHog"))
        assertEquals(null, Terms.add(listOf("PostHog"), "PostHog"))
    }
}
