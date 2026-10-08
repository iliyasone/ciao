package dev.iliyasone.ciao

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

/**
 * A foreground service for the length of a dictation, so it goes on with the screen off or locked:
 * Android lets an app use the microphone only while its window is on screen or it runs one of these,
 * and keeps such an app alive when memory runs short. Its notification, in the shade and on the
 * lock screen, finishes or cancels the dictation. CiaoService (an accessibility service, which can't
 * be a foreground service itself) starts and stops it.
 */
class RecordingService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_DONE -> CiaoService.instance?.stopFromNotification()
            ACTION_CANCEL -> CiaoService.instance?.cancelFromNotification()
            else -> {
                val n = notification(this, intent?.getBooleanExtra(EXTRA_FINISHING, false) == true, intent?.getLongExtra(EXTRA_STARTED, 0L) ?: 0L)
                // Android 14 throws if it doesn't let us record from here; the dictation then goes on as before.
                runCatching {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
                    else startForeground(ID, n)
                }.onFailure { stopSelf() }
                // The recorder reads the microphone in a loop, and a slow network finishes on its own: keep the CPU up.
                if (wakeLock == null) {
                    wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Ciao:dictation").apply {
                        setReferenceCounted(false)
                        acquire(MAX_WAKE_MS)
                    }
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    companion object {
        private const val ID = 1
        private const val CHANNEL = "dictation"
        private const val ACTION_DONE = "dev.iliyasone.ciao.DONE"
        private const val ACTION_CANCEL = "dev.iliyasone.ciao.CANCEL"
        private const val EXTRA_FINISHING = "finishing"
        private const val EXTRA_STARTED = "started"
        /** A dictation that outlives this has something wrong; the lock must not drain the battery forever. */
        private const val MAX_WAKE_MS = 30 * 60_000L

        /** [startedAt] is wall-clock time, for the notification's timer. */
        fun show(context: Context, startedAt: Long, finishing: Boolean = false) {
            val i = Intent(context, RecordingService::class.java).putExtra(EXTRA_STARTED, startedAt).putExtra(EXTRA_FINISHING, finishing)
            runCatching { context.startForegroundService(i) }
        }

        fun hide(context: Context) {
            context.stopService(Intent(context, RecordingService::class.java))
        }

        fun channel(context: Context) {
            val nm = context.getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, context.getString(R.string.channel_dictation), NotificationManager.IMPORTANCE_LOW).apply {
                setShowBadge(false)
                lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
            nm.createNotificationChannel(NotificationChannel(Recovery.CHANNEL, context.getString(R.string.channel_recovered), NotificationManager.IMPORTANCE_DEFAULT))
        }

        private fun notification(context: Context, finishing: Boolean, startedAt: Long): Notification {
            channel(context)
            fun action(label: Int, action: String) = Notification.Action.Builder(
                null,
                context.getString(label),
                PendingIntent.getService(context, action.hashCode(), Intent(context, RecordingService::class.java).setAction(action), PendingIntent.FLAG_IMMUTABLE),
            ).build()
            val open = PendingIntent.getActivity(context, 0, Intent(context, HistoryActivity::class.java), PendingIntent.FLAG_IMMUTABLE)
            return Notification.Builder(context, CHANNEL)
                .setSmallIcon(R.drawable.ic_notification)
                .setContentTitle(context.getString(if (finishing) R.string.notification_finishing else R.string.notification_recording))
                .setContentIntent(open)
                .setOngoing(true)
                .setCategory(Notification.CATEGORY_SERVICE)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .apply {
                    if (!finishing) {
                        if (startedAt > 0) setWhen(startedAt).setUsesChronometer(true).setShowWhen(true)
                        addAction(action(R.string.done, ACTION_DONE))
                        addAction(action(R.string.cancel, ACTION_CANCEL))
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
                }
                .build()
        }
    }
}
