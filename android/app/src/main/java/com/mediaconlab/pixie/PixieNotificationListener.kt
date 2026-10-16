package com.mediaconlab.pixie

import android.app.Notification
import android.content.ComponentName
import android.content.Context
import android.provider.Settings
import android.provider.Telephony
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log
import androidx.core.app.NotificationCompat
import org.json.JSONObject

/**
 * Reads WhatsApp / SMS notification previews (never chat databases) and forwards them as `phone.message`.
 * Also keeps the latest notification per key so an approved reply can use its inline-reply action.
 */
class PixieNotificationListener : NotificationListenerService() {

    companion object {
        private const val TAG = "PixieNotif"
        private const val WHATSAPP = "com.whatsapp"
        private const val WHATSAPP_BUSINESS = "com.whatsapp.w4b"
        private const val DEDUPE_CAP = 64

        /** System-ish notices from WhatsApp that are not messages. Compared lowercase, substring. */
        private val SYSTEM_NOTICES = listOf(
            "checking for new messages",
            "whatsapp web is currently active",
            "whatsapp web is active",
            "is currently active on",
            "backup in progress",
            "backing up messages",
            "restoring media",
            "preparing backup",
            "missed voice call",
            "missed video call",
            "ongoing voice call",
            "ongoing video call",
            "incoming voice call",
            "incoming video call",
            "calling…",
            "ringing…",
        )

        fun isEnabled(context: Context): Boolean {
            val flat = Settings.Secure.getString(context.contentResolver, "enabled_notification_listeners")
                ?: return false
            val me = ComponentName(context, PixieNotificationListener::class.java)
            return flat.split(":").any { entry ->
                val cn = ComponentName.unflattenFromString(entry)
                cn != null && cn == me
            }
        }
    }

    /** LRU of hash(key + text) to drop the repeated posts WhatsApp makes for the same message. */
    private val seen = object : LinkedHashMap<Int, Boolean>(DEDUPE_CAP, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Int, Boolean>?): Boolean =
            size > DEDUPE_CAP
    }

    override fun onListenerConnected() {
        super.onListenerConnected()
        Log.i(TAG, "listener connected")
        if (Prefs.isPaired(this)) LinkService.start(this)
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        if (sbn == null) return
        try {
            handle(sbn)
        } catch (e: Exception) {
            Log.w(TAG, "failed to handle notification", e)
        }
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        // Keep the stored notification: WhatsApp often re-posts under the same key, and a removed one
        // simply fails with notification_gone / CanceledException at execute time.
    }

    private fun handle(sbn: StatusBarNotification) {
        if (!Prefs.isPaired(this)) return
        val pkg = sbn.packageName ?: return
        val smsPackage: String? = try {
            Telephony.Sms.getDefaultSmsPackage(this)
        } catch (e: Exception) {
            null
        }

        val app = when {
            pkg == WHATSAPP -> "whatsapp"
            pkg == WHATSAPP_BUSINESS -> "whatsapp_business"
            smsPackage != null && pkg == smsPackage -> "sms"
            else -> return
        }
        if (app == "sms" && !Prefs.forwardSms(this)) return
        if (app != "sms" && !Prefs.forwardWhatsApp(this)) return

        val n = sbn.notification ?: return
        if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) return
        if (sbn.isOngoing || (n.flags and Notification.FLAG_ONGOING_EVENT) != 0) return
        if (n.category == Notification.CATEGORY_CALL) return

        val parsed = parse(n) ?: return
        if (parsed.preview.isBlank()) return
        if (app != "sms" && isSystemNotice(parsed.preview, parsed.conversation ?: parsed.from)) return

        val hash = (sbn.key + "\u0000" + parsed.from + "\u0000" + parsed.preview).hashCode()
        synchronized(seen) {
            if (seen.containsKey(hash)) return
            seen[hash] = true
        }

        NotificationStore.put(sbn)
        val replyable = ReplyActions.find(n) != null

        val data = JSONObject()
            .put("app", app)
            .put("package", pkg)
            .put("from", parsed.from)
            .put("conversation", parsed.conversation ?: JSONObject.NULL)
            .put("preview", parsed.preview.take(2000))
            .put("is_group", parsed.isGroup)
            .put("key", sbn.key)
            .put("replyable", replyable)

        LinkService.start(this)
        PixieLink.send("phone.message", data)
        val label = if (parsed.conversation != null) "${parsed.from} in ${parsed.conversation}" else parsed.from
        EventLog.add("message", label, parsed.preview.take(120))
    }

    private data class Parsed(
        val from: String,
        val conversation: String?,
        val preview: String,
        val isGroup: Boolean,
    )

    private fun parse(n: Notification): Parsed? {
        val style = try {
            NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        } catch (e: Exception) {
            null
        }
        if (style != null) {
            val messages = style.messages
            if (messages.isNotEmpty()) {
                val last = messages[messages.size - 1]
                // A null person means the message was written by the phone's user (e.g. WhatsApp re-posting
                // the notification with our own approved reply appended). Never forward those.
                val sender = last.person ?: return null
                val text = last.text?.toString()?.trim() ?: ""
                val senderName = sender.name?.toString()?.takeIf { it.isNotBlank() } ?: "Unknown"
                val userName = style.user.name?.toString()
                val userKey = style.user.key
                if (userKey != null && userKey == sender.key) return null
                if (userName != null && userName == senderName) return null
                val isGroup = style.isGroupConversation
                val title = style.conversationTitle?.toString()?.takeIf { it.isNotBlank() }
                val conversation = if (isGroup) title else null
                return Parsed(senderName, conversation, text, isGroup)
            }
        }

        val extras = n.extras ?: return null
        val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim()
        val text = (extras.getCharSequence(Notification.EXTRA_BIG_TEXT)
            ?: extras.getCharSequence(Notification.EXTRA_TEXT))?.toString()?.trim()
        if (title.isNullOrEmpty() || text.isNullOrEmpty()) return null

        // WhatsApp group fallback titles look like "Family: Mom" or "Family (3 messages): Mom".
        val colon = title.indexOf(": ")
        return if (colon > 0) {
            val group = title.substring(0, colon).replace(Regex("\\s*\\(\\d+ \\w+\\)$"), "").trim()
            val sender = title.substring(colon + 2).trim()
            Parsed(sender.ifEmpty { title }, group.ifEmpty { null }, text, true)
        } else {
            Parsed(title.replace(Regex("\\s*\\(\\d+ \\w+\\)$"), "").trim(), null, text, false)
        }
    }

    private fun isSystemNotice(text: String, title: String): Boolean {
        val t = text.lowercase()
        val ti = title.lowercase()
        if (ti == "whatsapp" || ti == "whatsapp business") return true
        // "5 new messages" / "3 messages from 2 chats"
        if (Regex("^\\d+ new messages?$").matches(t)) return true
        if (Regex("^\\d+ messages? from \\d+ chats?$").matches(t)) return true
        return SYSTEM_NOTICES.any { notice ->
            // Short generic notices only; avoid dropping a real message that merely contains the phrase.
            t.contains(notice) && t.length <= notice.length + 40
        }
    }
}
