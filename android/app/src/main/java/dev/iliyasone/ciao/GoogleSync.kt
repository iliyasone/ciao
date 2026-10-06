package dev.iliyasone.ciao

import android.accounts.Account
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
 * Terms, the prompt and the API keys, synced through one file in the hidden app folder of the user's Google Drive
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

    private val scopes = listOf(Scope(DRIVE_SCOPE), Scope("https://www.googleapis.com/auth/userinfo.email"))
    /** At sign-in: Google asks which account. */
    private val request = AuthorizationRequest.builder().setRequestedScopes(scopes).build()
    /** Afterwards: that account's token, so a phone with several accounts doesn't ask again. */
    private fun requestFor(email: String) = AuthorizationRequest.builder().setRequestedScopes(scopes).setAccount(Account(email, "com.google")).build()
    private val http = OkHttpClient.Builder().callTimeout(30, TimeUnit.SECONDS).build()
    private val worker = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())

    data class Status(val email: String?, val busy: Boolean, val syncedAt: Long, val error: String?)

    @Volatile var status = Status(null, false, 0, null)
        private set
    /** The settings screen, while it is open. */
    var listener: ((Status) -> Unit)? = null
    /** Called on the main thread after merged terms and prompt were written to [Prefs]. */
    var applied: (() -> Unit)? = null
    @Volatile private var lastAttempt = 0L
    private val pending = Any()
    /** Guards the stored history: an edit recorded while a sync is merging must not be lost. */
    private val lock = Any()

    /** [change] sees the current status, so a sync that finishes after a sign-out can't undo it. */
    @Synchronized
    private fun set(context: Context, change: Status.() -> Status) {
        val next = status.change()
        val prefs = Prefs(context)
        prefs.googleEmail = next.email ?: ""
        prefs.syncedAt = next.syncedAt
        status = next
        main.post { listener?.invoke(next) }
    }

    /** For the sync of [account]: changes the status only if that account is still the signed-in one. */
    private fun setFor(context: Context, account: String, change: Status.() -> Status) = set(context) { if (email == account) change() else this }

    /** Before the first edit: what the settings hold now becomes the history to sync from. */
    fun load(context: Context) {
        val prefs = Prefs(context)
        synchronized(lock) {
            val saved = prefs.syncState.takeIf { it.isNotEmpty() }?.let { Sync.parse(it) }
            val state = saved?.let { Sync.adoptKeys(it, prefs.local().keys) } ?: Sync.initialState(prefs.local(), Prefs.DEFAULT_KEYWORDS, Prefs.DEFAULT_PROMPT)
            if (state != saved) prefs.syncState = Sync.serialize(state)
        }
        set(context) { copy(email = prefs.googleEmail.ifEmpty { null }, syncedAt = prefs.syncedAt) }
    }

    /** Shows Google's consent screen; the answer comes back through [onActivityResult]. */
    fun signIn(activity: Activity) {
        set(activity) { copy(busy = true, error = null) }
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
        if (resultCode != Activity.RESULT_OK) return set(activity) { copy(busy = false) } // closed Google's screen
        runCatching { Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(data) }
            .onSuccess { authorized(activity, it) }
            .onFailure { failed(activity, it) }
    }

    private fun failed(context: Context, e: Throwable) {
        android.util.Log.w("Ciao", "google sign-in", e)
        set(context) { copy(busy = false, error = context.getString(R.string.sync_sign_in_failed, e.message ?: e.javaClass.simpleName)) }
    }

    private fun authorized(context: Context, result: AuthorizationResult) {
        val app = context.applicationContext
        // Google's page lists Drive access as a box to tick, unticked at first.
        if (result.grantedScopes.none { it.toString() == DRIVE_SCOPE }) {
            set(app) { copy(busy = false, error = app.getString(R.string.sync_sign_in_failed, app.getString(R.string.sync_no_drive))) }
            return
        }
        val token = result.accessToken ?: return failed(app, IllegalStateException("no access token"))
        worker.execute {
            runCatching {
                val body = call(Request.Builder().url("https://www.googleapis.com/oauth2/v3/userinfo").header("Authorization", "Bearer $token").build())
                JSONObject(body).getString("email")
            }.onSuccess { email ->
                set(app) { copy(email = email) }
                syncOnce(app)
            }.onFailure { failed(app, it) }
        }
    }

    /**
     * Stops syncing on this phone; the terms stay. Not a revoke: Google keeps one grant per app and
     * account, so revoking would sign out every other device too.
     */
    fun signOut(context: Context) {
        set(context.applicationContext) { Status(null, false, 0, null) }
    }

    /**
     * The user edits terms, the prompt, a key or the switch: [change] writes them to [Prefs], under the lock a sync
     * merges under, so neither overwrites the other. The edit is recorded once typing pauses (not
     * "K", "Ku", "Kub"… as removed terms), or before a sync merges, then sent.
     */
    fun edit(context: Context, change: (Prefs) -> Unit) {
        val app = context.applicationContext
        val prefs = Prefs(app)
        synchronized(lock) { change(prefs) }
        main.removeCallbacksAndMessages(pending)
        main.postAtTime({
            worker.execute {
                val changed = synchronized(lock) { recordEdit(prefs) }
                if (changed) syncNow(app)
            }
        }, pending, android.os.SystemClock.uptimeMillis() + EDIT_DELAY_MS)
    }

    /** Under [lock]: what the settings hold now, compared with the history. */
    private fun recordEdit(prefs: Prefs): Boolean {
        val next = Sync.recordEdit(state(prefs), prefs.local(), System.currentTimeMillis()) ?: return false
        prefs.syncState = Sync.serialize(next)
        return true
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
        prefs.syncState.takeIf { it.isNotEmpty() }?.let { Sync.parse(it) }
            ?: Sync.initialState(prefs.local(), Prefs.DEFAULT_KEYWORDS, Prefs.DEFAULT_PROMPT)

    /** On the worker thread. */
    private fun syncOnce(app: Context) {
        val prefs = Prefs(app)
        val email = prefs.googleEmail
        if (email.isEmpty()) return
        setFor(app, email) { copy(busy = true) }
        try {
            var token = token(app, email)
            // Signed out (perhaps into another account) since this sync started: its data isn't for that account.
            fun alive() {
                if (prefs.googleEmail != email) throw Stale()
            }
            fun drive(build: Request.Builder): String {
                alive()
                return try {
                    call(build.header("Authorization", "Bearer $token").build())
                } catch (e: Unauthorized) {
                    // Expired early, or revoked: a fresh token tells which.
                    GoogleAuthUtil.clearToken(app, token)
                    token = token(app, email)
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
                alive()
                recordEdit(prefs) // typed since, not recorded yet
                val local = state(prefs)
                val merged = remote?.let { Sync.mergeStates(local, it) } ?: local
                if (!Sync.sameState(merged, local)) {
                    prefs.keywords = Sync.arrangeTerms(prefs.keywords, Sync.termsOf(merged))
                    prefs.prompt = merged.prompt.value
                    prefs.syncKeys = merged.syncKeys.value
                    merged.keys["openai"]?.let { prefs.apiKey = it.value }
                    merged.keys["gemini"]?.let { prefs.geminiKey = it.value }
                    main.post { applied?.invoke() }
                }
                prefs.syncState = Sync.serialize(merged)
                merged
            }
            val out = Sync.shared(merged)
            if (remote == null || !Sync.sameState(out, remote) || ids.size > 1) {
                val json = "application/json".toMediaType()
                val body = Sync.serialize(out).toRequestBody(json)
                // Keys just turned off: a new file, since Drive keeps a file's earlier versions (keys in them) for a while.
                val replace = remote != null && remote.keys.isNotEmpty() && out.keys.isEmpty()
                if (ids.isNotEmpty() && !replace) {
                    drive(Request.Builder().url("$UPLOAD/${ids[0]}?uploadType=media").patch(body))
                } else {
                    val meta = JSONObject().put("name", FILE_NAME).put("parents", org.json.JSONArray().put("appDataFolder")).toString()
                    val multipart = MultipartBody.Builder().setType("multipart/related".toMediaType())
                        .addPart(meta.toRequestBody(json))
                        .addPart(body)
                        .build()
                    drive(Request.Builder().url("$UPLOAD?uploadType=multipart").post(multipart))
                }
                for (id in if (replace) ids else ids.drop(1)) drive(Request.Builder().url("$DRIVE/$id").delete())
            }
            setFor(app, email) { copy(busy = false, syncedAt = System.currentTimeMillis(), error = null) }
        } catch (e: Stale) {
            // signOut has reset the status
        } catch (e: SignedOut) {
            android.util.Log.w("Ciao", "google sync: access gone, signing out")
            setFor(app, email) { Status(null, false, 0, app.getString(R.string.sync_signed_out)) }
        } catch (e: Exception) {
            android.util.Log.w("Ciao", "google sync", e)
            setFor(app, email) { copy(busy = false, error = app.getString(R.string.sync_failed, e.message ?: e.javaClass.simpleName)) }
        }
    }

    private class Unauthorized : Exception()
    private class SignedOut : Exception()
    private class Stale : Exception()

    /** A token without asking: Play services refreshes it; if the user must consent again, that's a sign-out. */
    private fun token(app: Context, email: String): String {
        val result = Tasks.await(Identity.getAuthorizationClient(app).authorize(requestFor(email)), 30, TimeUnit.SECONDS)
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
