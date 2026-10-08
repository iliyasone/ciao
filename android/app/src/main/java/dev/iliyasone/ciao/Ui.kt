package dev.iliyasone.ciao

import android.content.Context
import android.content.res.Configuration
import java.util.Locale

/**
 * The interface language and theme picked in Ciao, over the system's: every screen and the
 * service wrap their base context with [wrap], as the desktop applies Settings → Appearance.
 */
object Ui {
    fun wrap(base: Context): Context {
        val prefs = Prefs(base)
        val config = Configuration(base.resources.configuration)
        when (prefs.language) {
            "ru", "en" -> config.setLocale(Locale(prefs.language))
        }
        val night = when (prefs.theme) {
            "light" -> Configuration.UI_MODE_NIGHT_NO
            "dark" -> Configuration.UI_MODE_NIGHT_YES
            else -> null
        }
        if (night != null) config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or night
        if (prefs.language == "system" && night == null) return base
        return base.createConfigurationContext(config)
    }
}
