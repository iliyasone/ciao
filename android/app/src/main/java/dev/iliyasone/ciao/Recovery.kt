package dev.iliyasone.ciao

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent

/**
 * Dictations cut off by Android killing Ciao (out of memory, say): their audio is in the history
 * up to that moment. When the service comes back, transcribe them and say so in a notification.
 */
object Recovery {
    const val CHANNEL = "recovered"

    /** Blocking; call off the main thread. */
    fun run(context: Context, prefs: Prefs, history: History, entries: List<History.Entry>) {
        for (e in entries) {
            val audio = history.audioFile(e.id)
            if (!audio.exists() || audio.length() < MIN_BYTES) continue
            val provider = e.provider.takeIf { prefs.keyOf(it).isNotEmpty() } ?: prefs.provider
            val text = runCatching { Retry.run(context, prefs, history, e.id, Retry.Mode.FILE, provider).text }.getOrNull()
            notify(context, e, text)
        }
    }

    private fun notify(context: Context, e: History.Entry, text: String?) {
        RecordingService.channel(context)
        val open = PendingIntent.getActivity(context, e.id.hashCode(), Intent(context, HistoryActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(context.getString(if (text.isNullOrEmpty()) R.string.recovered_failed else R.string.recovered))
            .setContentText(text?.takeIf { it.isNotEmpty() } ?: context.getString(R.string.recovered_failed_text))
            .setStyle(Notification.BigTextStyle().bigText(text?.takeIf { it.isNotEmpty() } ?: context.getString(R.string.recovered_failed_text)))
            .setContentIntent(open)
            .setAutoCancel(true)
            .build()
        runCatching { context.getSystemService(NotificationManager::class.java).notify(e.id.hashCode(), n) }
    }

    /** Under half a second: nothing worth transcribing. */
    private const val MIN_BYTES = Recorder.SAMPLE_RATE
}
