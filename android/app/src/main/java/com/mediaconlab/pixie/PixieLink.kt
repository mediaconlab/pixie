package com.mediaconlab.pixie

import android.Manifest
import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.TimeUnit

enum class LinkState { DISCONNECTED, CONNECTING, CONNECTED }

/**
 * The single WebSocket to the brain (PROTOCOL.md section 2).
 *
 * Owned by [LinkService]; anything else (notification listener, call receiver) calls [send] and the event is
 * either sent immediately or queued (cap 100, oldest dropped) until the socket is back.
 *
 * All mutable state is guarded by `lock`; timers run on the main looper.
 */
object PixieLink {
    private const val TAG = "PixieLink"
    private const val QUEUE_CAP = 100
    private const val PING_INTERVAL_MS = 30_000L
    private const val BACKOFF_MIN_MS = 1_000L
    private const val BACKOFF_MAX_MS = 30_000L
    const val APP_VERSION = "1.0.0"
    /** Wire contract version sent as `hello.protocol` (PROTOCOL.md section 0). */
    const val PROTOCOL_VERSION = 1
    /** Close code the brain uses after `update_required`. */
    const val CLOSE_UPDATE_REQUIRED = 4002
    const val DEFAULT_UPDATE_MESSAGE = "Please update Pixie to keep using it."
    private const val UPDATE_NOTIF_ID = 1002

