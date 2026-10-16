package com.mediaconlab.pixie

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.provider.ContactsContract
import android.telephony.TelephonyManager
import android.util.Log
import androidx.core.content.ContextCompat
import org.json.JSONObject

/**
 * Listens to android.intent.action.PHONE_STATE and turns ringing → offhook → idle transitions into
 * `phone.call` events (ringing / answered / ended / missed).
 *
 * The broadcast is delivered twice per transition on API 29+ (once without EXTRA_INCOMING_NUMBER, once with,
 * the latter only when READ_CALL_LOG is granted), so state changes are de-duplicated and the "ringing" event
 * waits for the copy that carries the number.
 */
class CallReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != TelephonyManager.ACTION_PHONE_STATE_CHANGED) return
        val state = intent.getStringExtra(TelephonyManager.EXTRA_STATE) ?: return
        @Suppress("DEPRECATION")
        val number: String? = intent.getStringExtra(TelephonyManager.EXTRA_INCOMING_NUMBER)?.takeIf { it.isNotBlank() }
        CallTracker.onState(context.applicationContext, state, number)
    }
}

/** Process-wide call state machine. The receiver is short-lived, so the state lives here. */
object CallTracker {
    private const val TAG = "PixieCalls"

    private enum class Phase { IDLE, RINGING, OFFHOOK_INCOMING, OFFHOOK_OUTGOING }

    private var phase = Phase.IDLE
    private var number: String? = null
    private var name: String? = null
    private var ringingSent = false

    @Synchronized
    fun onState(context: Context, state: String, incoming: String?) {
        if (incoming != null && number == null) {
            number = incoming
            name = lookupName(context, incoming)
        }
        when (state) {
            TelephonyManager.EXTRA_STATE_RINGING -> {
                if (phase == Phase.IDLE) {
                    phase = Phase.RINGING
                    ringingSent = false
                    if (incoming != null) {
                        number = incoming
                        name = lookupName(context, incoming)
                    }
                }
                // Send "ringing" once, as soon as we have a number (second copy of the broadcast). Without
                // READ_CALL_LOG the numbered copy never comes, so send right away in that case.
                if (phase == Phase.RINGING && !ringingSent && (number != null || !canReadNumber(context))) {
                    ringingSent = true
                    emit(context, "ringing")
                }
            }
            TelephonyManager.EXTRA_STATE_OFFHOOK -> {
                when (phase) {
                    Phase.RINGING -> {
                        if (!ringingSent) {
                            ringingSent = true
                            emit(context, "ringing")
                        }
                        phase = Phase.OFFHOOK_INCOMING
                        emit(context, "answered")
                    }
                    Phase.IDLE -> phase = Phase.OFFHOOK_OUTGOING // outgoing call: not reported
                    else -> Unit // duplicate broadcast
                }
            }
            TelephonyManager.EXTRA_STATE_IDLE -> {
                when (phase) {
                    Phase.RINGING -> emit(context, "missed")
                    Phase.OFFHOOK_INCOMING -> emit(context, "ended")
                    else -> Unit
                }
                phase = Phase.IDLE
                number = null
                name = null
                ringingSent = false
            }
        }
    }

    private fun emit(context: Context, state: String) {
        if (!Prefs.isPaired(context) || !Prefs.forwardCalls(context)) return
        val num = number ?: ""
        val data = JSONObject()
            .put("state", state)
            .put("number", num)
            .put("name", name ?: JSONObject.NULL)
        LinkService.start(context)
        PixieLink.send("phone.call", data)
        val who = name ?: num.ifEmpty { "Unknown caller" }
        val title = when (state) {
            "ringing" -> "Incoming call"
            "answered" -> "Call answered"
            "ended" -> "Call ended"
            else -> "Missed call"
        }
        EventLog.add("call", title, who)
    }

    private fun canReadNumber(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CALL_LOG) ==
            PackageManager.PERMISSION_GRANTED

    private fun lookupName(context: Context, number: String): String? {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.READ_CONTACTS) !=
            PackageManager.PERMISSION_GRANTED
        ) return null
        val uri = Uri.withAppendedPath(ContactsContract.PhoneLookup.CONTENT_FILTER_URI, Uri.encode(number))
        return try {
            context.contentResolver.query(
                uri,
                arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
                null,
                null,
                null
            )?.use { c ->
                if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
            }
        } catch (e: Exception) {
            Log.w(TAG, "contact lookup failed: ${e.message}")
            null
        }
    }
}
