package com.mediaconlab.pixie

import org.json.JSONObject

/**
 * org.json's optString() returns the literal "null" for JSON null values, so use this instead.
 * Returns null when the key is missing or JSON null.
 */
fun JSONObject.str(key: String): String? = if (isNull(key)) null else optString(key)
