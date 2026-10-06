package dev.iliyasone.ciao

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.api.identity.AuthorizationRequest
import com.google.android.gms.auth.api.identity.AuthorizationResult
import com.google.android.gms.auth.api.identity.Identity
import com.google.android.gms.common.api.Scope
import com.google.android.gms.tasks.Tasks
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Terms and the prompt, synced through one file in the hidden app folder of the user's Google Drive
 * (scope drive.appdata), the same file the desktop app uses (src/main/sync.ts). Google Play
 * services signs in and hands out tokens; the Google Cloud project knows this app by its package
 * name and signing key.
 */
object GoogleSync {
    private const val DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.appdata"
    private const val FILE_NAME = "ciao-sync.json"
    private const val DRIVE = "https://www.googleapis.com/drive/v3/files"
    private const val UPLOAD = "https://www.googleapis.com/upload/drive/v3/files"
    private const val EDIT_DELAY_MS = 2_000L
    /** How often the keyboard showing up triggers a sync. */
    private const val STALE_MS = 10 * 60_000L
    const val REQUEST_CODE = 7301

    private val request = AuthorizationRequest.builder()
        .setRequestedScopes(listOf(Scope(DRIVE_SCOPE), Scope("https://www.googleapis.com/auth/userinfo.email")))
        .build()
    private val http = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    class Status(val email: String?, val busy: Boolean, val syncedAt: Long, val error: String?)

    @Volatile var status = Status(null, false, 0, null)
        private set
    /** The settings screen, while it is open. */
    var listener: ((Status) -> Unit)? = null
    /** Called on the main thread after merged terms and prompt were written to [Prefs]. */
    var applied: (() -> Unit)? = null
    private var lastAttempt = 0L
    private val pending = Any()
    /** Guards the stored history: an edit recorded while a sync is merging must not be lost. */
    private val lock = Any()

    private fun set(context: Context, email: String? = status.email, busy: Boolean = status.busy, syncedAt: Long = status.syncedAt, error: String? = status.error) {
        val prefs = Prefs(context)
        prefs.googleEmail = email ?: ""
        prefs.syncedAt = syncedAt
        status = Status(email, busy, syncedAt, error)
        main.post { listener?.invoke(status) }
    }

    /** Before the first edit: what the settings hold now becomes the history to sync from. */
    fun load(context: Context) {
        val prefs = Prefs(context)
        synchronized(lock) {
            if (prefs.syncState.isEmpty()) prefs.syncState = Sync.serialize(Sync.initialState(prefs.keywords, prefs.prompt))
        }
        status = Status(prefs.googleEmail.ifEmpty { null }, status.busy, prefs.syncedAt, status.error)
    }

    /** Shows Google's consent screen; the answer comes back through [onActivityResult]. */
    fun signIn(activity: Activity) {
        set(activity, busy = true, error = null)
        Identity.getAuthorizationClient(activity).authorize(request)
            .addOnSuccessListener { result ->
                val intent = result.pendingIntent
                if (result.hasResolution() && intent != null) {
                    runCatching { activity.startIntentSenderForResult(intent.intentSender, REQUEST_CODE, null, 0, 0, 0) }
                        .onFailure { failed(activity, it) }
                } else {
                    authorized(activity, result)
                }
            }
            .addOnFailureListener { failed(activity, it) }
    }

