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
        val key = activity.findViewById<EditText>(R.id.apiKey)
        assertEquals("sk-openai", key.text.toString())
        assertEquals(View.GONE, activity.findViewById<Switch>(R.id.smart).visibility)

        activity.findViewById<RadioButton>(R.id.providerGemini).performClick()
        assertEquals(Provider.GEMINI, prefs.provider)
        assertEquals("AQ.gemini", key.text.toString())
        assertEquals(View.VISIBLE, activity.findViewById<Switch>(R.id.smart).visibility)
        assertEquals("✓  Gemini API key", activity.findViewById<TextView>(R.id.keyTitle).text.toString())

        // Each service keeps its own key.
        key.setText("AQ.other")
        activity.findViewById<RadioButton>(R.id.providerOpenai).performClick()
        assertEquals("sk-openai", key.text.toString())
        assertEquals("AQ.other", prefs.geminiKey)
    }

    @Test
    fun historyListsAndCopiesDictations() {
        val app = RuntimeEnvironment.getApplication()
        val history = History(File(app.filesDir, "history"))
        val e = history.create(Provider.OPENAI)
        history.save(e.copy(status = History.Status.DONE, text = "Надиктованный текст", durationMs = 4000))
        val activity = Robolectric.buildActivity(HistoryActivity::class.java).setup().get()
        // The list is read off the main thread.
        val list = findList(activity.window.decorView)
        val deadline = System.currentTimeMillis() + 5000
        while (list.adapter.count == 0 && System.currentTimeMillis() < deadline) {
            Thread.sleep(20)
            ShadowLooper.idleMainLooper()
        }
        assertEquals(1, list.adapter.count)
        list.performItemClick(list.adapter.getView(0, null, list), 0, 0)
        assertEquals("Надиктованный текст", app.getSystemService(ClipboardManager::class.java).primaryClip!!.getItemAt(0).text.toString())
    }

    private fun findList(v: View): ListView = v as? ListView ?: (v as android.view.ViewGroup).let { g -> (0 until g.childCount).firstNotNullOf { runCatching { findList(g.getChildAt(it)) }.getOrNull() } }
}
