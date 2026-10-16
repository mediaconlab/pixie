package com.mediaconlab.pixie

import android.content.Context
import android.content.SharedPreferences

/**
 * Tiny SharedPreferences wrapper.
 *
 * NOTE: the device token is stored in MODE_PRIVATE SharedPreferences (app-sandboxed, not world readable).
 * A future version should wrap it with an Android Keystore key (e.g. AES/GCM key held in AndroidKeyStore)
 * so the token is not stored in plain text on rooted/backed-up devices.
 */
object Prefs {
    private const val NAME = "pixie"

    private const val K_BASE_URL = "base_url"
    private const val K_TOKEN = "token"
    private const val K_DEVICE_ID = "device_id"
    private const val K_USER_ID = "user_id"
    private const val K_FWD_WHATSAPP = "forward_whatsapp"
    private const val K_FWD_SMS = "forward_sms"
    private const val K_FWD_CALLS = "forward_calls"
    private const val K_LAST_URL = "last_url"
    private const val K_SHARE_LOCATION = "share_location"

    private fun sp(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun baseUrl(context: Context): String? = sp(context).getString(K_BASE_URL, null)?.takeIf { it.isNotBlank() }

    fun token(context: Context): String? = sp(context).getString(K_TOKEN, null)?.takeIf { it.isNotBlank() }

    fun deviceId(context: Context): String? = sp(context).getString(K_DEVICE_ID, null)

    fun isPaired(context: Context): Boolean = baseUrl(context) != null && token(context) != null

    /** The last brain URL the user typed, to pre-fill the pair screen after unpairing. */
    fun lastUrl(context: Context): String = sp(context).getString(K_LAST_URL, "") ?: ""

    fun savePairing(context: Context, baseUrl: String, token: String, deviceId: String?, userId: String?) {
        sp(context).edit()
            .putString(K_BASE_URL, baseUrl)
            .putString(K_TOKEN, token)
            .putString(K_DEVICE_ID, deviceId)
            .putString(K_USER_ID, userId)
            .putString(K_LAST_URL, baseUrl)
            .apply()
    }

    fun clearPairing(context: Context) {
        sp(context).edit()
            .remove(K_BASE_URL)
            .remove(K_TOKEN)
            .remove(K_DEVICE_ID)
            .remove(K_USER_ID)
            .apply()
    }

    fun forwardWhatsApp(context: Context): Boolean = sp(context).getBoolean(K_FWD_WHATSAPP, true)
    fun forwardSms(context: Context): Boolean = sp(context).getBoolean(K_FWD_SMS, true)
    fun forwardCalls(context: Context): Boolean = sp(context).getBoolean(K_FWD_CALLS, true)

    fun setForwardWhatsApp(context: Context, value: Boolean) {
        sp(context).edit().putBoolean(K_FWD_WHATSAPP, value).apply()
    }

    fun setForwardSms(context: Context, value: Boolean) {
        sp(context).edit().putBoolean(K_FWD_SMS, value).apply()
    }

    fun setForwardCalls(context: Context, value: Boolean) {
        sp(context).edit().putBoolean(K_FWD_CALLS, value).apply()
    }

    /** Defaults to on; nothing is sent until a location permission is also granted. */
    fun shareLocation(context: Context): Boolean = sp(context).getBoolean(K_SHARE_LOCATION, true)

    fun setShareLocation(context: Context, value: Boolean) {
        sp(context).edit().putBoolean(K_SHARE_LOCATION, value).apply()
    }
}
