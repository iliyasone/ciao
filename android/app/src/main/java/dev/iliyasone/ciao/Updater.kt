package dev.iliyasone.ciao

import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.UnknownHostException
import java.util.concurrent.Executors

/**
 * Updates from GitHub Releases, like the desktop app's (src/main/updater.ts): the settings screen
 * checks for a newer release when it opens (at most every few hours), and "Update" downloads its APK
 * and hands it to Android's package installer, which asks the user to confirm and installs it over
 * this one. Android allows that only once the user lets Ciao install apps; the first update asks.
 * Nothing is downloaded on its own.
 */
object Updater {
    private const val LATEST = "https://api.github.com/repos/iliyasone/ciao/releases/latest"
    private const val CHECK_EVERY_MS = 4 * 60 * 60_000L

    enum class Phase { IDLE, CHECKING, LATEST, AVAILABLE, DOWNLOADING, INSTALLING, ERROR }

    /** [version]: the release found. [message]: why the last step failed, or what it waits for. */
    data class State(val phase: Phase, val version: String? = null, val percent: Int = 0, val message: String? = null)

    /** [apk]: null while the release has no APK yet (it is still being built). */
    private class Release(val version: String, val apk: String?, val size: Long, val page: String)

    @Volatile var state = State(Phase.IDLE)
        private set
    /** The settings screen, while it is open. */
    var listener: ((State) -> Unit)? = null
    /** Release notes of the version found. */
    val page: String? get() = release?.page

    @Volatile private var release: Release? = null
    /** The installer's confirmation screen, waiting for the settings screen to come back to show it. */
    private var confirm: Intent? = null
    /** The last confirmation screen shown: shown again if the user left it without answering. */
    private var lastAsk: Intent? = null
    /**
     * The settings screen was hidden (Home, another app), not just covered by the confirmation
     * dialog: only then is a confirmation left unanswered, rather than one whose Cancel is on its way.
     */
    private var leftScreen = false
    /** Install as soon as the release is found again: the process was restarted while the user allowed installs. */
    @Volatile private var installWhenFound = false
    /** The installer session waiting for the user's confirmation. */
    private var sessionId = -1
    private var foreground: Activity? = null
    // Lazy, so the unit tests (no Android main loop) can load this object.
    private val worker by lazy { Executors.newSingleThreadExecutor() }
    private val main by lazy { Handler(Looper.getMainLooper()) }

    private fun set(next: State) {
        state = next
        main.post { listener?.invoke(next) }
    }

    /** 0.10.0 is newer than 0.9.9; a tag that isn't X.Y.Z is never newer. */
    fun newer(tag: String, current: String): Boolean {
        fun parts(v: String) = Regex("^v?(\\d+)\\.(\\d+)\\.(\\d+)").find(v.trim())?.groupValues?.drop(1)?.map { it.toInt() }
        val a = parts(tag) ?: return false
        val b = parts(current) ?: return false
        for (i in 0..2) if (a[i] != b[i]) return a[i] > b[i]
        return false
    }

    private fun current(context: Context): String = context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: "0.0.0"

    /** The settings screen came up: show a pending confirmation, finish what a permission held up, check if it's time. */
    fun resume(activity: Activity) {
        foreground = activity
        val wasAway = leftScreen
        leftScreen = false
        val pending = confirm
        confirm = null
        if (pending != null) runCatching { activity.startActivity(pending) }
        else if (state.phase == Phase.INSTALLING && sessionId >= 0) {
            if (activity.packageManager.packageInstaller.getSessionInfo(sessionId) == null) {
                // Some installers close without reporting back: don't leave the buttons disabled.
                sessionId = -1
                lastAsk = null
                set(State(Phase.AVAILABLE, release?.version))
            } else {
                // Still waiting for an answer (the user went Home from the confirmation): ask again.
                if (wasAway) lastAsk?.let { runCatching { activity.startActivity(it) } }
            }
        }
        val prefs = Prefs(activity)
        // Kept in prefs: Android may restart Ciao when the user changes "Install unknown apps".
        if (prefs.updateAfterPermission) {
            prefs.updateAfterPermission = false
            if (!activity.packageManager.canRequestPackageInstalls()) set(state.copy(message = activity.getString(R.string.update_allow)))
            else if (release != null) install(activity)
            else {
                installWhenFound = true
                check(activity, manual = false)
            }
        }
        // A found update isn't stamped as checked (Updater.check), so a new process finds it again.
        if (release == null && System.currentTimeMillis() - prefs.updateCheckedAt > CHECK_EVERY_MS) check(activity, manual = false)
    }

