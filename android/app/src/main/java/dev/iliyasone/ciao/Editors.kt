package dev.iliyasone.ciao

import android.app.Activity
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.View
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import java.util.Locale

/**
 * The service and its key, on the setup screen and in the settings: a select for the service, the
 * key field with Paste, and a line under it that says whether the service takes the key. The key is
 * saved as it is typed and checked once it is in (pasted, Done, or a pause after typing): the
 * keyboard goes away and the line answers.
 */
class KeyEditor(private val activity: Activity, private val kit: Kit, private val onChange: () -> Unit) {
    private val prefs = Prefs(activity)
    private val main = Handler(Looper.getMainLooper())

    enum class State { EMPTY, UNCHECKED, CHECKING, WORKS, REJECTED, REGION, OFFLINE }
    var state = State.EMPTY
        private set
    private var reason = ""
    /** The proxy block under the key: opened by hand, or by a check that needs it. */
    var onRegion: (() -> Unit)? = null

    val provider = kit.select(
        R.id.provider,
        Provider.entries.sortedBy { it != Provider.GEMINI }.map { p ->
            val name = activity.getString(if (p == Provider.GEMINI) R.string.provider_gemini else R.string.provider_openai)
            p.id to activity.getString(R.string.provider_option, name, "$" + String.format(Locale.US, "%.2f", p.pricePerMinute * 60))
        },
        prefs.provider.id,
    ) { id ->
        prefs.provider = Provider.entries.first { it.id == id }
        field.setText(prefs.currentKey)
        showProvider()
        startCheck()
    }

    val field: EditText = kit.field(R.id.apiKey, "", mono = true).apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        imeOptions = EditorInfo.IME_ACTION_DONE
        setText(prefs.currentKey)
        setOnEditorActionListener { _, action, _ ->
            if (action == EditorInfo.IME_ACTION_DONE) submit()
            action == EditorInfo.IME_ACTION_DONE
        }
    }
    private val paste = kit.button(activity.getString(R.string.key_paste), primary = false, id = R.id.keyPaste).apply {
        setOnClickListener {
            val clip = activity.getSystemService(ClipboardManager::class.java).primaryClip
            val text = clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(activity)?.toString()?.trim().orEmpty()
            if (text.isEmpty()) {
                Toast.makeText(activity, R.string.key_clipboard_empty, Toast.LENGTH_SHORT).show()
            } else {
                field.setText(text)
                submit()
            }
        }
    }
    val status: TextView = kit.text(13f, R.color.muted).apply { id = R.id.keyStatus }
    val where: TextView = kit.text(13f, R.color.accent, medium = true, value = activity.getString(R.string.key_where)).apply {
        id = R.id.keyWhere
        setPadding(0, kit.dp(4), 0, kit.dp(4))
        setOnClickListener {
            val url = if (prefs.provider == Provider.GEMINI) "https://aistudio.google.com/apikey" else "https://platform.openai.com/api-keys"
            runCatching { activity.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }
        }
    }
    val text: TextView = kit.hint().apply { id = R.id.keyText }

    /** The field with Paste on its right. */
    val fieldRow = LinearLayout(activity).apply {
        gravity = android.view.Gravity.CENTER_VERTICAL
        addView(field, LinearLayout.LayoutParams(0, kit.dp(44), 1f))
        addView(paste, LinearLayout.LayoutParams(-2, kit.dp(44)).apply { marginStart = kit.dp(8) })
    }

    private val autoCheck = Runnable { if (field.text.length >= 20) startCheck() }

    init {
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable) {
                val key = s.toString()
                if (key.filter { it in '!'..'~' } == prefs.currentKey) return
                if (prefs.provider == Provider.GEMINI) GoogleSync.edit(activity) { it.geminiKey = key } else GoogleSync.edit(activity) { it.apiKey = key }
                main.removeCallbacks(autoCheck)
                main.postDelayed(autoCheck, 1200)
                showState(if (prefs.currentKey.isEmpty()) State.EMPTY else State.UNCHECKED)
            }
        })
        showProvider()
    }

    /** The key title for the service picked ("Gemini API key"). */
    fun title() = activity.getString(R.string.key_title, prefs.provider.displayName)

    private fun showProvider() {
        val gemini = prefs.provider == Provider.GEMINI
        text.setText(if (gemini) R.string.key_text_gemini else R.string.key_text_openai)
        field.setHint(if (gemini) R.string.key_hint_gemini else R.string.key_hint_openai)
        showState(when {
            prefs.currentKey.isEmpty() -> State.EMPTY
            prefs.keyVerified(prefs.provider) -> State.WORKS
            else -> State.UNCHECKED
        })
    }

    /** A key arrived through sync, or the screen came back: show it and check it if it isn't yet. */
    fun refresh() {
        if (field.text.toString().filter { it in '!'..'~' } != prefs.currentKey) field.setText(prefs.currentKey)
        showProvider()
        if (state == State.UNCHECKED) startCheck()
    }

    private fun submit() {
        main.removeCallbacks(autoCheck)
        field.clearFocus()
        activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(field.windowToken, 0)
        startCheck()
    }

    fun startCheck() {
        val provider = prefs.provider
        val key = prefs.currentKey
        if (key.isEmpty()) return showState(State.EMPTY)
        showState(State.CHECKING)
        val app = activity.applicationContext
        Thread {
            val result = KeyCheck.check(app, provider, key)
            prefs.setKeyVerified(provider, key, result is KeyCheck.Result.Works)
            main.post {
                // Answered for a key or service no longer in the field: the newer check will answer.
                if (activity.isDestroyed || prefs.provider != provider || prefs.currentKey != key) return@post
                reason = when (result) {
                    is KeyCheck.Result.Works -> ""
                    is KeyCheck.Result.Rejected -> result.reason
                    is KeyCheck.Result.Region -> result.reason
                    is KeyCheck.Result.Offline -> result.reason
                }
                showState(when (result) {
                    is KeyCheck.Result.Works -> State.WORKS
                    is KeyCheck.Result.Rejected -> State.REJECTED
                    is KeyCheck.Result.Region -> State.REGION
                    is KeyCheck.Result.Offline -> State.OFFLINE
                })
                if (result is KeyCheck.Result.Region) onRegion?.invoke()
            }
        }.start()
    }

    private fun showState(s: State) {
        state = s
        val name = prefs.provider.displayName
        status.text = when (s) {
            State.EMPTY -> activity.getString(R.string.key_status_empty)
            State.UNCHECKED -> activity.getString(R.string.key_status_unchecked)
            State.CHECKING -> activity.getString(R.string.key_status_checking)
            State.WORKS -> activity.getString(R.string.key_status_works, name)
            State.REJECTED -> activity.getString(R.string.key_status_rejected, name, reason)
            State.REGION -> activity.getString(R.string.key_status_region, name)
            State.OFFLINE -> activity.getString(R.string.key_status_offline, name, reason)
        }
        status.setTextColor(kit.color(when (s) {
            State.WORKS -> R.color.ok
            State.REJECTED -> R.color.error
            State.REGION, State.OFFLINE -> R.color.warn
            else -> R.color.muted
        }))
        onChange()
    }
}

