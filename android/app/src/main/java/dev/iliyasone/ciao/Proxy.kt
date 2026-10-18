package dev.iliyasone.ciao

import android.content.Context
import okhttp3.Credentials
import okhttp3.OkHttpClient
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.URI

// The proxy the transcription services are reached through (Prefs.proxy); a port of src/core/proxy.ts
// and src/main/proxy.ts. Only these requests use it: sync, updates and telemetry go direct.

/** [href] as used: http://user:password@host:port. */
data class ProxyAddress(val href: String, val host: String, val port: Int, val username: String, val password: String) {
    /** For showing: the address without the password. */
    val label: String get() = "${if (username.isNotEmpty()) "$username@" else ""}$host:$port"
}

object ApiProxy {
    /**
     * An HTTP proxy from what was typed: "http://user:password@host:port", or the same without
     * "http://". Null for "" (no proxy) and for anything else (another scheme, no port).
     */
    fun parse(text: String): ProxyAddress? {
        val typed = text.trim()
        if (typed.isEmpty()) return null
        val uri = runCatching { URI(if (Regex("^[a-zA-Z][a-zA-Z0-9+.-]*://").containsMatchIn(typed)) typed else "http://$typed") }.getOrNull() ?: return null
        if (uri.scheme?.lowercase() != "http" || uri.host.isNullOrEmpty() || uri.port < 0) return null
        if (!(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/") || uri.rawQuery != null || uri.rawFragment != null) return null
        val rawUser = uri.rawUserInfo ?: ""
        val (user, password) = rawUser.split(":", limit = 2).let { it[0] to it.getOrElse(1) { "" } }
        val decode = { s: String -> runCatching { java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8") }.getOrDefault(s) }
        val auth = if (user.isNotEmpty()) "$rawUser@" else ""
        val host = uri.host.lowercase()
        return ProxyAddress("http://$auth$host:${uri.port}", host, uri.port, decode(user), decode(password))
    }

    sealed interface Check {
        data class Works(val ms: Long) : Check
        data object BadLogin : Check
        data class Failed(val reason: String) : Check
    }

    /**
     * Blocking. Asks Gemini for its models through the proxy now set, without a key: any answer from
     * Google means the way through works; 407 is the proxy refusing the login. As checkProxy on the desktop.
     */
    fun check(context: Context): Check {
        val started = System.nanoTime()
        val request = okhttp3.Request.Builder().url("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1").build()
        return try {
            client(context).newBuilder().callTimeout(15, java.util.concurrent.TimeUnit.SECONDS).build().newCall(request).execute().use {
                if (it.code == 407) Check.BadLogin else Check.Works((System.nanoTime() - started) / 1_000_000)
            }
        } catch (e: java.io.IOException) {
            // OkHttp gives up on a refused login with "Failed to authenticate with proxy".
            if (e.message?.contains("authenticate with proxy") == true) Check.BadLogin else Check.Failed(e.message ?: e.javaClass.simpleName)
        }
    }

    private var cached: Pair<String, OkHttpClient>? = null

    /** The client for requests to OpenAI and Gemini: through the proxy when one is set. */
    @Synchronized
    fun client(context: Context): OkHttpClient {
        val proxy = parse(Prefs(context).proxy)
        val href = proxy?.href ?: ""
        cached?.let { (h, c) -> if (h == href) return c }
        if (cached != null) GeminiEndpoint.forget()
        val client = if (proxy == null) http else http.newBuilder()
            .proxy(Proxy(Proxy.Type.HTTP, InetSocketAddress.createUnresolved(proxy.host, proxy.port)))
            .proxyAuthenticator { _, response ->
                // Once: a second 407 means the password is wrong.
                if (proxy.username.isEmpty() || response.request.header("Proxy-Authorization") != null) null
                else response.request.newBuilder().header("Proxy-Authorization", Credentials.basic(proxy.username, proxy.password)).build()
            }
            .build()
        cached = href to client
        return client
    }
}
