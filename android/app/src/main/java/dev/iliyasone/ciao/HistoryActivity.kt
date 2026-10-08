package dev.iliyasone.ciao

import android.app.Activity
import android.app.AlertDialog
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.graphics.Typeface
import android.os.Bundle
import android.text.Editable
import android.text.TextUtils
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import android.widget.Toast
import java.io.File
import java.text.DateFormat
import java.util.Date

/** Every dictation, newest first: tap one to copy it; hold it to share, transcribe again or delete. */
class HistoryActivity : Activity() {
    private lateinit var prefs: Prefs
    private lateinit var history: History
    private var all: List<History.Entry> = emptyList()
    private var shown: List<History.Entry> = emptyList()
    private var query = ""
    /** Entries being transcribed again. */
    private val busy = mutableSetOf<String>()
    private val adapter = Adapter()
    private val density get() = resources.displayMetrics.density
    private fun dp(v: Number) = (v.toFloat() * density).toInt()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        history = History(File(filesDir, "history"))

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
        val title = TextView(this).apply {
            setText(R.string.history_title)
            textSize = 22f
            setTextColor(getColor(R.color.fg))
            typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        }
        val empty = TextView(this).apply {
            id = android.R.id.empty
            setText(R.string.history_empty)
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
            setOnItemClickListener { _, _, position, _ -> copy(shown[position]) }
            setOnItemLongClickListener { _, _, position, _ -> menu(shown[position]); true }
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(28), dp(20), 0)
            addView(title)
            addView(search, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(8) })
            addView(empty)
            addView(list, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
        })
    }

    override fun onResume() {
        super.onResume()
        reload()
    }

    private fun reload() {
        Thread {
            val entries = history.list()
            runOnUiThread {
                all = entries
                filter()
            }
        }.start()
    }

    private fun filter() {
        shown = if (query.isEmpty()) all else all.filter { it.text.contains(query, ignoreCase = true) }
        adapter.notifyDataSetChanged()
    }

    private fun copy(e: History.Entry) {
        if (e.text.isEmpty()) return menu(e)
        getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText("Ciao", e.text))
        Toast.makeText(this, R.string.history_copied, Toast.LENGTH_SHORT).show()
    }

    private fun menu(e: History.Entry) {
        val actions = mutableListOf<Pair<Int, () -> Unit>>()
        if (e.text.isNotEmpty()) {
            actions += R.string.history_copy to { copy(e) }
            actions += R.string.history_share to {
                startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, e.text), null))
            }
        }
        if (history.audioFile(e.id).exists() && e.id !in busy) actions += R.string.history_retry to { retry(e) }
        actions += R.string.history_delete to {
            history.delete(e.id)
            reload()
        }
        AlertDialog.Builder(this)
            .setItems(actions.map { getString(it.first) }.toTypedArray()) { _, i -> actions[i].second() }
            .show()
    }

    /** With the service and key picked now, as on the desktop. */
    private fun retry(e: History.Entry) {
        val provider = prefs.provider
        val key = prefs.keyOf(provider)
        if (key.isEmpty()) {
            Toast.makeText(this, getString(R.string.need_key, provider.displayName), Toast.LENGTH_LONG).show()
            return
        }
        busy += e.id
        adapter.notifyDataSetChanged()
        val smart = prefs.smart
        Thread {
            val result = runCatching { FileTranscriber.transcribe(this, prefs, history.audioFile(e.id).readBytes(), provider, key, smart).trim() }
            result.onSuccess { text ->
                history.get(e.id)?.let { history.save(it.copy(status = if (text.isEmpty()) History.Status.FAILED else History.Status.DONE, text = text, provider = provider)) }
            }
            runOnUiThread {
                busy -= e.id
                result.onFailure { Toast.makeText(this, getString(R.string.failed, it.message ?: getString(R.string.error_provider, provider.displayName)), Toast.LENGTH_LONG).show() }
                result.onSuccess { if (it.isEmpty()) Toast.makeText(this, R.string.nothing_heard, Toast.LENGTH_SHORT).show() }
                if (!isDestroyed) reload()
            }
        }.start()
    }

    private fun meta(e: History.Entry): String {
        val at = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(e.createdAt))
        val s = e.durationMs / 1000
        val parts = mutableListOf(at, "%d:%02d".format(s / 60, s % 60), e.provider.displayName)
        when {
            e.id in busy -> parts += getString(R.string.history_transcribing)
            e.status == History.Status.FAILED -> parts += getString(R.string.history_failed)
            e.status == History.Status.CANCELLED -> parts += getString(R.string.history_cancelled)
            e.status == History.Status.RECORDING -> parts += getString(R.string.history_recording)
            else -> {}
        }
        return parts.joinToString(" · ")
    }

    private inner class Adapter : BaseAdapter() {
        override fun getCount() = shown.size
        override fun getItem(position: Int) = shown[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            // A ListView row has no margin: the gap between the cards is the frame's padding.
            val frame = convertView as? FrameLayout ?: FrameLayout(this@HistoryActivity).apply {
                setPadding(0, dp(10), 0, 0)
                addView(LinearLayout(context).apply {
                    orientation = LinearLayout.VERTICAL
                    setPadding(dp(16), dp(12), dp(16), dp(14))
                    setBackgroundResource(R.drawable.card_bg)
                    addView(TextView(context).apply {
                        textSize = 12f
                        setTextColor(getColor(R.color.faint))
                    })
                    addView(TextView(context).apply {
                        textSize = 15f
                        setPadding(0, dp(4), 0, 0)
                        maxLines = 12
                        ellipsize = TextUtils.TruncateAt.END
                    })
                })
            }
            val card = frame.getChildAt(0) as LinearLayout
            val e = shown[position]
            (card.getChildAt(0) as TextView).text = meta(e)
            (card.getChildAt(1) as TextView).apply {
                text = e.text.ifEmpty { getString(R.string.history_no_text) }
                setTextColor(getColor(if (e.text.isEmpty()) R.color.ghost else R.color.fg))
            }
            return frame
        }
    }
}
