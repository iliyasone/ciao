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

/** Setup (key, microphone, accessibility), a field to try it in, and the recognition settings. */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        prefs = Prefs(this)

        bindText(R.id.apiKey, prefs.apiKey) {
            prefs.apiKey = it
            updateStatus()
        }
        bindText(R.id.prompt, prefs.prompt) { prefs.prompt = it }
        bindText(R.id.keywords, prefs.keywords.joinToString(", ")) { s -> prefs.keywords = s.split(",", "\n") }
        bindSwitch(R.id.formatText, prefs.formatText) { prefs.formatText = it }
        bindSwitch(R.id.stopPhrase, prefs.stopPhrase) { prefs.stopPhrase = it }
        bindSwitch(R.id.showCost, prefs.showCost) { prefs.showCost = it }

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
