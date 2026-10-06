package dev.iliyasone.ciao

import android.widget.EditText
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
}
