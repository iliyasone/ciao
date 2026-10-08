package dev.iliyasone.ciao

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Typeface
import android.os.Bundle
import android.text.Editable
import android.text.TextWatcher
import android.text.format.DateUtils
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.text.DateFormat
import java.util.Calendar
import java.util.Date

/**
 * Every dictation, newest first and by day, as the desktop's history window (src/renderer/history):
 * each with its texts, and buttons to listen, copy, transcribe again (more accurately through the
 * file model, or live), through either service, and delete.
 */
class HistoryActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var history: History
    private lateinit var stats: TextView
    private val player = Player()
    private var all: List<History.Entry> = emptyList()
    private var rows: List<Any> = emptyList()
    private var query = ""
    /** Entries being transcribed again, and how. */
    private val busy = mutableMapOf<String, Retry.Mode>()
    /** The service picked for an entry's retries, when not the one in the settings. */
    private val via = mutableMapOf<String, Provider>()
    private val adapter = Adapter()
    private val density get() = resources.displayMetrics.density
    private fun dp(v: Number) = (v.toFloat() * density).toInt()

    override fun attachBaseContext(base: Context) = super.attachBaseContext(Ui.wrap(base))

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        history = History(File(filesDir, "history"))
        player.listener = { adapter.notifyDataSetChanged() }

        val title = TextView(this).apply {
            setText(R.string.history_title)
            textSize = 22f
            setTextColor(getColor(R.color.fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        stats = TextView(this).apply {
            textSize = 13f
            setTextColor(getColor(R.color.faint))
        }
        val search = EditText(this).apply {
            setHint(R.string.history_search)
            setSingleLine()
            textSize = 15f
            setTextColor(getColor(R.color.fg))
            setHintTextColor(getColor(R.color.ghost))
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
            addTextChangedListener(object : TextWatcher {
                override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
                override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
                override fun afterTextChanged(s: Editable) {
                    query = s.toString().trim()
                    filter()
                }
            })
        }
        val empty = TextView(this).apply {
            textSize = 15f
            setTextColor(getColor(R.color.muted))
            setPadding(0, dp(24), 0, 0)
        }
        val list = ListView(this).apply {
            adapter = this@HistoryActivity.adapter
            divider = null
            dividerHeight = 0
            clipToPadding = false
            setPadding(0, dp(4), 0, dp(40))
            emptyView = empty
            itemsCanFocus = true
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), 0)
            addView(title)
            addView(stats)
            addView(search, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            addView(empty)
            addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        })
        emptyText = empty
    }

    private lateinit var emptyText: TextView

    override fun onResume() {
        super.onResume()
        reload()
    }

    override fun onPause() {
        super.onPause()
        player.stop()
    }

    private fun reload() {
        Thread {
            val entries = history.list()
            runOnUiThread {
                if (isDestroyed) return@runOnUiThread
                all = entries
                filter()
            }
        }.start()
    }

    private fun filter() {
        val shown = if (query.isEmpty()) all else all.filter { e -> e.transcripts.any { it.text.contains(query, ignoreCase = true) } }
        // A day heading before the first entry of each day.
        val r = mutableListOf<Any>()
        var day = ""
        for (e in shown) {
            val d = dayLabel(e.createdAt)
            if (d != day) r += d
            day = d
            r += e
        }
        rows = r
        emptyText.setText(if (all.isEmpty()) R.string.history_empty else R.string.history_nothing_found)
        val today = all.filter { daysAgo(it.createdAt) == 0 }.sumOf { it.durationMs }
        val total = all.sumOf { it.durationMs }
        stats.text = getString(R.string.history_stats, minutes(today), minutes(total))
        adapter.notifyDataSetChanged()
    }

    private fun minutes(ms: Long) = ((ms + 30_000) / 60_000).toInt()

    /** Days since [at], by the calendar: 0 today, 1 yesterday. */
    private fun daysAgo(at: Long): Int {
        fun day(ms: Long) = Calendar.getInstance().apply {
            timeInMillis = ms
            set(Calendar.HOUR_OF_DAY, 0); set(Calendar.MINUTE, 0); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0)
        }.timeInMillis
        return Math.round((day(System.currentTimeMillis()) - day(at)) / DateUtils.DAY_IN_MILLIS.toDouble()).toInt()
    }

    private fun dayLabel(at: Long): String {
        when (daysAgo(at)) {
            0 -> return getString(R.string.history_today)
            1 -> return getString(R.string.history_yesterday)
        }
        val sameYear = Calendar.getInstance().apply { timeInMillis = at }.get(Calendar.YEAR) == Calendar.getInstance().get(Calendar.YEAR)
        return DateUtils.formatDateTime(this, at, DateUtils.FORMAT_SHOW_DATE or (if (sameYear) DateUtils.FORMAT_NO_YEAR else DateUtils.FORMAT_SHOW_YEAR))
    }

    private fun copy(text: String) {
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Ciao", text))
        Toast.makeText(this, R.string.history_copied, Toast.LENGTH_SHORT).show()
    }

    private fun delete(e: History.Entry) {
        AlertDialog.Builder(this)
            .setMessage(R.string.history_confirm_delete)
            .setPositiveButton(R.string.history_delete) { _, _ ->
                if (player.playing == e.id) player.stop()
                history.delete(e.id)
                reload()
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    /** Services with a key; the entry's pick, else the one in the settings. */
    private fun withKey() = Provider.entries.filter { prefs.keyOf(it).isNotEmpty() }
    private fun viaOf(e: History.Entry) = via[e.id] ?: prefs.provider

    private fun retry(e: History.Entry, mode: Retry.Mode, provider: Provider = viaOf(e)) {
        if (e.id in busy) return
        busy[e.id] = mode
        adapter.notifyDataSetChanged()
        Thread {
            val result = runCatching { Retry.run(this, prefs, history, e.id, mode, provider) }
            result.onFailure { err ->
                // Kept with the entry, like a failed dictation, so it shows on its card.
                history.get(e.id)?.let { history.save(it.copy(error = err.message ?: getString(R.string.error_provider, provider.displayName))) }
            }
            runOnUiThread {
                busy -= e.id
                // The other service is offered when this one failed.
                if (result.isFailure) via[e.id] = provider
                if (!isDestroyed) reload()
            }
        }.start()
    }

    private fun status(e: History.Entry): String? = when {
        e.id in busy -> getString(R.string.history_transcribing)
        e.status == History.Status.RECORDING -> getString(R.string.history_recording)
        e.status == History.Status.CANCELLED -> getString(R.string.history_cancelled)
        e.text.isEmpty() -> getString(R.string.history_failed)
        e.delivery == History.Delivery.PASTED -> getString(R.string.history_pasted)
        e.delivery == History.Delivery.CLIPBOARD -> getString(R.string.history_clipboard)
        else -> null
    }

    private fun sourceLabel(t: History.Transcript) = getString(
        when (t.source) {
            History.Source.LIVE -> R.string.history_source_live
            History.Source.RETRY_LIVE -> R.string.history_source_retry_live
            History.Source.RETRY_FILE -> R.string.history_source_retry_file
            History.Source.FORMATTED -> R.string.history_source_formatted
        },
    ) + " · " + t.model

    private fun entryView(e: History.Entry): View {
        val card = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(12), dp(16), dp(6))
            setBackgroundResource(R.drawable.card_bg)
        }
        val s = e.durationMs / 1000
        val meta = listOfNotNull(
            DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(e.createdAt)),
            "%d:%02d".format(s / 60, s % 60),
            e.provider.displayName,
            status(e),
        ).joinToString(" · ")
        card.addView(small(meta, R.color.faint))

        if (e.transcripts.isEmpty()) {
            card.addView(text(getString(R.string.history_no_text), R.color.ghost))
        } else {
            // Newest first: the last one is the text that counts. Tap a text to copy it.
            val labelled = e.transcripts.size > 1
            for ((i, t) in e.transcripts.withIndex().reversed()) {
                if (labelled) card.addView(small(sourceLabel(t), R.color.ghost).apply { setPadding(0, dp(if (i == e.transcripts.lastIndex) 6 else 12), 0, 0) })
                card.addView(text(t.text, if (i == e.transcripts.lastIndex) R.color.fg else R.color.muted).apply {
                    setOnClickListener { copy(t.text) }
                })
            }
        }
        if (e.error != null && e.id !in busy) card.addView(small(e.error, R.color.warn).apply { setPadding(0, dp(6), 0, 0) })

        val actions = FlowLayout(this)
        val audio = history.audioFile(e.id).exists()
        val running = e.status == History.Status.RECORDING
        if (audio && !running) actions.addView(action(if (player.playing == e.id && !player.paused) R.string.history_pause else R.string.history_play) { player.toggle(e.id, history.audioFile(e.id)) })
        if (e.text.isNotEmpty()) actions.addView(action(R.string.history_copy) { copy(e.text) })
        if (audio && !running) {
            val mode = busy[e.id]
            actions.addView(action(R.string.history_retry_file, enabled = mode == null) { retry(e, Retry.Mode.FILE) })
            actions.addView(action(R.string.history_retry_live, enabled = mode == null) { retry(e, Retry.Mode.LIVE) })
            val keys = withKey()
            if (keys.size > 1) {
                val p = viaOf(e)
                actions.addView(action(getString(R.string.history_via, p.displayName)) {
                    via[e.id] = keys.first { it != p }
                    adapter.notifyDataSetChanged()
                })
            }
            // A retry failed: offer the other service, if it has a key.
            val other = keys.firstOrNull { it != viaOf(e) }
            if (e.error != null && mode == null && other != null) {
                actions.addView(action(getString(R.string.history_try_with, other.displayName)) { retry(e, Retry.Mode.FILE, other) })
            }
        }
        if (!running) actions.addView(action(R.string.history_delete_short) { delete(e) })
        card.addView(actions)
        return FrameLayout(this).apply {
            setPadding(0, dp(10), 0, 0)
            addView(card)
        }
    }

    private fun small(s: String, color: Int) = TextView(this).apply {
        text = s
        textSize = 12f
        setTextColor(getColor(color))
    }

    private fun text(s: String, color: Int) = TextView(this).apply {
        text = s
        textSize = 15f
        setTextColor(getColor(color))
        setPadding(0, dp(4), 0, 0)
        setTextIsSelectable(false)
    }

    private fun action(label: Int, enabled: Boolean = true, onClick: () -> Unit) = action(getString(label), enabled, onClick)

    private fun action(label: String, enabled: Boolean = true, onClick: () -> Unit) = Button(this, null, 0, R.style.Action).apply {
        text = label
        isEnabled = enabled
        alpha = if (enabled) 1f else 0.4f
        setOnClickListener { onClick() }
        setPadding(0, 0, dp(16), 0)
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = rows.size
        override fun getItem(position: Int) = rows[position]
        override fun getItemId(position: Int) = position.toLong()
        override fun getViewTypeCount() = 2
        override fun getItemViewType(position: Int) = if (rows[position] is String) 0 else 1
        override fun isEnabled(position: Int) = false

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = when (val row = rows[position]) {
            is String -> (convertView as? TextView ?: TextView(this@HistoryActivity).apply {
                textSize = 13f
                isAllCaps = true
                letterSpacing = 0.06f
                setTextColor(getColor(R.color.faint))
                setPadding(0, dp(20), 0, dp(2))
            }).apply { text = row }
            // Cards differ in their buttons and texts: built afresh, there are few on screen at once.
            else -> entryView(row as History.Entry)
        }
    }
}
