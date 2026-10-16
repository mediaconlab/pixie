package com.mediaconlab.pixie

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import kotlin.math.roundToInt

/**
 * Sends `location.update` (PROTOCOL.md section 4.1) for weather while [LinkService] is running.
 *
 * Plain [LocationManager] (no Play Services): GPS when fine location is granted, plus the network provider as
 * a fallback (and the only provider with coarse-only permission). Coordinates are rounded to 2 decimals
 * (~1 km) before they leave the phone. Sent on start and when the phone moves > 2 km, at most every 15 min.
 *
 * Driven only by [LinkService] ([sync] / [stop]); all callbacks arrive on the main looper.
 */
object LocationReporter {
    private const val TAG = "LocationReporter"
    private const val MIN_TIME_MS = 15 * 60 * 1000L
    private const val MIN_DISTANCE_M = 2_000f
    /** A last-known fix older than this is not worth sending on start; wait for a fresh one instead. */
    private const val MAX_LAST_KNOWN_AGE_MS = 60 * 60 * 1000L

    private var manager: LocationManager? = null
    private var listening = false
    /** Unrounded fix we last sent, for the 2 km check. */
    private var lastSent: Location? = null
    /** SystemClock.elapsedRealtime() of the last send. */
    private var lastSentAt = 0L

    private val listener = object : LocationListener {
        override fun onLocationChanged(location: Location) {
            onLocation(location)
        }

        // Before API 30 these three are abstract in the platform interface; without overrides the framework
        // calling them on Android 10 would throw AbstractMethodError.
        @Suppress("OVERRIDE_DEPRECATION", "DEPRECATION")
        override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {
        }

        override fun onProviderEnabled(provider: String) {
        }

        override fun onProviderDisabled(provider: String) {
        }
    }

    /** True when the user wants location shared and a location permission is granted. */
    fun shouldRun(context: Context): Boolean =
        Prefs.shareLocation(context) && Permissions.locationGranted(context)

    /** Start or stop updates to match the toggle and the current permission. */
    @Synchronized
    fun sync(context: Context) {
        if (shouldRun(context)) start(context) else stop()
    }

    @SuppressLint("MissingPermission") // checked via Permissions before every request
    @Synchronized
    private fun start(context: Context) {
        if (listening) return
        val lm = context.applicationContext.getSystemService(LocationManager::class.java) ?: return
        val fine = Permissions.granted(context, Manifest.permission.ACCESS_FINE_LOCATION)
        val available = lm.allProviders
        val providers = ArrayList<String>()
        if (fine && available.contains(LocationManager.GPS_PROVIDER)) providers.add(LocationManager.GPS_PROVIDER)
        if (available.contains(LocationManager.NETWORK_PROVIDER)) providers.add(LocationManager.NETWORK_PROVIDER)
        if (providers.isEmpty()) {
            Log.w(TAG, "no usable location provider")
            return
        }

        var registered = false
        for (provider in providers) {
            try {
                lm.requestLocationUpdates(provider, MIN_TIME_MS, MIN_DISTANCE_M, listener, Looper.getMainLooper())
                registered = true
            } catch (e: SecurityException) {
                Log.w(TAG, "no permission for $provider: ${e.message}")
            } catch (e: IllegalArgumentException) {
                Log.w(TAG, "provider $provider unavailable: ${e.message}")
            }
        }
        if (!registered) return

        manager = lm
        listening = true
        lastSent = null
        lastSentAt = 0L

        // Send on start: the freshest last-known fix, if it is recent enough to describe where the phone is.
        var best: Location? = null
        for (provider in providers) {
            val loc: Location? = try {
                lm.getLastKnownLocation(provider)
            } catch (e: Exception) {
                null
            }
            if (loc != null && (best == null || loc.elapsedRealtimeNanos > best.elapsedRealtimeNanos)) best = loc
        }
        val last = best
        if (last != null) {
            val ageMs = (SystemClock.elapsedRealtimeNanos() - last.elapsedRealtimeNanos) / 1_000_000L
            if (ageMs in 0..MAX_LAST_KNOWN_AGE_MS) onLocation(last)
        }
    }

    @Synchronized
    fun stop() {
        val lm = manager
        if (lm != null) {
            try {
                lm.removeUpdates(listener)
            } catch (e: Exception) {
                Log.w(TAG, "removeUpdates failed: ${e.message}")
            }
        }
        manager = null
        listening = false
    }

    @Synchronized
    private fun onLocation(location: Location) {
        if (!listening) return
        val lat = round2(location.latitude)
        val lon = round2(location.longitude)
        val now = SystemClock.elapsedRealtime()
        val prev = lastSent
        if (prev != null) {
            // A fix whose own error is bigger than 2 km is not evidence of a move.
            val threshold = if (location.hasAccuracy()) maxOf(MIN_DISTANCE_M, location.accuracy) else MIN_DISTANCE_M
            val moved = prev.distanceTo(location) > threshold
            val sameCell = round2(prev.latitude) == lat && round2(prev.longitude) == lon
            if (!moved && (now - lastSentAt < MIN_TIME_MS || sameCell)) return
        }

        val data = JSONObject()
            .put("lat", lat)
            .put("lon", lon)
            .put("accuracy_m", if (location.hasAccuracy()) location.accuracy.roundToInt() else JSONObject.NULL)
            .put("source", "phone")
        PixieLink.send("location.update", data)
        lastSent = Location(location)
        lastSentAt = now
        EventLog.add("location", "Location updated", "Shared for weather, rounded to about 1 km")
    }

    private fun round2(v: Double): Double = Math.round(v * 100.0) / 100.0
}
