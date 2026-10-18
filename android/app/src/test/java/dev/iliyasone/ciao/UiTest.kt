package dev.iliyasone.ciao

import android.content.ClipboardManager
import android.widget.EditText
import android.widget.ListView
import android.widget.RadioButton
import android.widget.Switch
import android.widget.TextView
import android.view.View
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.shadows.ShadowLooper
import java.io.File
import org.robolectric.annotation.Config

/** The Ciao screen, run for real on the JVM by Robolectric. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class UiTest {
    @Test
    fun switchesProvider() {
        val prefs = Prefs(RuntimeEnvironment.getApplication())
        prefs.apiKey = "sk-openai"
        prefs.geminiKey = "AQ.gemini"
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        // None picked yet: Gemini, the cheaper, listed first with its price.
        assertEquals(Provider.GEMINI, prefs.provider)
        assertEquals("Google Gemini · ≈ $0.54 per hour of speech", activity.findViewById<RadioButton>(R.id.providerGemini).text.toString())
        val key = activity.findViewById<EditText>(R.id.apiKey)
        assertEquals("AQ.gemini", key.text.toString())
        assertEquals("✓  Gemini API key", activity.findViewById<TextView>(R.id.keyTitle).text.toString())

        activity.findViewById<RadioButton>(R.id.providerOpenai).performClick()
        assertEquals(Provider.OPENAI, prefs.provider)
        assertEquals("sk-openai", key.text.toString())

        // Each service keeps its own key.
        key.setText("sk-other")
        activity.findViewById<RadioButton>(R.id.providerGemini).performClick()
        assertEquals("AQ.gemini", key.text.toString())
        assertEquals("sk-other", prefs.apiKey)
    }

    @Test
    fun oldInstallWithOnlyAnOpenAIKeyStaysOnIt() {
        val prefs = Prefs(RuntimeEnvironment.getApplication())
        prefs.apiKey = "sk-openai"
        assertEquals(Provider.OPENAI, prefs.provider)
        prefs.geminiKey = "AQ.gemini" // arriving later, through sync
        assertEquals(Provider.OPENAI, prefs.provider)
    }

    @Test
    fun savesTheProxyOnceItReadsAsOne() {
        val prefs = Prefs(RuntimeEnvironment.getApplication())
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val field = activity.findViewById<EditText>(R.id.proxy)
        val status = activity.findViewById<TextView>(R.id.proxyText)
        val remove = activity.findViewById<android.widget.Button>(R.id.proxyRemove)
        assertEquals(true, status.text.startsWith("Direct, no proxy."))
        assertEquals(View.GONE, remove.visibility)
        field.setText("ciao:secret@")
        assertEquals("", prefs.proxy)
        assertEquals(true, status.text.startsWith("That doesn't look like a proxy"))
        field.setText("ciao:secret@212.118.40.237:43129")
        assertEquals("http://ciao:secret@212.118.40.237:43129", prefs.proxy)
        // Shown without the password.
        assertEquals(true, status.text.startsWith("Through ciao@212.118.40.237:43129."))
        assertEquals(false, status.text.contains("secret"))
        remove.performClick()
        assertEquals("", prefs.proxy)
        assertEquals("", field.text.toString())
        assertEquals(true, status.text.startsWith("Direct, no proxy."))
    }

    @Test
    fun aSavedProxyShowsWithoutItsPassword() {
        Prefs(RuntimeEnvironment.getApplication()).proxy = "http://ciao:secret@212.118.40.237:43129"
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        assertEquals("", activity.findViewById<EditText>(R.id.proxy).text.toString())
        assertEquals(true, activity.findViewById<TextView>(R.id.proxyText).text.startsWith("Through ciao@212.118.40.237:43129."))
    }

    @Test
    fun historyListsAndCopiesDictations() {
        val app = RuntimeEnvironment.getApplication()
        val history = History(File(app.filesDir, "history"))
        val e = history.create(Provider.OPENAI)
        history.save(e.plus(History.Transcript(History.Source.LIVE, "gpt-live-transcribe", "Надиктованный текст", 0)).copy(durationMs = 4000))
        val activity = Robolectric.buildActivity(HistoryActivity::class.java).setup().get()
        // The list is read off the main thread.
        val list = findList(activity.window.decorView)
        val deadline = System.currentTimeMillis() + 5000
        while (list.adapter.count == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
            ShadowLooper.idleMainLooper()
        }
        assertEquals(2, list.adapter.count) // the day, then the dictation
        val card = list.adapter.getView(1, null, list)
        findText(card, "Надиктованный текст").performClick()
        assertEquals("Надиктованный текст", app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString())
    }

    @Test
    fun languageAndThemeOverrideTheSystem() {
        val app = RuntimeEnvironment.getApplication()
        val prefs = Prefs(app)
        prefs.language = "ru"
        prefs.theme = "dark"
        val activity = Robolectric.buildActivity(HistoryActivity::class.java).setup().get()
        assertEquals("История", activity.getString(R.string.history_title))
        assertEquals(android.content.res.Configuration.UI_MODE_NIGHT_YES, activity.resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK)
        prefs.language = "en"
        prefs.theme = "system"
        assertEquals("History", Ui.wrap(app).getString(R.string.history_title))
    }

    private fun findText(v: View, text: String): TextView = findAll(v).filterIsInstance<TextView>().first { it.text.toString() == text }

    private fun findAll(v: View): List<View> = listOf(v) + ((v as? android.view.ViewGroup)?.let { g -> (0 until g.childCount).flatMap { findAll(g.getChildAt(it)) } } ?: emptyList())

    private fun findList(v: View): ListView = v as? ListView ?: (v as android.view.ViewGroup).let { g -> (0 until g.childCount).firstNotNullOf { runCatching { findList(g.getChildAt(it)) }.getOrNull() } }
}
