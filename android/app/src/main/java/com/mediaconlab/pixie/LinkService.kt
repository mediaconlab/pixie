package com.mediaconlab.pixie

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Foreground service that owns the [PixieLink] socket. Type `specialUse` (persistent link to the user's own
 * companion brain) on API 34+; on API 29-33 the platform uses the manifest's foregroundServiceType.
 */
class LinkService : Service() {

    companion object {
        private const val TAG = "LinkService"
        const val CHANNEL_LINK = "pixie_link"
        private const val NOTIF_ID = 1001
        private const val ACTION_STOP = "com.mediaconlab.pixie.STOP_LINK"

        /** True between onCreate and onDestroy. */
        @Volatile
        var isRunning = false

        fun start(context: Context) {
            if (!Prefs.isPaired(context)) return
            if (isRunning) {
                PixieLink.start(context)
                return
            }
            val intent = Intent(context, LinkService::class.java)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (e: Exception) {
                // e.g. ForegroundServiceStartNotAllowedException when started from the background on API 31+.
                Log.w(TAG, "could not start foreground service: ${e.message}")
                // Still try to connect in-process; events queue until the socket is up.
                PixieLink.start(context)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LinkService::class.java))
        }
    }

    private var networkCallback: ConnectivityManager.NetworkCallback? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        isRunning = true
        ensureChannel(this)
        goForeground()
        registerNetworkCallback()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP || !Prefs.isPaired(this)) {
            stopSelf()
            return START_NOT_STICKY
        }
        goForeground()
        PixieLink.start(this)
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        unregisterNetworkCallback()
        PixieLink.stop()
        super.onDestroy()
    }

    private fun goForeground() {
        val notification = buildNotification()
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                // API 29-33: the special-use type does not exist yet; the 2-arg overload uses the
                // manifest-declared type (FOREGROUND_SERVICE_TYPE_MANIFEST), which is all we need.
                startForeground(NOTIF_ID, notification)
            }
        } catch (e: Exception) {
            Log.e(TAG, "startForeground failed", e)
        }
    }

    private fun buildNotification(): Notification {
        val open = Intent(this, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        val pi = PendingIntent.getActivity(
            this,
            0,
            open,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_LINK)
            .setSmallIcon(R.drawable.ic_stat_pixie)
            .setContentTitle("Pixie is connected")
            .setContentText("Forwarding calls and messages to your Pixie")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(pi)
            .build()
    }

    private fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_LINK) == null) {
            val ch = NotificationChannel(CHANNEL_LINK, "Pixie link", NotificationManager.IMPORTANCE_LOW)
            ch.description = "Shows that Pixie is linked to your companion"
            ch.setShowBadge(false)
            nm.createNotificationChannel(ch)
        }
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                if (PixieLink.state.value != LinkState.CONNECTED) PixieLink.reconnectNow()
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: Exception) {
            Log.w(TAG, "network callback unavailable: ${e.message}")
        }
    }

    private fun unregisterNetworkCallback() {
        val cb = networkCallback ?: return
        val cm = getSystemService(ConnectivityManager::class.java) ?: return
        try {
            cm.unregisterNetworkCallback(cb)
        } catch (e: Exception) {
            // already unregistered
        }
        networkCallback = null
    }
}
