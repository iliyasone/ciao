package dev.iliyasone.ciao

import android.Manifest
import android.app.Activity
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.text.Editable
import android.text.TextWatcher
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import java.text.DateFormat
import java.util.Date

/** Setup (key, microphone, accessibility), a field to try it in, sync, and the recognition settings. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)
        GoogleSync.load(this)

        bindText(R.id.apiKey, prefs.apiKey) {
            prefs.apiKey = it
            updateStatus()
        }
        bindText(R.id.prompt, prefs.prompt) {
            prefs.prompt = it
            GoogleSync.noteLocal(this)
        }
        bindText(R.id.keywords, prefs.keywords.joinToString("\n")) { s ->
            prefs.keywords = s.split("\n")
            GoogleSync.noteLocal(this)
        }
        bindSwitch(R.id.formatText, prefs.formatText) { prefs.formatText = it }
        bindSwitch(R.id.stopPhrase, prefs.stopPhrase) { prefs.stopPhrase = it }
        bindSwitch(R.id.showCost, prefs.showCost) { prefs.showCost = it }

        findViewById<Button>(R.id.syncButton).setOnClickListener {
            if (GoogleSync.status.email != null) GoogleSync.signOut(this) else GoogleSync.signIn(this)
        }
        findViewById<Button>(R.id.micButton).setOnClickListener {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
        }
        findViewById<Button>(R.id.a11yButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        findViewById<Button>(R.id.appInfoButton).setOnClickListener {
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", packageName, null)))
        }
        findViewById<TextView>(R.id.version).text = getString(R.string.version, packageManager.getPackageInfo(packageName, 0).versionName)
    }

    override fun onResume() {
        super.onResume()
        updateStatus()
        GoogleSync.listener = { showSync(it) }
        // Terms merged from another device replace what the fields show.
        GoogleSync.applied = {
            findViewById<EditText>(R.id.prompt).setText(prefs.prompt)
            findViewById<EditText>(R.id.keywords).setText(prefs.keywords.joinToString("\n"))
        }
        showSync(GoogleSync.status)
        GoogleSync.syncNow(this)
    }

    override fun onPause() {
        super.onPause()
        GoogleSync.listener = null
        GoogleSync.applied = null
    }

    @Deprecated("Activity result API; this app has no AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == GoogleSync.REQUEST_CODE) GoogleSync.onActivityResult(this, resultCode, data)
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
        mark(R.id.keyTitle, R.string.key_title, prefs.apiKey.isNotEmpty())
        mark(R.id.micTitle, R.string.mic_title, mic)
        mark(R.id.a11yTitle, R.string.a11y_title, a11y)
        findViewById<Button>(R.id.micButton).visibility = if (mic) Button.GONE else Button.VISIBLE
        findViewById<Button>(R.id.a11yButton).setText(if (a11y) R.string.a11y_open_again else R.string.a11y_open)
    }

    private fun mark(id: Int, title: Int, done: Boolean) {
        findViewById<TextView>(id).text = (if (done) "✓  " else "") + getString(title)
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

    @Suppress("UseSwitchCompatOrMaterialCode")
    private fun bindSwitch(id: Int, value: Boolean, save: (Boolean) -> Unit) {
        findViewById<Switch>(id).apply {
            isChecked = value
            setOnCheckedChangeListener { _, on -> save(on) }
        }
    }
}
