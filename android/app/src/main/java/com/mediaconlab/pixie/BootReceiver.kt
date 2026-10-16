package com.mediaconlab.pixie

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Restarts the link after a reboot (or app update) when the phone is paired. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED -> {
                if (Prefs.isPaired(context)) LinkService.start(context)
            }
        }
    }
}