    private val lock = Any()
    private val handler = Handler(Looper.getMainLooper())

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS) // websocket: no read timeout, we ping ourselves
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private val _state = MutableStateFlow(LinkState.DISCONNECTED)
    val state: StateFlow<LinkState> = _state.asStateFlow()

    private var appContext: Context? = null
    private var socket: WebSocket? = null
    private var running = false
    private var backoffMs = BACKOFF_MIN_MS
    /** Incremented on every connect so callbacks from stale sockets are ignored. */
    private var generation = 0
    private val queue = ArrayDeque<String>()
    /**
     * Set when the brain says this app is too old (`update_required` / close 4002). While set, [start] and
     * automatic reconnects do nothing; only the user's Reconnect button, unpairing or an app restart clear it.
     */
    @Volatile
    var updateRequired: String? = null
        private set

    private val pingRunnable = object : Runnable {
        override fun run() {
            val ws = synchronized(lock) { if (_state.value == LinkState.CONNECTED) socket else null }
            if (ws != null) {
                ws.send("ping")
                handler.postDelayed(this, PING_INTERVAL_MS)
            }
        }
    }

    private val reconnectRunnable = Runnable { connect() }

    /** Called by [LinkService] when it starts. Safe to call repeatedly. */
    fun start(context: Context) {
        val alreadyRunning = synchronized(lock) {
            appContext = context.applicationContext
            val was = running || updateRequired != null
            if (!was) {
                running = true
                backoffMs = BACKOFF_MIN_MS
            }
            was
        }
        if (!alreadyRunning) connect()
    }

    /** Called by [LinkService] when it stops (or on unpair). */
    fun stop(clearQueue: Boolean = false) {
        val ws: WebSocket? = synchronized(lock) {
            running = false
            generation++
            val current = socket
            socket = null
            if (clearQueue) {
                queue.clear()
                updateRequired = null
            }
            current
        }
        handler.removeCallbacks(pingRunnable)
        handler.removeCallbacks(reconnectRunnable)
        ws?.close(1000, "bye")
        _state.value = LinkState.DISCONNECTED
    }

    /**
     * Drop the current socket and reconnect right away (e.g. network came back). [userInitiated] (the
     * Reconnect button) also retries after an `update_required`, e.g. once the user has updated the brain URL.
     */
    fun reconnectNow(userInitiated: Boolean = false) {
        val isRunning = synchronized(lock) {
            if (userInitiated && updateRequired != null && appContext != null) {
                updateRequired = null
                running = true
            }
            if (running) backoffMs = BACKOFF_MIN_MS
            running
        }
        if (!isRunning) return
        handler.removeCallbacks(reconnectRunnable)
        connect()
    }

    /**
     * Send an event envelope. Returns the envelope id. If the socket is not connected the frame is queued.
     */
    fun send(type: String, data: JSONObject): String {
        val id = "evt_" + UUID.randomUUID().toString().replace("-", "").take(24)
        val envelope = JSONObject()
            .put("v", 1)
            .put("id", id)
            .put("ts", System.currentTimeMillis())
            .put("type", type)
            .put("data", data)
        val text = envelope.toString()
        val ws = synchronized(lock) { if (_state.value == LinkState.CONNECTED) socket else null }
        val sent = ws?.send(text) ?: false
        if (!sent) enqueue(text)
        return id
    }

    private fun enqueue(text: String) {
        synchronized(lock) {
            while (queue.size >= QUEUE_CAP) queue.pollFirst()
            queue.addLast(text)
        }
    }

    private fun flushQueue(ws: WebSocket) {
        while (true) {
            val next = synchronized(lock) { queue.pollFirst() } ?: break
            if (!ws.send(next)) {
                // Socket died mid-flush: put it back at the front and stop.
                synchronized(lock) { queue.addFirst(next) }
                break
            }
        }
    }

    private fun connect() {
        var context: Context? = null
        var myGen = 0
        var old: WebSocket? = null
        synchronized(lock) {
            if (running && appContext != null) {
                context = appContext
                generation++
                myGen = generation
                old = socket
                socket = null
            }
        }
        val ctx: Context = context ?: return
        old?.cancel()
        handler.removeCallbacks(pingRunnable)

        val base = Prefs.baseUrl(ctx)
        val token = Prefs.token(ctx)
        if (base == null || token == null) {
            Log.w(TAG, "not paired, not connecting")
            _state.value = LinkState.DISCONNECTED
            return
        }

        val wsUrl = toWsUrl(base) + "/v1/ws"
        val request = try {
            Request.Builder()
                .url(wsUrl)
                .header("Authorization", "Bearer $token")
                .build()
        } catch (e: IllegalArgumentException) {
            Log.e(TAG, "bad brain url: $wsUrl", e)
            _state.value = LinkState.DISCONNECTED
            return
        }

        _state.value = LinkState.CONNECTING
        val ws = client.newWebSocket(request, Listener(myGen))
        val stale: Boolean = synchronized(lock) {
            val current = generation == myGen
            if (current) {
                socket = ws
            }
            !current
        }
        if (stale) ws.cancel()
    }

    private fun scheduleReconnect(gen: Int) {
        val delay: Long = synchronized(lock) {
            if (!running || gen != generation) {
                -1L
            } else {
                socket = null
                val d = backoffMs
                backoffMs = (backoffMs * 2).coerceAtMost(BACKOFF_MAX_MS)
                d
            }
        }
        if (delay < 0) return
        _state.value = LinkState.DISCONNECTED
        handler.removeCallbacks(pingRunnable)
        handler.removeCallbacks(reconnectRunnable)
        handler.postDelayed(reconnectRunnable, delay)
        Log.i(TAG, "reconnecting in ${delay}ms")
    }

    private fun isCurrent(gen: Int): Boolean = synchronized(lock) { gen == generation && running }

    /** Nested (not inner: objects cannot have inner classes); calls back into PixieLink explicitly. */
    private class Listener(private val gen: Int) : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            PixieLink.onOpen(gen, webSocket)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            if (!PixieLink.isCurrent(gen)) return
            if (text == "pong" || text == "ping") return
            PixieLink.handleFrame(gen, text)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(1000, null)
            if (code == CLOSE_UPDATE_REQUIRED) PixieLink.requireUpdate(gen, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            Log.i(TAG, "closed $code $reason")
            if (code == 4001) {
                // The brain revoked this device (removed from the Mac's device list): stop retrying.
                EventLog.add("link", "Unpaired", "This phone was removed from Pixie. Pair again to reconnect.")
                return
            }
            if (code == 4000) return // superseded by a newer connection from this same phone
            if (code == CLOSE_UPDATE_REQUIRED) {
                PixieLink.requireUpdate(gen, null)
                return
            }
            PixieLink.scheduleReconnect(gen)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            Log.w(TAG, "failure: ${t.message} (http ${response?.code})")
            if (response?.code == 401 || response?.code == 403) {
                EventLog.add("link", "Not authorised", "The brain rejected this phone's token. Try pairing again.")
                return // retrying with a dead token can never succeed
            }
            PixieLink.scheduleReconnect(gen)
        }
    }

    private fun onOpen(gen: Int, webSocket: WebSocket) {
        if (!isCurrent(gen)) {
            webSocket.cancel()
            return
        }
        synchronized(lock) { backoffMs = BACKOFF_MIN_MS }
        webSocket.send(helloEnvelope())
        _state.value = LinkState.CONNECTED
        flushQueue(webSocket)
        handler.removeCallbacks(pingRunnable)
        handler.postDelayed(pingRunnable, PING_INTERVAL_MS)
        EventLog.add("link", "Connected", "Linked to the brain")
    }

    private fun helloEnvelope(): String {
        val data = JSONObject()
            .put("kind", "android")
            .put("name", Build.MODEL ?: "Android")
            .put("protocol", PROTOCOL_VERSION)
            .put("app_version", APP_VERSION)
            .put("capabilities", JSONArray().put("calls").put("whatsapp").put("notify"))
        return JSONObject()
            .put("v", 1)
            .put("id", "evt_hello_" + UUID.randomUUID().toString().replace("-", "").take(16))
            .put("ts", System.currentTimeMillis())
            .put("type", "hello")
            .put("data", data)
            .toString()
    }

    private fun handleFrame(gen: Int, text: String) {
        val env = try {
            JSONObject(text)
        } catch (e: Exception) {
            Log.w(TAG, "non-JSON frame ignored")
            return
        }
        val type = env.optString("type")
        val data = env.optJSONObject("data") ?: JSONObject()
        when (type) {
            "welcome" -> Log.i(TAG, "welcome from brain")
            "bot.execute" -> {
                val ctx = synchronized(lock) { appContext } ?: return
                handler.post { Executor.execute(ctx, data) }
            }
            "update_required" -> {
                val msg = data.optString("message").trim()
                requireUpdate(gen, if (msg.isEmpty()) null else msg)
            }
            "error" -> {
                Log.w(TAG, "brain error: ${data.optString("code")} ${data.optString("message")}")
                EventLog.add("link", "Brain error", data.optString("code"))
            }
            else -> Log.d(TAG, "ignored frame type $type")
        }
    }

    /**
     * The brain no longer supports this app's protocol: stop reconnecting for good, log it and tell the user.
     * Runs once per occurrence (the frame and the 4002 close both lead here).
     */
    private fun requireUpdate(gen: Int, message: String?) {
        var ctx: Context? = null
        var ws: WebSocket? = null
        val text = message ?: DEFAULT_UPDATE_MESSAGE
        synchronized(lock) {
            if (gen != generation || updateRequired != null) return
            updateRequired = text
            running = false
            generation++
            ws = socket
            socket = null
            ctx = appContext
        }
        handler.removeCallbacks(pingRunnable)
        handler.removeCallbacks(reconnectRunnable)
        ws?.close(1000, "update required")
        _state.value = LinkState.DISCONNECTED
        Log.w(TAG, "brain requires an update: $text")
        EventLog.add("link", "Update Pixie", text)
        val c = ctx
        if (c != null) handler.post { showUpdateNotification(c, text) }
    }

    @SuppressLint("MissingPermission") // POST_NOTIFICATIONS is checked explicitly below
    private fun showUpdateNotification(context: Context, text: String) {
        Executor.ensureActionChannel(context)
        val open = Intent(context, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(
            context,
            UPDATE_NOTIF_ID,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val notification = NotificationCompat.Builder(context, Executor.CHANNEL_ACTIONS)
            .setSmallIcon(R.drawable.ic_stat_pixie)
            .setContentTitle("Update Pixie")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        NotificationManagerCompat.from(context).notify(UPDATE_NOTIF_ID, notification)
    }

    /** https://x → wss://x, http://x → ws://x, trailing slash removed. */
    fun toWsUrl(base: String): String {
        val trimmed = base.trim().trimEnd('/')
        return when {
            trimmed.startsWith("https://", ignoreCase = true) -> "wss://" + trimmed.substring(8)
            trimmed.startsWith("http://", ignoreCase = true) -> "ws://" + trimmed.substring(7)
            trimmed.startsWith("wss://", ignoreCase = true) || trimmed.startsWith("ws://", ignoreCase = true) -> trimmed
            else -> "wss://$trimmed"
        }
    }

    /** Shared client for REST calls (pairing). */
    fun httpClient(): OkHttpClient = client
}
