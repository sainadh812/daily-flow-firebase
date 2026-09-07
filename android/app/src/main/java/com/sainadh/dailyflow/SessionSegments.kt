package com.sainadh.dailyflow

import java.time.Instant
import java.time.ZoneId

data class FocusSegment(val id: String, val date: String, val startedAt: Long, val endedAt: Long, val activeSeconds: Long, val completed: Boolean)

/** Split one uninterrupted active period at calendar midnights; completion belongs only to its final segment. */
fun splitFocusSegments(sessionId: String, startedAt: Long, activeSeconds: Long, completed: Boolean, zone: ZoneId): List<FocusSegment> {
    require(activeSeconds >= 0)
    val finish = startedAt + activeSeconds * 1000
    if (activeSeconds == 0L) return if (completed) listOf(FocusSegment("$sessionId:$startedAt:0", Instant.ofEpochMilli(startedAt).atZone(zone).toLocalDate().toString(), startedAt, startedAt, 0, true)) else emptyList()
    val result = mutableListOf<FocusSegment>()
    var cursor = startedAt
    var allocated = 0L
    while (cursor < finish) {
        val day = Instant.ofEpochMilli(cursor).atZone(zone).toLocalDate()
        val midnight = day.plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli()
        val end = minOf(midnight, finish)
        val seconds = if (end == finish) activeSeconds - allocated else (end - cursor) / 1000
        result += FocusSegment("$sessionId:$startedAt:${result.size}", day.toString(), cursor, end, seconds, completed && end == finish)
        allocated += seconds; cursor = end
    }
    return result
}