/**
 * The proxy for the services, as on the desktop: the saved one shows without its password; a new one
 * is typed in, saved with Save, and checked right away.
 */
class ProxyEditor(private val activity: Activity, private val kit: Kit, private val onSaved: () -> Unit = {}) {
    private val prefs = Prefs(activity)
    /** What the last check of the proxy in use found, for that proxy (href); null before one. */
    private var result: Pair<String, String>? = null

    val status: TextView = kit.text(13f, R.color.muted).apply { id = R.id.proxyStatus }
    val field: EditText = kit.field(R.id.proxy, activity.getString(R.string.proxy_hint), mono = true).apply {
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
    }
    private val save = kit.button(activity.getString(R.string.proxy_save), primary = true, id = R.id.proxySave)
    private val check = kit.button(activity.getString(R.string.proxy_check), primary = false, id = R.id.proxyCheck)
    private val remove = kit.button(activity.getString(R.string.proxy_remove), primary = false, id = R.id.proxyRemove)
    val buttons: View = kit.buttons(save, check, remove)

    init {
        field.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable) = show()
        })
        save.setOnClickListener {
            val parsed = ApiProxy.parse(field.text.toString()) ?: return@setOnClickListener
            GoogleSync.edit(activity) { it.proxy = parsed.href }
            field.setText("")
            activity.getSystemService(InputMethodManager::class.java).hideSoftInputFromWindow(field.windowToken, 0)
            Toast.makeText(activity, R.string.proxy_saved, Toast.LENGTH_SHORT).show()
            runCheck()
            onSaved()
        }
        check.setOnClickListener { runCheck() }
        remove.setOnClickListener {
            GoogleSync.edit(activity) { it.proxy = "" }
            field.setText("")
            result = null
            show()
        }
        show()
    }

    /** Checks the saved proxy off the main thread and shows what it found. */
    private fun runCheck() {
        val saved = ApiProxy.parse(prefs.proxy) ?: return
        result = saved.href to activity.getString(R.string.proxy_checking, saved.label)
        show()
        val app = activity.applicationContext
        Thread {
            val text = when (val r = ApiProxy.check(app)) {
                is ApiProxy.Check.Works -> activity.getString(R.string.proxy_works, r.ms)
                ApiProxy.Check.BadLogin -> activity.getString(R.string.proxy_bad_login)
                is ApiProxy.Check.Failed -> activity.getString(R.string.proxy_failed, r.reason)
            }
            activity.runOnUiThread {
                if (activity.isDestroyed || prefs.proxy != saved.href) return@runOnUiThread
                result = saved.href to text
                show()
            }
        }.start()
    }

    /** The proxy in use and its last check, or what's wrong with the one being typed; buttons to match. */
    fun show() {
        val typed = field.text.toString()
        val saved = ApiProxy.parse(prefs.proxy)
        // Removed (here or by a sync): a check of an earlier proxy isn't shown if it comes back.
        if (saved == null) result = null
        val parsed = ApiProxy.parse(typed)
        val lines = mutableListOf(if (saved == null) activity.getString(R.string.proxy_none) else activity.getString(R.string.proxy_via, saved.label))
        result?.takeIf { it.first == saved?.href }?.let { lines += it.second }
        if (typed.isNotBlank() && parsed == null) lines += activity.getString(R.string.proxy_invalid)
        status.text = lines.joinToString("\n")
        // Only once there is something new to save.
        save.isEnabled = parsed != null && parsed.href != prefs.proxy
        save.visibility = if (save.isEnabled) View.VISIBLE else View.GONE
        check.visibility = if (saved != null) View.VISIBLE else View.GONE
        remove.visibility = if (saved != null) View.VISIBLE else View.GONE
    }
}