    fun pause(activity: Activity) {
        if (foreground === activity) foreground = null
    }

    fun stop() {
        leftScreen = true
    }

    /**
     * [manual]: the user pressed "Check": only then is a failure shown (offline is normal in the
     * background). A background check leaves an update already found alone, so its button stays.
     */
    fun check(context: Context, manual: Boolean = true) {
        val before = state
        if (before.phase == Phase.CHECKING || before.phase == Phase.DOWNLOADING || before.phase == Phase.INSTALLING) return
        if (!manual && release != null) return
        val app = context.applicationContext
        set(State(Phase.CHECKING))
        worker.execute {
            try {
                val found = fetchLatest(app)
                if (found != null && newer(found.version, current(app)) && found.apk != null) {
                    release = found
                    set(State(Phase.AVAILABLE, found.version))
                    main.post {
                        val screen = foreground
                        if (installWhenFound && screen != null) install(screen)
                        installWhenFound = false
                    }
                } else {
                    release = null
                    installWhenFound = false
                    if (found != null && newer(found.version, current(app))) {
                        // Published, but its APK is still being uploaded: look again next time.
                        set(State(Phase.LATEST, message = app.getString(R.string.update_building, found.version)))
                    } else {
                        Prefs(app).updateCheckedAt = System.currentTimeMillis()
                        set(State(Phase.LATEST))
                    }
                }
            } catch (e: Exception) {
                installWhenFound = false
                val reason = if (e is IOException) describe(app, e) else e.message ?: e.javaClass.simpleName
                set(if (manual) State(Phase.ERROR, release?.version, message = app.getString(R.string.update_check_failed, reason)) else before)
            }
        }
    }

    /** The latest published release; null if its tag has no version. */
    private fun fetchLatest(context: Context): Release? {
        val request = Request.Builder().url(LATEST).header("Accept", "application/vnd.github+json").build()
        http.newCall(request).execute().use { res ->
            if (res.code == 404) throw IOException(context.getString(R.string.update_no_releases))
            if (!res.isSuccessful) throw IOException(context.getString(R.string.update_github_status, res.code))
            val json = runCatching { JSONObject(res.body!!.string()) }.getOrNull() ?: throw IOException(context.getString(R.string.update_github_status, res.code))
            val version = json.optString("tag_name").removePrefix("v").takeIf { it.isNotEmpty() } ?: return null
            val page = json.optString("html_url")
            val assets = json.optJSONArray("assets")
            for (i in 0 until (assets?.length() ?: 0)) {
                val a = assets!!.optJSONObject(i) ?: continue
                val url = a.optString("browser_download_url")
                if (a.optString("name") == "Ciao-$version.apk" && url.startsWith("https://")) return Release(version, url, a.optLong("size"), page)
            }
            return Release(version, null, 0, page)
        }
    }

    /** Download the APK found and hand it to the installer; first, if needed, ask to be allowed to install apps. */
    fun install(activity: Activity) {
        val r = release ?: return
        if (state.phase == Phase.DOWNLOADING || state.phase == Phase.INSTALLING || state.phase == Phase.CHECKING) return
        if (!activity.packageManager.canRequestPackageInstalls()) {
            val prefs = Prefs(activity)
            prefs.updateAfterPermission = true
            runCatching {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            }.onFailure {
                prefs.updateAfterPermission = false
                set(state.copy(message = activity.getString(R.string.update_allow)))
            }
            return
        }
        val app = activity.applicationContext
        set(State(Phase.DOWNLOADING, r.version, 0))
        worker.execute {
            try {
                val apk = download(app, r)
                set(State(Phase.INSTALLING, r.version))
                commit(app, apk)
            } catch (e: Exception) {
                val reason = if (e is IOException) describe(app, e) else e.message ?: e.javaClass.simpleName
                set(State(Phase.ERROR, r.version, message = app.getString(R.string.update_failed, reason)))
            }
        }
    }

