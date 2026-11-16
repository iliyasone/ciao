package dev.iliyasone.ciao

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import java.text.DateFormat
import java.util.Date

/**
 * The settings, in T3 Code's style: a status card that opens the setup when something is missing,
 * then the sections. Opens the setup by itself until it was finished or skipped.
 */
class MainActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var kit: Kit
    private lateinit var key: KeyEditor
    private lateinit var proxy: ProxyEditor

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Ui.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        kit = Kit(this)
        GoogleSync.load(this)
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(16), kit.dp(16), kit.dp(16), kit.dp(40))
        }
        setContentView(ScrollView(this).apply { addView(page) })
        val version = packageManager.getPackageInfo(packageName, 0).versionName

        page.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = kit.dp(48)
            addView(ImageView(this@MainActivity).apply { setImageResource(R.mipmap.ic_launcher) }, LinearLayout.LayoutParams(kit.dp(32), kit.dp(32)).apply { marginEnd = kit.dp(10) })
            addView(kit.text(20f, medium = true, value = getString(R.string.settings_title)), LinearLayout.LayoutParams(0, -2, 1f))
        })

        // Status: all set, or what is missing; opens the setup.
        kit.section(page, null, kit.card().apply {
            id = R.id.statusCard
            kit.add(this, LinearLayout(this@MainActivity).apply {
                gravity = Gravity.CENTER_VERTICAL
                minimumHeight = kit.dp(56)
                setPadding(kit.dp(14), kit.dp(12), kit.dp(14), kit.dp(12))
                setBackgroundResource(kit.selectable())
                setOnClickListener { startActivity(Intent(this@MainActivity, SetupActivity::class.java)) }
                addView(View(this@MainActivity).apply { id = R.id.statusDot; setBackgroundResource(R.drawable.dot) }, LinearLayout.LayoutParams(kit.dp(8), kit.dp(8)).apply { marginEnd = kit.dp(12) })
                addView(LinearLayout(this@MainActivity).apply {
                    orientation = LinearLayout.VERTICAL
                    addView(kit.title("").apply { id = R.id.statusTitle })
                    addView(kit.hint().apply { id = R.id.statusText; setPadding(0, kit.dp(3), 0, 0) })
                }, LinearLayout.LayoutParams(0, -2, 1f))
                addView(kit.icon(R.drawable.ic_chevron_right, R.color.ghost, 16))
            })
        })

        // Update, when there is one.
        page.addView(kit.card().apply {
            id = R.id.updateCard
            visibility = View.GONE
            setPadding(kit.dp(14), kit.dp(12), kit.dp(14), kit.dp(14))
            addView(kit.title("").apply { id = R.id.updateTitle })
            addView(kit.hint().apply { id = R.id.updateText; setPadding(0, kit.dp(3), 0, 0) })
            addView(ProgressBar(this@MainActivity, null, android.R.attr.progressBarStyleHorizontal).apply {
                id = R.id.updateProgress
                max = 100
                progressTintList = ColorStateList.valueOf(kit.color(R.color.accent_strong))
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(8) })
            addView(kit.buttons(
                kit.button("", primary = true, id = R.id.updateButton),
                kit.button(getString(R.string.update_whats_new), primary = false, id = R.id.whatsNewButton),
            ), LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(10) })
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(12) })

        // Recognition
        key = KeyEditor(this, kit) { if (::proxy.isInitialized) updateStatus() }
        proxy = ProxyEditor(this, kit) { key.startCheck() }
        kit.section(page, getString(R.string.section_recognition), kit.card()).apply {
            kit.add(this, kit.row(getString(R.string.row_service), getString(R.string.row_service_text), below = listOf(key.provider)))
            kit.add(this, kit.row(key.title(), null, titleId = R.id.keyTitle, below = listOf(key.text, key.fieldRow, key.status, key.where)))
            // The description sits as close under the title as in the other rows.
            (key.text.layoutParams as LinearLayout.LayoutParams).topMargin = kit.dp(3)
            kit.add(this, kit.row(getString(R.string.proxy_title), getString(R.string.proxy_text), below = listOf(proxy.status, proxy.field, proxy.buttons)))
            kit.add(this, kit.row(getString(R.string.languages_title), getString(R.string.languages_text), below = listOf(
                kit.field(R.id.languages, "ru, en"),
            )).apply { id = R.id.languagesRow })
        }

        // Dictation
        kit.section(page, getString(R.string.section_dictation), kit.card()).apply {
            kit.add(this, kit.switchRow(R.id.autoPaste, getString(R.string.auto_paste), getString(R.string.auto_paste_hint)))
            kit.add(this, kit.switchRow(R.id.restoreClipboard, getString(R.string.restore_clipboard), getString(R.string.restore_clipboard_hint)))
            kit.add(this, kit.switchRow(R.id.stopPhrase, getString(R.string.stop_phrase), getString(R.string.stop_phrase_hint)))
            kit.add(this, kit.switchRow(R.id.pauseMedia, getString(R.string.pause_media), getString(R.string.pause_media_hint)))
            kit.add(this, kit.switchRow(R.id.showCost, getString(R.string.show_cost), getString(R.string.show_cost_hint)))
        }

        // Vocabulary
        kit.section(page, getString(R.string.section_vocabulary), kit.card()).apply {
            kit.add(this, kit.row(getString(R.string.terms_title), getString(R.string.terms_text), below = listOf(kit.field(R.id.keywords, "", lines = 3))))
            kit.add(this, kit.row(getString(R.string.context_title), getString(R.string.context_text), below = listOf(
                kit.field(R.id.prompt, "", lines = 3),
            )).apply { id = R.id.contextRow })
            kit.add(this, kit.switchRow(R.id.learnCorrections, getString(R.string.learn_corrections), getString(R.string.learn_corrections_hint)))
        }

        // Sync
        kit.section(page, getString(R.string.section_sync), kit.card()).apply {
            kit.add(this, kit.row(getString(R.string.sync_title), getString(R.string.sync_text), hintId = R.id.syncStatus,
                below = listOf(kit.button(getString(R.string.sync_sign_in), primary = false, id = R.id.syncButton))))
            kit.add(this, kit.switchRow(R.id.syncKeys, getString(R.string.sync_keys), getString(R.string.sync_keys_hint)))
        }

        // History
        kit.section(page, getString(R.string.section_history), kit.card()).apply {
            kit.add(this, kit.linkRow(getString(R.string.history_title), getString(R.string.history_text)) {
                startActivity(Intent(this@MainActivity, HistoryActivity::class.java))
            }.apply { id = R.id.historyButton })
            kit.add(this, kit.linkRow(getString(R.string.usage_title), getString(R.string.usage_text)) {
                startActivity(Intent(this@MainActivity, UsageActivity::class.java))
            })
            // Android 13+ adds the tile from here; older ones need the shade's edit screen.
            kit.add(this, if (Build.VERSION.SDK_INT >= 33) {
                kit.row(getString(R.string.paste_last), getString(R.string.paste_last_short), kit.button(getString(R.string.paste_last_add), primary = false).apply {
                    minHeight = kit.dp(36)
                    minimumHeight = kit.dp(36)
                    setPadding(kit.dp(12), 0, kit.dp(12), 0)
                    setOnClickListener { addTile() }
                })
            } else {
                kit.row(getString(R.string.paste_last), getString(R.string.paste_last_text))
            })
        }

        // Appearance: language and theme apply to every screen and the card, so this one is recreated.
        kit.section(page, getString(R.string.section_appearance), kit.card()).apply {
            kit.add(this, kit.row(getString(R.string.ui_language), null, kit.select(R.id.uiLanguage, listOf(
                "system" to getString(R.string.system_default), "ru" to "Русский", "en" to "English",
            ), prefs.language) {
                prefs.language = it
                recreate()
            }))
            kit.add(this, kit.row(getString(R.string.theme), null, kit.select(R.id.theme, listOf(
                "system" to getString(R.string.theme_system), "light" to getString(R.string.theme_light), "dark" to getString(R.string.theme_dark),
            ), prefs.theme) {
                prefs.theme = it
                recreate()
            }))
        }

        // About
        kit.section(page, getString(R.string.section_about), kit.card()).apply {
            kit.add(this, kit.row(getString(R.string.version, version), null, kit.button(getString(R.string.update_check_short), primary = false, id = R.id.checkButton).apply {
                minHeight = kit.dp(36)
                minimumHeight = kit.dp(36)
                setPadding(kit.dp(12), 0, kit.dp(12), 0)
                setOnClickListener { Updater.check(this@MainActivity) }
            }, titleId = R.id.version, hintId = R.id.updateStatus))
            kit.add(this, kit.switchRow(R.id.telemetry, getString(R.string.telemetry), getString(R.string.telemetry_hint)))
        }

        // Legacy
        kit.section(page, getString(R.string.section_developer), kit.card()).apply {
            kit.add(this, kit.switchRow(R.id.formatText, getString(R.string.format_text), getString(R.string.format_text_hint)))
            kit.add(this, kit.switchRow(R.id.showDelay, getString(R.string.show_delay), getString(R.string.show_delay_hint)).apply { id = R.id.showDelayRow })
            kit.add(this, kit.row(getString(R.string.delay_title), null, kit.select(R.id.delay, Prefs.DELAYS.map { it to it }, prefs.delay) { prefs.delay = it })
                .apply { id = R.id.delayRow })
        }


        bind()
        // First run, or a run with a required step missing and setup never finished: the steps first.
        if (!prefs.setupDone && Setup.missing(this).isNotEmpty() && savedInstanceState == null) startActivity(Intent(this, SetupActivity::class.java))
    }

    private fun bind() {
        bindSwitch(R.id.syncKeys, prefs.syncKeys) { on -> GoogleSync.edit(this) { it.syncKeys = on } }
        bindText(R.id.prompt, prefs.prompt) { s -> GoogleSync.edit(this) { it.prompt = s } }
        bindText(R.id.keywords, prefs.keywords.joinToString("\n")) { s -> GoogleSync.edit(this) { it.keywords = s.split("\n") } }
        bindSwitch(R.id.learnCorrections, prefs.learnCorrections) { prefs.learnCorrections = it }
        bindSwitch(R.id.formatText, prefs.formatText) { prefs.formatText = it }
        bindSwitch(R.id.stopPhrase, prefs.stopPhrase) { prefs.stopPhrase = it }
        bindSwitch(R.id.pauseMedia, prefs.pauseMedia) { prefs.pauseMedia = it }
        bindSwitch(R.id.showCost, prefs.showCost) { prefs.showCost = it }
        bindText(R.id.languages, prefs.languages.joinToString(", ")) { s -> prefs.languages = s.split(",") }
        bindSwitch(R.id.autoPaste, prefs.autoPaste) { prefs.autoPaste = it }
        bindSwitch(R.id.restoreClipboard, prefs.restoreClipboard) { prefs.restoreClipboard = it }
        bindSwitch(R.id.telemetry, prefs.telemetry) { prefs.telemetry = it }
        bindSwitch(R.id.showDelay, prefs.showDelay) {
            prefs.showDelay = it
            showProvider()
        }
        findViewById<Button>(R.id.syncButton).setOnClickListener {
            if (GoogleSync.status.email != null) GoogleSync.signOut(this) else GoogleSync.signIn(this)
        }
        findViewById<Button>(R.id.updateButton).setOnClickListener { if (Updater.canConfirm) Updater.confirmAgain(this) else Updater.install(this) }
        findViewById<Button>(R.id.whatsNewButton).setOnClickListener {
            Updater.page?.let { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(it))) } }
        }
        showProvider()
    }

    /** The key title, the Gemini note and the OpenAI-only rows follow the service picked. */
    private fun showProvider() {
        val gemini = prefs.provider == Provider.GEMINI
        findViewById<TextView>(R.id.keyTitle).text = key.title()
        // OpenAI only, as on the desktop: Gemini detects the language itself, takes no context and has no delay level.
        findViewById<View>(R.id.contextRow).visibility = if (gemini) View.GONE else View.VISIBLE
        findViewById<View>(R.id.languagesRow).visibility = if (gemini) View.GONE else View.VISIBLE
        findViewById<View>(R.id.showDelayRow).visibility = if (gemini) View.GONE else View.VISIBLE
        findViewById<View>(R.id.delayRow).visibility = if (!gemini && prefs.showDelay) View.VISIBLE else View.GONE
    }

    /** The status card: all set, or the first thing missing, with what is left. */
    private fun updateStatus() {
        if (!::key.isInitialized) return
        showProvider()
        val missing = Setup.missing(this)
        val stopped = Setup.serviceEnabled(this) && CiaoService.instance == null
        val bad = key.state == KeyEditor.State.REJECTED
        val region = key.state == KeyEditor.State.REGION
        val (title, text, color) = when {
            missing.isEmpty() && !bad && !region -> Triple(getString(R.string.status_ready), getString(R.string.status_ready_text), R.color.ok)
            bad -> Triple(getString(R.string.status_problem), getString(R.string.status_bad_key, prefs.provider.displayName), R.color.error)
            region -> Triple(getString(R.string.status_problem), getString(R.string.key_status_region, prefs.provider.displayName), R.color.warn)
            stopped && missing.size == 1 -> Triple(getString(R.string.status_stopped), getString(R.string.status_stopped_text), R.color.error)
            else -> Triple(getString(if (prefs.setupDone) R.string.status_problem else R.string.status_unfinished), getString(R.string.status_left, missing.joinToString(", ")), R.color.warn)
        }
        findViewById<TextView>(R.id.statusTitle).text = title
        findViewById<TextView>(R.id.statusText).text = text
        findViewById<View>(R.id.statusDot).backgroundTintList = ColorStateList.valueOf(kit.color(color))
        findViewById<View>(R.id.statusCard).setBackgroundResource(if (color == R.color.ok) R.drawable.card_bg else R.drawable.card_bg_warn)
    }

    private fun showUpdate(s: Updater.State) {
        val card = findViewById<LinearLayout>(R.id.updateCard)
        val version = s.version
        val found = version != null && s.phase in setOf(Updater.Phase.AVAILABLE, Updater.Phase.DOWNLOADING, Updater.Phase.INSTALLING, Updater.Phase.ERROR)
        card.visibility = if (found) View.VISIBLE else View.GONE
        if (found) {
            findViewById<TextView>(R.id.updateTitle).text = getString(R.string.update_available, version)
            findViewById<TextView>(R.id.updateText).text = s.message ?: when (s.phase) {
                Updater.Phase.DOWNLOADING -> getString(R.string.update_downloading, s.percent)
                Updater.Phase.INSTALLING -> getString(R.string.update_installing)
                else -> getString(R.string.update_available_text)
            }
            findViewById<ProgressBar>(R.id.updateProgress).apply {
                visibility = if (s.phase == Updater.Phase.DOWNLOADING) View.VISIBLE else View.GONE
                progress = s.percent
            }
            findViewById<Button>(R.id.updateButton).apply {
                text = if (Updater.canConfirm) getString(R.string.update_confirm) else getString(R.string.update_install, version)
                isEnabled = s.phase == Updater.Phase.AVAILABLE || s.phase == Updater.Phase.ERROR || Updater.canConfirm
                alpha = if (isEnabled) 1f else 0.4f
            }
            findViewById<Button>(R.id.whatsNewButton).visibility = if (Updater.page != null) View.VISIBLE else View.GONE
        }
        // Under the version: how the last check went, when there is no update card to say it.
        findViewById<TextView>(R.id.updateStatus).apply {
            val line = when {
                found -> null
                s.phase == Updater.Phase.CHECKING -> getString(R.string.update_checking)
                s.phase == Updater.Phase.LATEST -> s.message ?: getString(R.string.update_latest)
                else -> s.message
            }
            text = line
            visibility = if (line != null) View.VISIBLE else View.GONE
        }
        findViewById<Button>(R.id.checkButton).apply {
            isEnabled = s.phase != Updater.Phase.CHECKING && s.phase != Updater.Phase.DOWNLOADING && s.phase != Updater.Phase.INSTALLING
            alpha = if (isEnabled) 1f else 0.4f
        }
    }

    override fun onResume() {
        super.onResume()
        key.refresh()
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
        key.refresh()
        proxy.show()
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
            setText(if (s.email != null) R.string.sync_sign_out_short else R.string.sync_sign_in_short)
            isEnabled = s.email != null || !s.busy // not while Google's screen is on its way
        }
    }

    private fun addTile() {
        if (Build.VERSION.SDK_INT < 33) return
        getSystemService(android.app.StatusBarManager::class.java).requestAddTileService(
            android.content.ComponentName(this, PasteLastTile::class.java),
            getString(R.string.paste_last),
            android.graphics.drawable.Icon.createWithResource(this, R.drawable.ic_clipboard),
            mainExecutor,
        ) {}
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
