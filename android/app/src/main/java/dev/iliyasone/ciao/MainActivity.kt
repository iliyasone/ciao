package dev.iliyasone.ciao

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.Switch
import android.widget.TextView
import java.text.DateFormat
import java.util.Date

/** Setup (service and key, microphone, accessibility), a field to try it in, sync, the recognition settings, updates. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Ui.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        GoogleSync.load(this)

        // One field for the key of the service picked above it.
        bindText(R.id.apiKey, prefs.currentKey) { s ->
            if (s.filter { it in '!'..'~' } == prefs.currentKey) return@bindText
            if (prefs.provider == Provider.GEMINI) GoogleSync.edit(this) { it.geminiKey = s } else GoogleSync.edit(this) { it.apiKey = s }
            updateStatus()
        }
        val providers = findViewById<RadioGroup>(R.id.provider)
        providers.check(if (prefs.provider == Provider.GEMINI) R.id.providerGemini else R.id.providerOpenai)
        providers.setOnCheckedChangeListener { _, id ->
            prefs.provider = if (id == R.id.providerGemini) Provider.GEMINI else Provider.OPENAI
            findViewById<EditText>(R.id.apiKey).setText(prefs.currentKey)
            showProvider()
        }
        bindSwitch(R.id.smart, prefs.smart) { prefs.smart = it }
        showProvider()
        bindSwitch(R.id.syncKeys, prefs.syncKeys) { on -> GoogleSync.edit(this) { it.syncKeys = on } }
        bindText(R.id.prompt, prefs.prompt) { s -> GoogleSync.edit(this) { it.prompt = s } }
        bindText(R.id.keywords, prefs.keywords.joinToString("\n")) { s -> GoogleSync.edit(this) { it.keywords = s.split("\n") } }
        bindSwitch(R.id.formatText, prefs.formatText) { prefs.formatText = it }
        bindSwitch(R.id.stopPhrase, prefs.stopPhrase) { prefs.stopPhrase = it }
        bindSwitch(R.id.showCost, prefs.showCost) { prefs.showCost = it }
        bindText(R.id.languages, prefs.languages.joinToString(", ")) { s -> prefs.languages = s.split(",") }
        bindSwitch(R.id.autoPaste, prefs.autoPaste) { prefs.autoPaste = it }
        bindSwitch(R.id.restoreClipboard, prefs.restoreClipboard) { prefs.restoreClipboard = it }
        bindSwitch(R.id.telemetry, prefs.telemetry) { prefs.telemetry = it }
        bindSwitch(R.id.showDelay, prefs.showDelay) {
            prefs.showDelay = it
            showProvider()
        }
        findViewById<RadioGroup>(R.id.delay).apply {
            for (d in Prefs.DELAYS) addView(RadioButton(context, null, 0, R.style.Toggle).apply {
                id = View.generateViewId()
                text = d
                tag = d
                layoutParams = RadioGroup.LayoutParams(RadioGroup.LayoutParams.MATCH_PARENT, RadioGroup.LayoutParams.WRAP_CONTENT)
            })
            check(findViewWithTag<RadioButton>(prefs.delay).id)
            setOnCheckedChangeListener { g, id -> prefs.delay = g.findViewById<RadioButton>(id).tag as String }
        }
        // Language and theme apply to every screen and the card: recreate this one to show them.
        bindChoice(R.id.uiLanguage, mapOf("system" to R.id.languageSystem, "ru" to R.id.languageRu, "en" to R.id.languageEn), prefs.language) {
            prefs.language = it
            recreate()
        }
        bindChoice(R.id.theme, mapOf("system" to R.id.themeSystem, "light" to R.id.themeLight, "dark" to R.id.themeDark), prefs.theme) {
            prefs.theme = it
            recreate()
        }

        findViewById<Button>(R.id.syncButton).setOnClickListener {
            if (GoogleSync.status.email != null) GoogleSync.signOut(this) else GoogleSync.signIn(this)
        }
        findViewById<Button>(R.id.micButton).setOnClickListener {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO) + notificationPermission(), 1)
        }
        // The notification with Done and Cancel while you dictate with the screen off (RecordingService).
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED && notificationPermission().isNotEmpty() &&
            checkSelfPermission(notificationPermission()[0]) != PackageManager.PERMISSION_GRANTED
        ) requestPermissions(notificationPermission(), 2)
        findViewById<Button>(R.id.a11yButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.appInfoButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
        findViewById<Button>(R.id.historyButton).setOnClickListener { startActivity(Intent(this, HistoryActivity::class.java)) }
        findViewById<Button>(R.id.checkButton).setOnClickListener { Updater.check(this) }
        findViewById<Button>(R.id.updateButton).setOnClickListener { if (Updater.canConfirm) Updater.confirmAgain(this) else Updater.install(this) }
        findViewById<Button>(R.id.whatsNewButton).setOnClickListener {
            Updater.page?.let { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } }
        }
        findViewById<TextView>(R.id.version).text = getString(R.string.version, packageManager.getPackageInfo(packageName, 0).versionName)
    }

    /** The key card, the Gemini note and the smart-mode switch follow the service picked. */
    private fun showProvider() {
        val p = prefs.provider
        val gemini = p == Provider.GEMINI
        findViewById<TextView>(R.id.keyText).setText(if (gemini) R.string.key_text_gemini else R.string.key_text_openai)
        findViewById<EditText>(R.id.apiKey).setHint(if (gemini) R.string.key_hint_gemini else R.string.key_hint_openai)
        findViewById<TextView>(R.id.geminiNote).visibility = if (gemini) TextView.VISIBLE else TextView.GONE
        findViewById<Switch>(R.id.smart).visibility = if (gemini) Switch.VISIBLE else Switch.GONE
        findViewById<TextView>(R.id.smartHint).visibility = if (gemini) TextView.VISIBLE else TextView.GONE
        // OpenAI only, as on the desktop: Gemini detects the language itself and has no delay level.
        for (id in listOf(R.id.languagesTitle, R.id.languagesText, R.id.languages)) findViewById<View>(id).visibility = if (gemini) View.GONE else View.VISIBLE
        findViewById<View>(R.id.delay).visibility = if (!gemini && prefs.showDelay) View.VISIBLE else View.GONE
        updateStatus()
    }

    private fun showUpdate(s: Updater.State) {
        val card = findViewById<LinearLayout>(R.id.updateCard)
        val version = s.version
        val found = version != null && s.phase in setOf(Updater.Phase.AVAILABLE, Updater.Phase.DOWNLOADING, Updater.Phase.INSTALLING, Updater.Phase.ERROR)
        card.visibility = if (found) LinearLayout.VISIBLE else LinearLayout.GONE
        if (found) {
            findViewById<TextView>(R.id.updateTitle).text = getString(R.string.update_available, version)
            findViewById<TextView>(R.id.updateText).text = s.message ?: when (s.phase) {
                Updater.Phase.DOWNLOADING -> getString(R.string.update_downloading, s.percent)
                Updater.Phase.INSTALLING -> getString(R.string.update_installing)
                else -> getString(R.string.update_available_text)
            }
            findViewById<ProgressBar>(R.id.updateProgress).apply {
                visibility = if (s.phase == Updater.Phase.DOWNLOADING) ProgressBar.VISIBLE else ProgressBar.GONE
                progress = s.percent
            }
            findViewById<Button>(R.id.updateButton).apply {
                text = if (Updater.canConfirm) getString(R.string.update_confirm) else getString(R.string.update_install, version)
                isEnabled = s.phase == Updater.Phase.AVAILABLE || s.phase == Updater.Phase.ERROR || Updater.canConfirm
            }
            findViewById<Button>(R.id.whatsNewButton).visibility = if (Updater.page != null) Button.VISIBLE else Button.GONE
        }
        // Below the version: how the last check went, when there is no update card to say it.
        findViewById<TextView>(R.id.updateStatus).apply {
            val line = when {
                found -> null
                s.phase == Updater.Phase.CHECKING -> getString(R.string.update_checking)
                s.phase == Updater.Phase.LATEST -> s.message ?: getString(R.string.update_latest)
                else -> s.message
            }
            text = line
            visibility = if (line != null) TextView.VISIBLE else TextView.GONE
        }
        findViewById<Button>(R.id.checkButton).isEnabled = s.phase != Updater.Phase.CHECKING && s.phase != Updater.Phase.DOWNLOADING && s.phase != Updater.Phase.INSTALLING
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
        GoogleSync.listener = { showSync(it) }
        // Terms merged from another device (perhaps while this screen was away) replace what the fields show.
        showSynced()
        GoogleSync.applied = { showSynced() }
        showSync(GoogleSync.status)
        GoogleSync.syncNow(this)
        Updater.listener = { showUpdate(it) }
        showUpdate(Updater.state)
        Updater.resume(this)
    }

    override fun onPause() {
        super.onPause()
        GoogleSync.listener = null
        GoogleSync.applied = null
        Updater.listener = null
        Updater.pause(this)
    }

    @Deprecated("Activity result API; this app has no AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == GoogleSync.REQUEST_CODE) GoogleSync.onActivityResult(this, resultCode, data)
    }

    /** Only when they differ: setting a field's text moves its cursor to the start. */
    private fun showSynced() {
        val key = findViewById<EditText>(R.id.apiKey)
        if (key.text.toString().filter { it in '!'..'~' } != prefs.currentKey) key.setText(prefs.currentKey)
        findViewById<Switch>(R.id.syncKeys).apply { if (isChecked != prefs.syncKeys) isChecked = prefs.syncKeys }
        updateStatus()
        val prompt = findViewById<EditText>(R.id.prompt)
        if (prompt.text.toString() != prefs.prompt) prompt.setText(prefs.prompt)
        val keywords = findViewById<EditText>(R.id.keywords)
        if (Sync.normalizeTerms(keywords.text.split("\n")) != Sync.normalizeTerms(prefs.keywords)) keywords.setText(prefs.keywords.joinToString("\n"))
    }

    private fun showSync(s: GoogleSync.Status) {
        val time = DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(s.syncedAt))
        findViewById<TextView>(R.id.syncStatus).text = s.error ?: when {
            s.email == null -> getString(if (s.busy) R.string.sync_signing_in else R.string.sync_text)
            s.busy || s.syncedAt == 0L -> getString(R.string.sync_syncing, s.email)
            else -> getString(R.string.sync_synced, s.email, time)
        }
        findViewById<Button>(R.id.syncButton).apply {
            setText(if (s.email != null) R.string.sync_sign_out else R.string.sync_sign_in)
            isEnabled = s.email != null || !s.busy // not while Google's screen is on its way
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        updateStatus()
    }

    private fun updateStatus() {
        val mic = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        val a11y = accessibilityEnabled()
        mark(R.id.keyTitle, getString(R.string.key_title, prefs.provider.displayName), prefs.currentKey.isNotEmpty())
        mark(R.id.micTitle, getString(R.string.mic_title), mic)
        mark(R.id.a11yTitle, getString(R.string.a11y_title), a11y)
        findViewById<Button>(R.id.micButton).visibility = if (mic) Button.GONE else Button.VISIBLE
        findViewById<Button>(R.id.a11yButton).setText(if (a11y) R.string.a11y_open_again else R.string.a11y_open)
    }

    private fun notificationPermission(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()

    private fun mark(id: Int, title: String, done: Boolean) {
        findViewById<TextView>(id).text = (if (done) "✓  " else "") + title
    }

    private fun accessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(this, CiaoService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    private fun bindText(id: Int, value: String, save: (String) -> Unit) {
        findViewById<EditText>(id).apply {
            setText(value)
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable) = save(s.toString())
            })
        }
    }

    private fun bindChoice(id: Int, buttons: Map<String, Int>, value: String, save: (String) -> Unit) {
        findViewById<RadioGroup>(id).apply {
            check(buttons[value] ?: buttons.values.first())
            setOnCheckedChangeListener { _, checked -> buttons.entries.firstOrNull { it.value == checked }?.let { save(it.key) } }
        }
    }

    @Suppress("UseSwitchCompatOrMaterialCode")
    private fun bindSwitch(id: Int, value: Boolean, save: (Boolean) -> Unit) {
        findViewById<Switch>(id).apply {
            isChecked = value
            setOnCheckedChangeListener { _, on -> save(on) }
        }
    }
}
