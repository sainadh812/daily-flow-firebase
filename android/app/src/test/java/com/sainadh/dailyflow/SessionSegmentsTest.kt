package com.sainadh.dailyflow

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.*
import org.junit.Test

class SessionSegmentsTest {
    @Test fun midnightPreservesTotalAndSingleCompletion() {
        val start = Instant.parse("2026-09-06T23:59:30Z").toEpochMilli()
        val parts = splitFocusSegments("test", start, 120, true, ZoneId.of("UTC"))
        assertEquals(listOf("2026-09-06", "2026-09-07"), parts.map { it.date })
        assertEquals(listOf(30L, 90L), parts.map { it.activeSeconds })
        assertEquals(1, parts.count { it.completed })
        assertEquals(parts[0].endedAt, parts[1].startedAt)
        assertEquals(parts, splitFocusSegments("test", start, 120, true, ZoneId.of("UTC")))
    }
    @Test fun daylightSavingDayUsesActualMidnight() {
        val start = Instant.parse("2026-03-08T05:00:00Z").toEpochMilli()
        val parts = splitFocusSegments("dst", start, 24 * 3600, false, ZoneId.of("America/New_York"))
        assertEquals(listOf(23 * 3600L, 3600L), parts.map { it.activeSeconds })
    }
    @Test fun pauseAccountingUsesMonotonicClock() {
        val running = TimerState(running = true, accruedSeconds = 45, startedElapsed = 10000)
        assertEquals(55L, running.elapsed(20000))
        assertEquals(45L, running.elapsed(5000))
        assertEquals(45L, running.copy(running = false).elapsed(999999))
    }
}
