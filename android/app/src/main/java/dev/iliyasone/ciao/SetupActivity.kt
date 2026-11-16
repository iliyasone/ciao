package dev.iliyasone.ciao

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.SpannableString
import android.text.Spanned
import android.text.style.StyleSpan
import android.view.Gravity
import android.view.View
import android.view.WindowInsets
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast

/**
 * Setting Ciao up, step by step: the key, the microphone, the accessibility service, on some phones
 * running in the background, then a field to try it in with a live check of what the service sees.
 * Opens by itself until setup is finished or skipped; later from the status card in the settings.
 */
class SetupActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var kit: Kit
    private lateinit var key: KeyEditor
    private val main = Handler(Looper.getMainLooper())
    private val steps = mutableListOf<Step>()
    /** The step the user opened by hand; null: the first one not done. */
    private var opened: Step? = null
    private var shownOpen: Step? = null
    private var resumedAt = 0L
    /** When the test field got the focus, and when the activity first saw the keyboard over it. */
    private var focusedAt = 0L
    private var keyboardAt = 0L
    private val tick = object : Runnable {
        override fun run() {
            refresh()
            main.postDelayed(this, 500)
        }
    }

    enum class Mark { UPCOMING, CURRENT, DONE, PROBLEM }

    private inner class Step(val number: Int, val title: String, val required: Boolean) {
        val badge = TextView(this@SetupActivity).apply {
            gravity = Gravity.CENTER
            textSize = 13f
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
            setBackgroundResource(R.drawable.badge)
        }
        val check = kit.icon(R.drawable.ic_check, R.color.ok, 14)
        val badgeBox = android.widget.FrameLayout(this@SetupActivity).apply {
            addView(badge, android.widget.FrameLayout.LayoutParams(kit.dp(24), kit.dp(24)))
            addView(check, android.widget.FrameLayout.LayoutParams(kit.dp(14), kit.dp(14), Gravity.CENTER))
        }
        val titleView = kit.title(title)
        val statusView = kit.text(13f, R.color.muted).apply {
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            gravity = Gravity.END
        }
        val head = LinearLayout(this@SetupActivity).apply {
            gravity = Gravity.CENTER_VERTICAL
            minimumHeight = kit.dp(52)
            setPadding(kit.dp(14), kit.dp(10), kit.dp(14), kit.dp(10))
            addView(badgeBox, LinearLayout.LayoutParams(kit.dp(24), kit.dp(24)).apply { marginEnd = kit.dp(12) })
            addView(titleView, LinearLayout.LayoutParams(-2, -2))
            addView(statusView, LinearLayout.LayoutParams(0, -2, 1f).apply { marginStart = kit.dp(12) })
            setBackgroundResource(kit.selectable())
        }
        val body = LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(14 + 24 + 12), 0, kit.dp(14), kit.dp(16))
            visibility = View.GONE
        }
        val view = LinearLayout(this@SetupActivity).apply {
            orientation = LinearLayout.VERTICAL
            addView(head)
            addView(body)
        }
        var mark = Mark.UPCOMING
        var status: CharSequence = ""
        var statusColor = R.color.muted

        init {
            head.setOnClickListener {
                if (body.visibility == View.VISIBLE) {
                    opened = null
                    collapsed = this
                } else {
                    opened = this
                    collapsed = null
                }
                refresh()
            }
        }

        fun add(v: View, top: Int = 10) = body.addView(v, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(top) })

        fun show(open: Boolean) {
            body.visibility = if (open) View.VISIBLE else View.GONE
            check.visibility = if (mark == Mark.DONE) View.VISIBLE else View.GONE
            badge.text = when (mark) {
                Mark.DONE -> ""
                Mark.PROBLEM -> "!"
                else -> number.toString()
            }
            val (bg, fg) = when (mark) {
                Mark.DONE -> R.color.ok_bg to R.color.ok
                Mark.PROBLEM -> R.color.warn to R.color.on_accent
                Mark.CURRENT -> R.color.fg to R.color.app
                Mark.UPCOMING -> android.R.color.transparent to R.color.muted
            }
            badge.setBackgroundResource(if (mark == Mark.UPCOMING) R.drawable.badge else R.drawable.badge_filled)
            badge.backgroundTintList = if (mark == Mark.UPCOMING) null else ColorStateList.valueOf(kit.color(bg))
            badge.setTextColor(kit.color(fg))
            titleView.setTextColor(kit.color(if (mark == Mark.UPCOMING) R.color.muted else R.color.fg))
            statusView.text = if (open && mark != Mark.DONE) "" else status
            statusView.setTextColor(kit.color(statusColor))
        }
    }
    /** A step the user closed by hand stays closed even when it is the first one not done. */
    private var collapsed: Step? = null

    private lateinit var keyStep: Step
    private lateinit var micStep: Step
    private lateinit var a11yStep: Step
    private var backgroundStep: Step? = null
    private lateinit var tryStep: Step

    private lateinit var micButton: android.widget.Button
    private lateinit var notifyButton: android.widget.Button
    private lateinit var a11yStoppedText: TextView
    private lateinit var a11yButton: android.widget.Button
    private lateinit var proxyBlock: LinearLayout
    private lateinit var proxy: ProxyEditor
    private lateinit var syncBlock: LinearLayout
    private lateinit var batteryLine: TextView
    private lateinit var batteryButton: TextView
    private lateinit var bgConfirm: android.widget.Button
    private lateinit var testField: EditText
    private val diagLines = mutableListOf<Pair<ImageView, TextView>>()
    private lateinit var diagResult: TextView
    private lateinit var doneButton: android.widget.Button

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Ui.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        kit = Kit(this)
        GoogleSync.load(this)
        val page = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(kit.dp(16), kit.dp(20), kit.dp(16), kit.dp(40))
        }
        setContentView(ScrollView(this).apply {
            id = R.id.setupScroll
            isFillViewport = true
            addView(page)
        })

        page.addView(LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            addView(ImageView(this@SetupActivity).apply { setImageResource(R.mipmap.ic_launcher) }, LinearLayout.LayoutParams(kit.dp(40), kit.dp(40)).apply { marginEnd = kit.dp(12) })
            addView(LinearLayout(this@SetupActivity).apply {
                orientation = LinearLayout.VERTICAL
                addView(kit.text(22f, medium = true, value = getString(R.string.setup_title)))
                addView(kit.hint(getString(R.string.setup_subtitle)))
            }, LinearLayout.LayoutParams(0, -2, 1f))
        })

        val card = kit.card()
        kit.section(page, null, card)

        keyStep = Step(1, getString(R.string.setup_key_title), required = true)
        key = KeyEditor(this, kit) { if (::tryStep.isInitialized) refresh() }
        key.onRegion = { proxyBlock.visibility = View.VISIBLE }
        keyStep.add(kit.hint(getString(R.string.setup_key_text)), top = 0)
        keyStep.add(key.provider, top = 12)
        keyStep.add(key.fieldRow, top = 10)
        keyStep.add(key.status, top = 8)
        keyStep.add(key.where, top = 4)
        proxy = ProxyEditor(this, kit) { key.startCheck() }
        proxyBlock = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = if (prefs.proxy.isNotEmpty()) View.VISIBLE else View.GONE
            addView(kit.hint(getString(R.string.proxy_text)))
            addView(proxy.status, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(8) })
            addView(proxy.field, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(8) })
            addView(proxy.buttons, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(8) })
        }
        keyStep.add(fold(getString(R.string.setup_key_proxy)) { proxyBlock.visibility = if (proxyBlock.visibility == View.VISIBLE) View.GONE else View.VISIBLE }, top = 8)
        keyStep.add(proxyBlock, top = 4)
        syncBlock = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(kit.title(getString(R.string.setup_sync_title)))
            addView(kit.hint(getString(R.string.setup_sync_text)))
            addView(kit.button(getString(R.string.sync_sign_in), primary = false).apply {
                id = R.id.setupSyncButton
                setOnClickListener { GoogleSync.signIn(this@SetupActivity) }
            }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(10) })
            // Signing in, or why it failed (Drive access not ticked, say): otherwise no key arrives without a word.
            addView(kit.hint().apply { id = R.id.setupSyncStatus }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(6) })
        }
        keyStep.add(syncBlock, top = 16)

        micStep = Step(2, getString(R.string.mic_title), required = true)
        micStep.add(kit.hint(getString(R.string.mic_text)), top = 0)
        micButton = kit.button(getString(R.string.mic_allow), primary = true).apply { setOnClickListener { askMic() } }
        micStep.add(kit.stack(micButton), top = 12)
        notifyButton = kit.button(getString(R.string.setup_notifications_allow), primary = false).apply {
            setOnClickListener { askNotifications() }
        }
        micStep.add(kit.stack(notifyButton), top = 8)

        a11yStep = Step(3, getString(R.string.setup_a11y_title), required = true)
        a11yStep.add(kit.hint(getString(R.string.setup_a11y_text)), top = 0)
        a11yStoppedText = kit.text(14f, R.color.warn).apply { setLineSpacing(kit.dp(2).toFloat(), 1f) }
        a11yStep.add(a11yStoppedText)
        a11yPath().forEachIndexed { i, line -> a11yStep.add(pathLine(i + 1, line), top = if (i == 0) 12 else 6) }
        a11yButton = kit.button(getString(R.string.setup_a11y_open), primary = true).apply { setOnClickListener { openAccessibility() } }
        a11yStep.add(kit.stack(a11yButton), top = 14)
        a11yStep.add(kit.hint(getString(R.string.setup_a11y_back)), top = 8)
        // The ways round, folded: by hand, the settings search, and the greyed-out switch of Android 13+.
        val help = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = View.GONE
            a11yManual()?.let { addView(kit.hint(it), LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(4) }) }
            addView(kit.hint(getString(R.string.setup_a11y_search)), LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(8) })
            if (Build.VERSION.SDK_INT >= 33) {
                addView(kit.text(14f, medium = true, value = getString(R.string.setup_restricted_title)), LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(14) })
                listOf(R.string.setup_restricted_1, R.string.setup_restricted_2, R.string.setup_restricted_3).forEachIndexed { i, s ->
                    addView(pathLine(i + 1, getString(s)), LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(6) })
                }
                addView(kit.button(getString(R.string.app_info), primary = false).apply { setOnClickListener { Background.appInfo(this@SetupActivity) } },
                    LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(10) })
            }
        }
        a11yStep.add(fold(getString(R.string.setup_trouble)) { help.visibility = if (help.visibility == View.VISIBLE) View.GONE else View.VISIBLE }, top = 8)
        a11yStep.add(help, top = 0)

        if (Background.hasLaunchManager) {
            val step = Step(4, getString(R.string.setup_bg_title), required = false)
            step.add(kit.hint(getString(R.string.setup_bg_text)), top = 0)
            backgroundPath().forEachIndexed { i, line -> step.add(pathLine(i + 1, line), top = if (i == 0) 12 else 6) }
            // The maker's screen can't be read back: the user says when it's done.
            bgConfirm = kit.button(getString(R.string.setup_bg_confirm), primary = false).apply {
                setOnClickListener {
                    prefs.backgroundConfirmed = true
                    refresh()
                }
            }
            step.add(kit.stack(
                kit.button(getString(R.string.setup_bg_open), primary = true).apply { setOnClickListener { Background.openLaunchManager(this@SetupActivity) } },
                bgConfirm,
            ), top = 14)
            // Folded: the way by hand, battery saving off, and the card pinned in the recent apps.
            batteryLine = kit.hint()
            batteryButton = link(getString(R.string.setup_bg_battery_allow)) { Background.askUnrestricted(this@SetupActivity) }
            val help = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                visibility = View.GONE
                addView(kit.hint(getString(backgroundManual())))
                addView(batteryLine, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(10) })
                addView(batteryButton)
                addView(kit.hint(getString(if (Background.maker == Background.Maker.XIAOMI) R.string.hint_recents_xiaomi else R.string.hint_recents_huawei)),
                    LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(4) })
            }
            step.add(fold(getString(R.string.setup_trouble)) { help.visibility = if (help.visibility == View.VISIBLE) View.GONE else View.VISIBLE }, top = 8)
            step.add(help, top = 0)
            backgroundStep = step
        }

        tryStep = Step(if (backgroundStep != null) 5 else 4, getString(R.string.setup_try_title), required = false)
        tryStep.add(kit.hint(getString(R.string.setup_try_text)), top = 0)
        testField = kit.field(R.id.testField, getString(R.string.try_hint), lines = 3).apply {
            setOnFocusChangeListener { _, has ->
                focusedAt = if (has) System.currentTimeMillis() else 0L
                keyboardAt = 0L
            }
        }
        tryStep.add(testField, top = 12)
        for (s in listOf(R.string.diag_enabled, R.string.diag_running, R.string.diag_field, R.string.diag_keyboard, R.string.diag_bubble)) {
            val icon = kit.icon(R.drawable.ic_circle, R.color.ghost, 16)
            val text = kit.text(14f, value = getString(s))
            tryStep.add(LinearLayout(this).apply {
                gravity = Gravity.CENTER_VERTICAL
                addView(icon, LinearLayout.LayoutParams(kit.dp(16), kit.dp(16)).apply { marginEnd = kit.dp(10) })
                addView(text)
            }, top = if (diagLines.isEmpty()) 14 else 6)
            diagLines += icon to text
        }
        diagResult = kit.text(14f).apply { id = R.id.diagResult }
        tryStep.add(diagResult, top = 12)
        doneButton = kit.button(getString(R.string.setup_done), primary = true).apply {
            visibility = View.GONE
            setOnClickListener { finishSetup() }
        }
        tryStep.add(kit.stack(doneButton), top = 14)
        tryStep.add(kit.hint(getString(R.string.setup_copy_report_text)), top = 14)
        tryStep.add(kit.stack(kit.button(getString(R.string.setup_copy_report), primary = false).apply {
            setOnClickListener {
                getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Ciao", report()))
                Toast.makeText(this@SetupActivity, R.string.diag_copied, Toast.LENGTH_SHORT).show()
            }
        }), top = 8)

        steps += listOfNotNull(keyStep, micStep, a11yStep, backgroundStep, tryStep)
        for (s in steps) kit.add(card, s.view)

        page.addView(link(getString(R.string.setup_skip)) { finishSetup() }.apply {
            id = R.id.setupSkip
            gravity = Gravity.CENTER
            setTextColor(kit.color(R.color.muted))
        }, LinearLayout.LayoutParams(-1, -2).apply { topMargin = kit.dp(20) })
        refresh()
    }

    override fun onResume() {
        super.onResume()
        resumedAt = System.currentTimeMillis()
        key.refresh()
        GoogleSync.applied = { key.refresh() }
        GoogleSync.listener = { refresh() }
        main.post(tick)
    }

    override fun onPause() {
        super.onPause()
        GoogleSync.applied = null
        GoogleSync.listener = null
        main.removeCallbacks(tick)
    }

    @Deprecated("Activity result API; this app has no AndroidX")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == GoogleSync.REQUEST_CODE) GoogleSync.onActivityResult(this, resultCode, data)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        // Right after the microphone: the notification with Done and Cancel while the screen is off.
        if (requestCode == 1 && micGranted() && !notificationsGranted()) askNotifications()
        refresh()
    }

    private fun askMic() {
        // Refused twice: Android no longer asks, so the only way left is the app's settings.
        if (prefs.micAsked && !shouldShowRequestPermissionRationale(Manifest.permission.RECORD_AUDIO)) return Background.appInfo(this)
        prefs.micAsked = true
        requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 1)
    }

    private fun askNotifications() {
        // As with the microphone: refused twice, only the app's settings can allow them.
        if (prefs.notificationsAsked && notificationPermission().none { shouldShowRequestPermissionRationale(it) }) return Background.appInfo(this)
        prefs.notificationsAsked = true
        requestPermissions(notificationPermission(), 2)
    }

    private fun openAccessibility() {
        prefs.setupLeftAt = System.currentTimeMillis()
        val name = ComponentName(this, CiaoService::class.java).flattenToString()
        // Pixel and other stock settings scroll to the service named; the rest ignore it.
        val intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
            .putExtra(":settings:fragment_args_key", name)
            .putExtra(":settings:show_fragment_args", Bundle().apply { putString(":settings:fragment_args_key", name) })
        runCatching { startActivity(intent) }
    }

    private fun finishSetup() {
        prefs.setupDone = true
        if (isTaskRoot) startActivity(Intent(this, MainActivity::class.java))
        finish()
    }

    // ── State ────────────────────────────────────────────────────────────

    private fun micGranted() = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
    private fun notificationsGranted() = notificationPermission().all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }
    private fun notificationPermission(): Array<String> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) arrayOf(Manifest.permission.POST_NOTIFICATIONS) else emptyArray()

    /** On in settings, but nothing runs: the phone stopped the service (give it 3 s after coming back to bind). */
    private fun stopped() = Setup.serviceEnabled(this) && CiaoService.instance == null && System.currentTimeMillis() - resumedAt > 3000

    private fun keyboardVisible(): Boolean {
        val root = window.decorView
        if (Build.VERSION.SDK_INT >= 30) return root.rootWindowInsets?.isVisible(WindowInsets.Type.ime()) == true
        val r = android.graphics.Rect().also { root.getWindowVisibleDisplayFrame(it) }
        return root.height - r.bottom > kit.dp(120)
    }

    private fun refresh() {
        // Key
        keyStep.apply {
            mark = when (key.state) {
                KeyEditor.State.WORKS, KeyEditor.State.OFFLINE -> Mark.DONE
                KeyEditor.State.REJECTED, KeyEditor.State.REGION -> Mark.PROBLEM
                else -> Mark.UPCOMING
            }
            status = when (key.state) {
                KeyEditor.State.OFFLINE -> getString(R.string.key_status_saved)
                KeyEditor.State.WORKS -> getString(R.string.key_status_works, prefs.provider.displayName)
                else -> key.status.text
            }
            statusColor = when {
                key.state == KeyEditor.State.OFFLINE -> R.color.warn
                mark == Mark.DONE -> R.color.ok
                mark == Mark.PROBLEM -> R.color.error
                else -> R.color.muted
            }
        }
        val sync = GoogleSync.status
        syncBlock.visibility = if (sync.email == null && GoogleSync.available(this)) View.VISIBLE else View.GONE
        findViewById<View>(R.id.setupSyncButton).isEnabled = !sync.busy
        findViewById<TextView>(R.id.setupSyncStatus).apply {
            text = sync.error ?: if (sync.busy) getString(R.string.sync_signing_in) else ""
            setTextColor(kit.color(if (sync.error != null) R.color.error else R.color.muted))
            visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
        }

        // Microphone
        val mic = micGranted()
        micStep.mark = if (mic) Mark.DONE else Mark.UPCOMING
        micStep.status = getString(if (!mic) R.string.setup_mic_missing else if (notificationsGranted()) R.string.setup_mic_done else R.string.setup_mic_done_no_notifications)
        micStep.statusColor = if (mic) R.color.ok else R.color.muted
        micButton.visibility = if (mic) View.GONE else View.VISIBLE
        notifyButton.visibility = if (mic && !notificationsGranted()) View.VISIBLE else View.GONE

        // Accessibility service
        val enabled = Setup.serviceEnabled(this)
        val running = CiaoService.instance != null
        val stopped = stopped()
        a11yStep.mark = when {
            enabled && running -> Mark.DONE
            stopped -> Mark.PROBLEM
            else -> Mark.UPCOMING
        }
        a11yStep.status = getString(when {
            enabled && running -> R.string.setup_a11y_done
            stopped -> R.string.setup_a11y_stopped
            enabled -> R.string.setup_checking
            else -> R.string.setup_a11y_off
        })
        a11yStep.statusColor = when (a11yStep.mark) { Mark.DONE -> R.color.ok; Mark.PROBLEM -> R.color.warn; else -> R.color.muted }
        a11yStoppedText.visibility = if (stopped) View.VISIBLE else View.GONE
        a11yStoppedText.text = getString(R.string.setup_a11y_stopped_text) + if (backgroundStep != null && !prefs.backgroundConfirmed) "\n" + getString(R.string.setup_a11y_stopped_then) else ""
        a11yButton.setText(if (stopped) R.string.setup_a11y_reopen else R.string.setup_a11y_open)

        // Background
        backgroundStep?.apply {
            mark = if (prefs.backgroundConfirmed) Mark.DONE else Mark.UPCOMING
            // Marked by the user, not checked: said as such, and not in green.
            status = getString(if (prefs.backgroundConfirmed) R.string.setup_bg_done else R.string.setup_bg_not_yet)
            statusColor = R.color.muted
            bgConfirm.visibility = if (prefs.backgroundConfirmed) View.GONE else View.VISIBLE
            val battery = Background.unrestricted(this@SetupActivity)
            batteryLine.text = getString(if (battery) R.string.setup_bg_battery_done else R.string.setup_bg_battery)
            batteryLine.setTextColor(kit.color(if (battery) R.color.ok else R.color.muted))
            batteryButton.visibility = if (battery) View.GONE else View.VISIBLE
        }

        refreshTry(enabled, running, stopped)

        // The step open: the one picked by hand, or the first required one not done, or the test.
        val firstOpen = steps.firstOrNull { it.mark != Mark.DONE && it !== tryStep && (it.required || it === backgroundStep) && it !== collapsed } ?: tryStep.takeIf { it !== collapsed }
        val open = opened ?: firstOpen
        for (s in steps) {
            if (s.mark == Mark.UPCOMING && s === open) s.mark = Mark.CURRENT
            s.show(s === open)
        }
        findViewById<TextView>(R.id.setupSkip).setText(if (open === tryStep) R.string.setup_finish_anyway else R.string.setup_skip)
        if (open != null && open !== shownOpen) {
            shownOpen = open
            // The step that just opened, at the top of the screen.
            findViewById<ScrollView>(R.id.setupScroll).post { findViewById<ScrollView>(R.id.setupScroll).smoothScrollTo(0, (open.view.parent as View).top + open.view.top - kit.dp(12)) }
        }
        // Back from the maker's settings, a step behind it may be done: the next one opens.
        if (opened != null && opened!!.mark == Mark.DONE && opened !== tryStep) opened = null
    }

    private fun refreshTry(enabled: Boolean, running: Boolean, stopped: Boolean) {
        val now = System.currentTimeMillis()
        val focused = testField.hasFocus() && focusedAt > 0
        val keyboard = focused && keyboardVisible()
        if (keyboard && keyboardAt == 0L) keyboardAt = now
        if (!keyboard) keyboardAt = 0L
        // Seen by the service since the field took the focus (its event may come a moment before ours).
        val fieldSeen = focused && Diag.fieldAt >= focusedAt - 1000
        val keyboardSeen = keyboard && Diag.keyboardAt >= keyboardAt - 1000
        val bubble = Diag.bubbleShown
        // Into the field, not onto the clipboard: a clipboard-only delivery is the failure this step is for.
        val worked = Diag.outcomeAt > resumedAt && Diag.outcome == "pasted"
        val clipboard = Diag.outcomeAt > resumedAt && Diag.outcome == "clipboard"
        // null: not known yet.
        val states = listOf<Boolean?>(
            enabled,
            if (!enabled) null else if (running) true else if (stopped) false else null,
            if (!running || !focused) null else if (fieldSeen) true else if (now - focusedAt > 1500) false else null,
            if (!running || !keyboard) null else if (keyboardSeen) true else if (now - keyboardAt > 1500) false else null,
            if (!running || !focused) null else if (bubble) true else if (Diag.bubbleError != null || (fieldSeen && now - focusedAt > 2500)) false else null,
        )
        for ((i, s) in states.withIndex()) {
            val (icon, label) = diagLines[i]
            label.setTextColor(kit.color(if (s == null) R.color.muted else R.color.fg))
            icon.setImageResource(when (s) { true -> R.drawable.ic_check; false -> R.drawable.ic_cross; null -> R.drawable.ic_circle })
            icon.imageTintList = ColorStateList.valueOf(kit.color(when (s) { true -> R.color.ok; false -> R.color.error; null -> R.color.ghost }))
        }
        val (text, color) = when {
            !enabled -> getString(R.string.diag_result_enable) to R.color.warn
            stopped -> getString(R.string.diag_result_stopped) to R.color.warn
            !running -> getString(R.string.setup_checking) to R.color.muted
            worked -> getString(R.string.diag_result_works) to R.color.ok
            clipboard -> getString(if (prefs.autoPaste) R.string.diag_result_clipboard else R.string.diag_result_clipboard_setting) to R.color.warn
            prefs.currentKey.isEmpty() -> getString(R.string.need_key, prefs.provider.displayName) to R.color.warn
            !micGranted() -> getString(R.string.need_mic) to R.color.warn
            !focused -> getString(R.string.diag_result_tap_field) to R.color.muted
            bubble -> getString(R.string.diag_result_tap_bubble) to R.color.ok
            Diag.bubbleError != null -> getString(R.string.diag_result_no_bubble, Diag.bubbleError) to R.color.error
            states[2] == false -> getString(R.string.diag_result_no_field) to R.color.error
            states[4] == false -> getString(R.string.diag_result_no_bubble, getString(R.string.diag_unknown)) to R.color.error
            else -> getString(R.string.setup_checking) to R.color.muted
        }
        diagResult.text = text
        diagResult.setTextColor(kit.color(color))
        // Done once a dictation went in; until then the link under the card finishes without it.
        doneButton.visibility = if (worked) View.VISIBLE else View.GONE
        tryStep.mark = if (worked) Mark.DONE else Mark.UPCOMING
        tryStep.status = if (worked) getString(R.string.setup_try_done) else ""
        tryStep.statusColor = R.color.ok
    }

    /** Plain text for a bug report: the phone, what the service sees, the settings' state. No key, no text. */
    private fun report(): String {
        val ago = { t: Long -> if (t == 0L) "never" else "${(System.currentTimeMillis() - t) / 1000} s ago" }
        val version = packageManager.getPackageInfo(packageName, 0).versionName
        val ime = Settings.Secure.getString(contentResolver, Settings.Secure.DEFAULT_INPUT_METHOD) ?: "-"
        return listOf(
            "Ciao $version · ${Build.MANUFACTURER} ${Build.MODEL} · Android ${Build.VERSION.RELEASE} (SDK ${Build.VERSION.SDK_INT}) · ${Build.DISPLAY}",
            "service: enabled=${Setup.serviceEnabled(this)} running=${CiaoService.instance != null} connected ${ago(Diag.connectedAt)}",
            "field: app=${if (testField.hasFocus()) "focused" else "not focused"} service seen ${ago(Diag.fieldAt)}",
            "keyboard: app=${if (keyboardVisible()) "open" else "closed"} service seen ${ago(Diag.keyboardAt)} · windows: ${Diag.windows.ifEmpty { "-" }} · ime: $ime",
            "bubble: ${if (Diag.bubbleShown) "shown" else "not shown"} · error: ${Diag.bubbleError ?: "-"}",
            "last dictation: ${Diag.outcome ?: "-"} ${if (Diag.outcomeAt > 0) ago(Diag.outcomeAt) else ""}".trim(),
            "battery unrestricted=${Background.unrestricted(this)} · background confirmed=${prefs.backgroundConfirmed}",
            "key: ${prefs.provider.displayName} ${key.state.name.lowercase()} · mic=${micGranted()} · notifications=${notificationsGranted()}",
        ).joinToString("\n")
    }

    // ── Texts ────────────────────────────────────────────────────────────

    private fun a11yPath(): List<String> = when (Background.maker) {
        Background.Maker.HUAWEI, Background.Maker.HONOR -> listOf(R.string.path_a11y_huawei_1, R.string.path_a11y_huawei_2)
        Background.Maker.XIAOMI -> listOf(R.string.path_a11y_xiaomi_1, R.string.path_a11y_xiaomi_2, R.string.path_a11y_xiaomi_3)
        Background.Maker.SAMSUNG -> listOf(R.string.path_a11y_samsung_1, R.string.path_a11y_samsung_2)
        Background.Maker.OTHER -> listOf(R.string.path_a11y_generic_1, R.string.path_a11y_generic_2, R.string.path_a11y_generic_3)
    }.map { getString(it) }

    /** The way to the service by hand, where the maker's menus differ from Android's. */
    private fun a11yManual(): String? = when (Background.maker) {
        Background.Maker.HUAWEI, Background.Maker.HONOR -> getString(R.string.path_a11y_huawei_note)
        Background.Maker.XIAOMI -> getString(R.string.path_a11y_xiaomi_note)
        else -> null
    }

    private fun backgroundPath(): List<String> = when (Background.maker) {
        Background.Maker.XIAOMI -> listOf(R.string.path_bg_xiaomi_1, R.string.path_bg_xiaomi_2)
        else -> listOf(R.string.path_bg_huawei_1, R.string.path_bg_huawei_2, R.string.path_bg_huawei_3)
    }.map { getString(it) }

    private fun backgroundManual() = if (Background.maker == Background.Maker.XIAOMI) R.string.path_bg_xiaomi_note else R.string.path_bg_huawei_note

    /** A numbered line of a path; the «names» (“names”) in it are set in bold, without the quotes. */
    private fun pathLine(n: Int, line: String): View {
        val styled = SpannableString(line.replace(Regex("[«»“”]"), ""))
        var shift = 0
        Regex("[«“]([^»”]+)[»”]").findAll(line).forEach { m ->
            val start = m.range.first - shift
            styled.setSpan(StyleSpan(Typeface.BOLD), start, start + m.groupValues[1].length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
            shift += 2
        }
        return LinearLayout(this).apply {
            addView(kit.text(14f, R.color.muted, value = "$n."), LinearLayout.LayoutParams(kit.dp(20), -2))
            addView(kit.text(14f, value = styled).apply { setLineSpacing(kit.dp(2).toFloat(), 1f) }, LinearLayout.LayoutParams(0, -2, 1f))
        }
    }

    /** A link that opens a block under it. */
    private fun fold(text: String, onClick: () -> Unit) = link("$text ▾", onClick = onClick)

    private fun link(text: String, colorId: Int = R.color.accent_strong, onClick: () -> Unit) = kit.text(14f, colorId, medium = true, value = text).apply {
        setPadding(0, kit.dp(8), 0, kit.dp(8))
        setOnClickListener { onClick() }
    }
}

/** What both screens ask about the setup. */
object Setup {
    fun serviceEnabled(context: Context): Boolean {
        val enabled = Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val me = ComponentName(context, CiaoService::class.java)
        return enabled.split(':').any { ComponentName.unflattenFromString(it) == me }
    }

    /** A required step is missing: the key, the microphone, or the service (off, or on but stopped). */
    fun missing(context: Context): List<String> {
        val prefs = Prefs(context)
        return listOfNotNull(
            context.getString(R.string.setup_key_title).takeIf { prefs.currentKey.isEmpty() },
            context.getString(R.string.mic_title).takeIf { context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED },
            context.getString(R.string.setup_a11y_title).takeIf { !serviceEnabled(context) || CiaoService.instance == null },
        )
    }
}
