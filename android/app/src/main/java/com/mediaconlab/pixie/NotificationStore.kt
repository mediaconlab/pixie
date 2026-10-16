package com.mediaconlab.pixie

import android.service.notification.StatusBarNotification

/**
 * Latest StatusBarNotification per notification key, so an approved `whatsapp.reply` can use the
 * notification's own reply action. Only messaging notifications we forwarded are stored. Bounded LRU.
 */
object NotificationStore {
    private const val CAP = 200

    private val map = object : LinkedHashMap<String, StatusBarNotification>(64, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, StatusBarNotification>?): Boolean =
            size > CAP
    }

    @Synchronized
    fun put(sbn: StatusBarNotification) {
        map[sbn.key] = sbn
    }

    @Synchronized
    fun get(key: String): StatusBarNotification? = map[key]

    @Synchronized
    fun remove(key: String) {
        map.remove(key)
    }

    @Synchronized
    fun clear() {
        map.clear()
    }
}
