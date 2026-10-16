package com.mediaconlab.pixie

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.atomic.AtomicLong

data class LogEntry(
    val id: Long,
    val ts: Long,
    /** "message", "call", "exec", "link" */
    val kind: String,
    val title: String,
    val detail: String,
)

/** In-memory list of the last 20 things the phone forwarded or executed (shown on the main screen). */
object EventLog {
    private const val CAP = 20
    private val counter = AtomicLong(0)
    private val _entries = MutableStateFlow<List<LogEntry>>(emptyList())
    val entries: StateFlow<List<LogEntry>> = _entries.asStateFlow()

    fun add(kind: String, title: String, detail: String) {
        val entry = LogEntry(counter.incrementAndGet(), System.currentTimeMillis(), kind, title, detail)
        _entries.update { current -> (listOf(entry) + current).take(CAP) }
    }

    fun clear() {
        _entries.value = emptyList()
    }
}
