package dev.iliyasone.ciao

import org.junit.Assert.assertEquals
import org.junit.Test

// Expected values are the output of src/core/corrections.ts on the same input.
class CorrectionsTest {
    private fun check(inserted: String, field: String, expected: List<Correction>?) =
        assertEquals("$inserted → $field", expected, Corrections.find(inserted, field))

    @Test
    fun matchesDesktop() {
        // a misheard name
        check("Давай добавим постхок в проект.", "Давай добавим PostHog в проект.", listOf(Correction("постхок", "PostHog")))
        // two words for one term
        check("Открой клод код и запусти тесты.", "Открой Claude Code и запусти тесты.", listOf(Correction("клод код", "Claude Code")))
        // text appended after ours
        check("Привет как дела", "Привет как дела? Что нового у тебя сегодня", listOf())
        // ours inside longer field text
        check("Давай добавим постхок в проект.", "Слушай, вот что. Давай добавим PostHog в проект. И ещё потом обсудим.", listOf(Correction("постхок", "PostHog")))
        // case-only changes to a term's spelling
        check("Залей это на api github", "Залей это на API GitHub", listOf(Correction("api", "API"), Correction("github", "GitHub")))
        // a typo fix in an ordinary word
        check("Превет как дела", "Привет как дела", listOf())
        // a number changed
        check("Встреча в 2 часа", "Встреча в 3 часа", listOf())
        // Russian spellings of English words
        check("Сделай коммит и пуш в мейн", "Сделай commit и push в main", listOf(Correction("коммит", "commit"), Correction("пуш", "push"), Correction("мейн", "main")))
        // a total rewrite
        check("Давай добавим постхок в проект.", "Совсем другой текст про погоду", null)
        // the field emptied (sent)
        check("Давай добавим постхок в проект.", "", null)
        // a command
        check("Запусти кубектл апплай", "Запусти kubectl apply", listOf(Correction("кубектл апплай", "kubectl apply")))
        // a capital at a sentence start says nothing
        check("Скажи привет маме. мама рада", "Скажи привет маме. Мама рада", listOf())
        // capitalised mid-sentence
        check("Скажи привет маме", "Скажи Привет маме", listOf())
        // a term at the sentence start
        check("Постхок уже подключен.", "PostHog уже подключен.", listOf(Correction("Постхок", "PostHog")))
        // after a quote and a non-breaking space
        check("Он сказал: «гитхаб упал»", "Он сказал:\u00a0«GitHub упал»", listOf(Correction("гитхаб", "GitHub")))
        // nothing changed
        check("Давай добавим постхок в проект.", "Давай добавим постхок в проект.", listOf())
        // not alike
        check("Используй джипити пять", "Используй GPT-5", listOf())
        // dotted term
        check("Обнови ноду джээс", "Обнови Node.js", listOf())
        // plus signs
        check("Пишем на си плюс плюс", "Пишем на C++", listOf())
        // same word twice
        check("гитхаб и снова гитхаб", "GitHub и снова GitHub", listOf(Correction("гитхаб", "GitHub")))
        // long text, one word fixed
        check("Сегодня мы будем настраивать вебсокет соединение для нашего приложения и проверим логи", "Сегодня мы будем настраивать WebSocket соединение для нашего приложения и проверим логи", listOf(Correction("вебсокет", "WebSocket")))
        // long text mostly rewritten
        check("Сегодня мы будем настраивать вебсокет соединение для нашего приложения", "Сегодня я пойду гулять в парк с собакой и друзьями весь день", null)
        // emoji around
        check("Запусти 🚀 кубектл", "Запусти 🚀 kubectl", listOf(Correction("кубектл", "kubectl")))
        // decomposed й in the field (NFC)
        check("Открой мой постхок", "Открой мои\u0306 PostHog", listOf(Correction("постхок", "PostHog")))
        // decomposed letters before the change
        check("Мой гитхаб", "Мои\u0306 GitHub", listOf(Correction("гитхаб", "GitHub")))
        // ok is never a term
        check("Скажи окей гуглу", "Скажи OK гуглу", listOf())
        // окей spelled differently
        check("Ну ок давай", "Ну Окей давай", listOf())
        // a grammar ending
        check("Поговори с Иваном завтра", "Поговори с Ивановым завтра", listOf())
        // a letter changed, same length
        check("Передай Ильязу привет", "Передай Ильясу привет", listOf(Correction("Ильязу", "Ильясу")))
        // a quote, then a sentence end before it
        check("Готово. «постхок» работает", "Готово. «PostHog» работает", listOf(Correction("постхок", "PostHog")))
    }

    @Test
    fun longDictationIsNotCompared() {
        fun text(n: Int) = (0 until n).joinToString(" ") { listOf("один", "два", "постхок", "три")[it % 4] }
        check(text(1500), text(1500).replaceFirst("постхок", "PostHog"), listOf(Correction("постхок", "PostHog")))
        // Over 1500 words: nothing offered, but the text is still there (not null).
        check(text(1501), text(1501).replaceFirst("постхок", "PostHog"), listOf())
    }

    @Test
    fun skipsKnownTerms() {
        assertEquals(
            listOf(Correction("постхок", "PostHog")),
            Corrections.newTerms(listOf(Correction("постхок", "PostHog"), Correction("гитхаб", "GitHub")), listOf(" github ", "API")),
        )
    }

    @Test
    fun soundsLikeDesktop() {
        assertEquals("posthok", Corrections.sound("постхок"))
        assertEquals("posthog", Corrections.sound("PostHog"))
        assertEquals("klodkod", Corrections.sound("клод код"))
        assertEquals("klaudekode", Corrections.sound("Claude Code"))
        assertEquals("shuka", Corrections.sound("Щука"))
        assertEquals("kuik", Corrections.sound("quick"))
        assertEquals("ksboks", Corrections.sound("Xbox"))
        assertEquals("mein", Corrections.sound("мейн"))
        assertEquals("filip", Corrections.sound("Philipp"))
        assertEquals(true, Corrections.soundsAlike("постхок", "PostHog"))
        assertEquals(true, Corrections.soundsAlike("кубектл", "kubectl"))
        assertEquals(false, Corrections.soundsAlike("мама", "PostHog"))
        assertEquals(true, Corrections.soundsAlike("вебсокет", "WebSocket"))
    }
}