    fun onActivityResult(activity: Activity, resultCode: Int, data: Intent?) {
        if (resultCode != Activity.RESULT_OK) return set(activity, busy = false) // closed Google's screen
        runCatching { Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data) }
            .onSuccess { authorized(activity, it) }
            .onFailure { failed(activity, it) }
    }

    private fun failed(context: Context, e: Throwable) {
        android.util.Log.w("Ciao", "google sign-in", e)
        set(context, busy = false, error = context.getString(R.string.sync_sign_in_failed, e.message ?: e.javaClass.simpleName))
    }

    private fun authorized(context: Context, result: AuthorizationResult) {
        val app = context.applicationContext
        // Google's page lists Drive access as a box to tick, unticked at first.
        if (result.grantedScopes.none { it.toString() == DRIVE_SCOPE }) {
            set(app, busy = false, error = app.getString(R.string.sync_sign_in_failed, app.getString(R.string.sync_no_drive)))
            return
        }
        val token = result.accessToken ?: return failed(app, IllegalStateException("no access token"))
        worker.execute {
            runCatching {
                val body = call(Request.Builder().url("https://www.googleapis.com/oauth2/v3/userinfo").header("Authorization", "Bearer $token").build())
                JSONObject(body).getString("email")
            }.onSuccess { email ->
                set(app, email = email)
                syncOnce(app)
            }.onFailure { failed(app, it) }
        }
    }

    /**
     * Stops syncing on this phone; the terms stay. Not a revoke: Google keeps one grant per app and
     * account, so revoking would sign out every other device too.
     */
    fun signOut(context: Context) {
        set(context.applicationContext, email = null, busy = false, syncedAt = 0, error = null)
    }

    /** The user changed terms or the prompt in [Prefs]: record it, and send it shortly. */
    fun noteLocal(context: Context) {
        val app = context.applicationContext
        val prefs = Prefs(app)
        synchronized(lock) {
            val next = Sync.recordEdit(state(prefs), prefs.keywords, prefs.prompt, System.currentTimeMillis()) ?: return
            prefs.syncState = Sync.serialize(next)
        }
        main.removeCallbacksAndMessages(pending)
        main.postAtTime({ syncNow(app) }, pending, android.os.SystemClock.uptimeMillis() + EDIT_DELAY_MS)
    }

    /** From the dictation service: sync when the keyboard shows up, at most every few minutes. */
    fun syncIfStale(context: Context) {
        val now = System.currentTimeMillis()
        if (now - lastAttempt < STALE_MS) return
        syncNow(context)
    }

    fun syncNow(context: Context) {
        val app = context.applicationContext
        if (Prefs(app).googleEmail.isEmpty()) return
        lastAttempt = System.currentTimeMillis()
        worker.execute { syncOnce(app) }
    }

    /** What this device knows; on first use, what the settings hold now (older than any edit to come). */
    private fun state(prefs: Prefs): SyncState =
        prefs.syncState.takeIf { it.isNotEmpty() }?.let { Sync.parse(it) } ?: Sync.initialState(prefs.keywords, prefs.prompt)

    /** On the worker thread. */
    private fun syncOnce(app: Context) {
        val prefs = Prefs(app)
        if (prefs.googleEmail.isEmpty()) return
        set(app, busy = true)
        try {
            var token = token(app)
            fun drive(build: Request.Builder): String {
                return try {
                    call(build.header("Authorization", "Bearer $token").build())
                } catch (e: Unauthorized) {
                    // Expired early, or revoked: a fresh token tells which.
                    GoogleAuthUtil.clearToken(app, token)
                    token = token(app)
                    call(build.header("Authorization", "Bearer $token").build())
                }
            }
            val query = "name='$FILE_NAME'"
            val list = JSONObject(drive(Request.Builder().url("$DRIVE?spaces=appDataFolder&q=${java.net.URLEncoder.encode(query, "UTF-8")}&orderBy=createdTime&fields=files(id)")))
                .getJSONArray("files")
            val ids = (0 until list.length()).map { list.getJSONObject(it).getString("id") }
            // Two devices that synced for the first time at once may each have created the file.
            var remote: SyncState? = null
            for (id in ids) {
                // Written by a newer Ciao: leave it alone rather than overwrite what this one can't read.
                val parsed = Sync.parse(drive(Request.Builder().url("$DRIVE/$id?alt=media"))) ?: throw Exception(app.getString(R.string.sync_newer_format))
                remote = remote?.let { Sync.mergeStates(it, parsed) } ?: parsed
            }
            val merged = synchronized(lock) {
                val local = state(prefs)
                val merged = remote?.let { Sync.mergeStates(local, it) } ?: local
                if (!Sync.sameState(merged, local)) {
                    prefs.keywords = Sync.termsOf(merged)
                    prefs.prompt = merged.prompt.value
                    main.post { applied?.invoke() }
                }
                prefs.syncState = Sync.serialize(merged)
                merged
            }
            if (remote == null || !Sync.sameState(merged, remote) || ids.size > 1) {
                val json = "application/json".toMediaType()
                val body = Sync.serialize(merged).toRequestBody(json)
                if (ids.isNotEmpty()) {
                    drive(Request.Builder().url("$UPLOAD/${ids[0]}?uploadType=media").patch(body))
                } else {
                    val meta = JSONObject().put("name", FILE_NAME).put("parents", org.json.JSONArray().put("appDataFolder")).toString()
                    val multipart = MultipartBody.Builder().setType("multipart/related".toMediaType())
                        .addPart(meta.toRequestBody(json))
                        .addPart(body)
                        .build()
                    drive(Request.Builder().url("$UPLOAD?uploadType=multipart").post(multipart))
                }
                for (id in ids.drop(1)) drive(Request.Builder().url("$DRIVE/$id").delete())
            }
            set(app, busy = false, syncedAt = System.currentTimeMillis(), error = null)
        } catch (e: SignedOut) {
            android.util.Log.w("Ciao", "google sync: access gone, signing out")
            set(app, email = null, busy = false, syncedAt = 0, error = app.getString(R.string.sync_signed_out))
        } catch (e: Exception) {
            android.util.Log.w("Ciao", "google sync", e)
            set(app, busy = false, error = app.getString(R.string.sync_failed, e.message ?: e.javaClass.simpleName))
        }
    }

    private class Unauthorized : Exception()
    private class SignedOut : Exception()

    /** A token without asking: Play services refreshes it; if the user must consent again, that's a sign-out. */
    private fun token(app: Context): String {
        val result = Tasks.await(Identity.getAuthorizationClient(app).authorize(request), 30, TimeUnit.SECONDS)
        if (result.hasResolution() || result.grantedScopes.none { it.toString() == DRIVE_SCOPE }) throw SignedOut()
        return result.accessToken ?: throw SignedOut()
    }

    private fun call(request: Request): String = http.newCall(request).execute().use { res ->
        val text = res.body?.string().orEmpty()
        if (res.code == 401) throw Unauthorized()
        if (!res.isSuccessful) throw Exception("Google ${res.code}: ${text.take(200)}")
        text
    }
}