    private fun download(context: Context, r: Release): File {
        val dir = File(context.cacheDir, "updates")
        val apk = File(dir, "Ciao-${r.version}.apk")
        if (apk.length() == r.size && r.size > 0) return apk
        // Older downloads, and a half-finished one.
        dir.deleteRecursively()
        dir.mkdirs()
        val part = File(dir, "${apk.name}.part")
        http.newCall(Request.Builder().url(r.apk!!).build()).execute().use { res ->
            if (!res.isSuccessful) throw IOException(context.getString(R.string.update_github_status, res.code))
            val body = res.body ?: throw IOException(context.getString(R.string.update_github_status, res.code))
            val total = body.contentLength().takeIf { it > 0 } ?: r.size
            body.byteStream().use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    var done = 0L
                    var shown = -1
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        done += n
                        val percent = if (total > 0) (done * 100 / total).toInt().coerceIn(0, 100) else 0
                        if (percent != shown) {
                            shown = percent
                            set(State(Phase.DOWNLOADING, r.version, percent))
                        }
                    }
                }
            }
        }
        if (r.size > 0 && part.length() != r.size) {
            part.delete()
            throw IOException(context.getString(R.string.update_incomplete))
        }
        if (!part.renameTo(apk)) throw IOException(context.getString(R.string.update_incomplete))
        return apk
    }

    /** Android checks that the APK is signed with the same key as this app, then asks the user to confirm. */
    private fun commit(context: Context, apk: File) {
        val installer = context.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(context.packageName)
        params.setSize(apk.length())
        val id = installer.createSession(params)
        try {
            installer.openSession(id).use { session ->
                session.openWrite("ciao.apk", 0, apk.length()).use { out ->
                    apk.inputStream().use { it.copyTo(out) }
                    session.fsync(out)
                }
                val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
                val intent = PendingIntent.getBroadcast(context, id, Intent(context, UpdateReceiver::class.java), flags)
                main.post { sessionId = id }
                session.commit(intent.intentSender)
            }
        } catch (e: Exception) {
            runCatching { installer.abandonSession(id) }
            throw IOException(e.message ?: e.javaClass.simpleName, e)
        }
    }

    /** What the installer reports back (UpdateReceiver). */
    fun onStatus(context: Context, intent: Intent) {
        val version = release?.version ?: state.version
        when (intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
            PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                @Suppress("DEPRECATION")
                val ask = (intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT) ?: return).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                lastAsk = ask
                // Android shows another app's screen only over our own, not from the background.
                val screen = foreground
                if (screen != null) runCatching { screen.startActivity(ask) }.onFailure { confirm = ask }
                else confirm = ask
            }
            // Usually never seen: Android stops this app to replace it.
            PackageInstaller.STATUS_SUCCESS -> {
                sessionId = -1
                lastAsk = null
                set(State(Phase.IDLE))
            }
            PackageInstaller.STATUS_FAILURE_ABORTED -> {
                sessionId = -1
                lastAsk = null
                set(State(Phase.AVAILABLE, version))
            }
            else -> {
                sessionId = -1
                lastAsk = null
                val reason = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: context.getString(R.string.update_install_failed)
                set(State(Phase.ERROR, version, message = context.getString(R.string.update_failed, reason)))
            }
        }
    }

    private fun describe(context: Context, e: IOException): String = when {
        e is UnknownHostException || e.cause is UnknownHostException -> context.getString(R.string.update_offline)
        else -> e.message ?: e.javaClass.simpleName
    }
}

/** Receives the package installer's progress for an update ([Updater.commit]). */
class UpdateReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) = Updater.onStatus(context, intent)
}
