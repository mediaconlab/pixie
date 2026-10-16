package com.mediaconlab.pixie

import android.content.Context
import android.net.Uri
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException

/** POST /v1/pair/claim (PROTOCOL.md section 1). Blocking: call from a background dispatcher. */
object Pairing {
    sealed class Result {
        data class Ok(val baseUrl: String) : Result()
        data class Error(val message: String) : Result()
    }

    /** Parsed `pixie://pair?u=<base url>&c=<code>` deep link. */
    data class Link(val baseUrl: String, val code: String)

    fun parseLink(uri: Uri?): Link? {
        if (uri == null) return null
        if (!"pixie".equals(uri.scheme, ignoreCase = true) || !"pair".equals(uri.host, ignoreCase = true)) return null
        val u = uri.getQueryParameter("u")?.trim().orEmpty() // getQueryParameter already url-decodes
        val c = uri.getQueryParameter("c")?.trim().orEmpty()
        if (u.isEmpty() || c.isEmpty()) return null
        return Link(u, c)
    }

    fun normaliseBaseUrl(raw: String): String {
        var s = raw.trim().trimEnd('/')
        if (!s.startsWith("http://", ignoreCase = true) && !s.startsWith("https://", ignoreCase = true)) {
            s = "https://$s"
        }
        return s
    }

    fun claim(context: Context, rawBaseUrl: String, rawCode: String): Result {
        val baseUrl = normaliseBaseUrl(rawBaseUrl)
        val code = rawCode.filter { it.isDigit() }
        if (code.length != 6) return Result.Error("The code has 6 digits.")

        val body = JSONObject()
            .put("code", code)
            .put("device", JSONObject().put("kind", "android").put("name", Build.MODEL ?: "Android"))
            .toString()
            .toRequestBody("application/json; charset=utf-8".toMediaType())

        val request = try {
            Request.Builder().url("$baseUrl/v1/pair/claim").post(body).build()
        } catch (e: IllegalArgumentException) {
            return Result.Error("That brain URL doesn't look right.")
        }

        return try {
            PixieLink.httpClient().newCall(request).execute().use { resp ->
                val text = resp.body?.string().orEmpty()
                val json = try {
                    JSONObject(text)
                } catch (e: Exception) {
                    JSONObject()
                }
                if (!resp.isSuccessful) {
                    val err = json.str("error")
                    return when {
                        resp.code == 404 || err == "bad_code" -> Result.Error("That code is wrong or expired. Get a fresh one on your Mac.")
                        else -> Result.Error(json.str("message") ?: err ?: "Pairing failed (HTTP ${resp.code}).")
                    }
                }
                val token = json.str("token")
                if (token.isNullOrEmpty()) return Result.Error("The brain didn't return a token.")
                Prefs.savePairing(context, baseUrl, token, json.str("device_id"), json.str("user_id"))
                Result.Ok(baseUrl)
            }
        } catch (e: IOException) {
            Result.Error("Couldn't reach the brain: ${e.message ?: "network error"}")
        }
    }

    /** Best-effort DELETE /v1/devices/:id with our own token so the brain forgets this phone. Blocking. */
    fun revoke(baseUrl: String, token: String, deviceId: String?) {
        if (deviceId.isNullOrEmpty()) return
        try {
            val request = Request.Builder()
                .url("$baseUrl/v1/devices/" + Uri.encode(deviceId))
                .header("Authorization", "Bearer $token")
                .delete()
                .build()
            PixieLink.httpClient().newCall(request).execute().close()
        } catch (e: Exception) {
            // offline or already revoked: nothing to do
        }
    }
}
