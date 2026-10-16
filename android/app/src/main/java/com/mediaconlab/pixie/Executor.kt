package com.mediaconlab.pixie

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Performs `bot.execute` commands from the brain (PROTOCOL.md 2.2). This is the ONLY place a reply is ever
 * sent: there is no other code path that fires a notification's reply action, so the phone can never message
 * anyone without a matching `bot.execute` (which the brain only sends after an approval tap).
 */
object Executor {
    private const val TAG = "PixieExecutor"
    const val CHANNEL_ACTIONS = "pixie_actions"

    fun execute(context: Context, data: JSONObject) {
        val proposalId = data.str("proposal_id") ?: ""
        val kind = data.str("kind") ?: ""
        val payload = data.optJSONObject("payload") ?: JSONObject()

        val error: String? = try {
            when (kind) {
                "whatsapp.reply" -> sendReply(context, payload)
                "call.back" -> offerCallBack(context, payload)
                else -> "unsupported_kind"
            }
        } catch (e: Exception) {
            Log.e(TAG, "execute $kind failed", e)
            e.message ?: e.javaClass.simpleName
        }

        val result = JSONObject().put("proposal_id", proposalId).put("ok", error == null)
        if (error != null) result.put("error", error)
        PixieLink.send("exec.result", result)

        val title = when (kind) {
            "whatsapp.reply" -> if (error == null) "Replied" else "Reply failed"
            "call.back" -> if (error == null) "Call-back offered" else "Call-back failed"
            else -> "Unsupported action"
        }
        EventLog.add("exec", title, error ?: (payload.str("to") ?: payload.str("name") ?: kind))
    }

    /** Returns null on success, otherwise an error string for exec.result. */
    private fun sendReply(context: Context, payload: JSONObject): String? {
        val key = payload.str("key") ?: return "notification_gone"
        val text = payload.str("text")
        if (text.isNullOrEmpty()) return "empty_text"

        val sbn = NotificationStore.get(key) ?: return "notification_gone"
        val action = ReplyActions.find(sbn.notification) ?: return "no_reply_action"
        val remoteInputs: Array<RemoteInput> = action.remoteInputs ?: return "no_reply_action"
        if (remoteInputs.isEmpty()) return "no_reply_action"

        val results = Bundle()
        for (ri in remoteInputs) {
            results.putCharSequence(ri.resultKey, text)
        }
        val fillIn = Intent().addFlags(Intent.FLAG_RECEIVER_FOREGROUND)
        RemoteInput.addResultsToIntent(remoteInputs, fillIn, results)
        RemoteInput.setResultsSource(fillIn, RemoteInput.SOURCE_FREE_FORM_INPUT) // API 28+, minSdk is 29

        val pi: PendingIntent = action.actionIntent ?: return "no_reply_action"
        try {
            pi.send(context, 0, fillIn)
        } catch (e: PendingIntent.CanceledException) {
            NotificationStore.remove(key)
            return "notification_gone"
        }
        return null
    }

    @SuppressLint("MissingPermission") // POST_NOTIFICATIONS is checked explicitly below
    private fun offerCallBack(context: Context, payload: JSONObject): String? {
        val number = payload.str("number")
        if (number.isNullOrBlank()) return "no_number"
        val name = payload.str("name")?.takeIf { it.isNotBlank() } ?: number

        ensureActionChannel(context)

        // ACTION_DIAL only opens the dialer with the number filled in; the user still presses call.
        val dial = Intent(Intent.ACTION_DIAL, Uri.fromParts("tel", number, null))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val requestCode = number.hashCode()
        val pi = PendingIntent.getActivity(
            context,
            requestCode,
            dial,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ACTIONS)
            .setSmallIcon(R.drawable.ic_stat_pixie)
            .setContentTitle("Call back $name?")
            .setContentText("Tap to open the dialer with $number")
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            return "notifications_not_allowed"
        }
        NotificationManagerCompat.from(context).notify(2000 + (requestCode and 0xFFFF), notification)
        return null
    }

    fun ensureActionChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java) ?: return
        if (nm.getNotificationChannel(CHANNEL_ACTIONS) == null) {
            val ch = NotificationChannel(CHANNEL_ACTIONS, "Pixie actions", NotificationManager.IMPORTANCE_HIGH)
            ch.description = "Things Pixie asks you to do, like calling someone back"
            nm.createNotificationChannel(ch)
        }
    }
}

/** Finding a notification's inline-reply action. */
object ReplyActions {
    fun find(notification: Notification): Notification.Action? {
        val actions = notification.actions ?: return null
        var fallback: Notification.Action? = null
        for (a in actions) {
            val inputs = a.remoteInputs
            if (inputs == null || inputs.isEmpty() || a.actionIntent == null) continue
            if (a.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY) { // API 28+
                return a
            }
            if (fallback == null) fallback = a
        }
        return fallback
    }
}
