package com.sainadh.dailyflow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NextDayRecapTest {
    private fun fixture(): JSONObject = blankProfile()
        .put("entries", JSONObject().put("2026-09-06", JSONArray().put(newTask("Completed").put("done", true)).put(newTask("Keep going"))))
        .put("pomLog", JSONObject().put("2026-09-06", 3))
        .put("focusLog", JSONObject().put("2026-09-06", 81))

    @Test fun recapUsesPreviousVisitedDayAndActualRecordedSeconds() {
        val recap = nextDayRecap(fixture(), "2026-09-06", "2026-09-09", null)!!
        assertEquals("2026-09-06", recap.date)
        assertEquals(1, recap.completed); assertEquals(2, recap.total)
        assertEquals(3L, recap.pomodoros); assertEquals(81L, recap.focusSeconds)
        assertEquals(listOf("Completed", "Keep going"), recap.activities)
    }
    @Test fun firstVisitSameDayFutureAndRepeatedSummaryDoNotShow() {
        val profile = fixture()
        assertNull(nextDayRecap(profile, null, "2026-09-07", null))
        assertNull(nextDayRecap(profile, "2026-09-07", "2026-09-07", null))
        assertNull(nextDayRecap(profile, "2026-09-09", "2026-09-07", null))
        assertNull(nextDayRecap(profile, "2026-09-06", "2026-09-07", "2026-09-07"))
    }
    @Test fun malformedOrEmptyHistoryDoesNotShowOrMutateProfile() {
        val profile = fixture(); val before = profile.toString()
        assertNull(nextDayRecap(profile, "not-a-date", "2026-09-07", null))
        assertNull(nextDayRecap(profile, "2026-09-05", "2026-09-07", null))
        assertNull(nextDayRecap(profile, "2026-09-06", "invalid", null))
        assertEquals(before, profile.toString())
    }
    @Test fun accountAndWorkspaceKeysCannotCollide() {
        assertNotEquals(recapStorageKey("a:b", "c"), recapStorageKey("a", "b:c"))
        assertNotEquals(recapStorageKey("account-a", "profile"), recapStorageKey("account-b", "profile"))
        assertNotEquals(recapStorageKey("guest", "profile-a"), recapStorageKey("guest", "profile-b"))
    }
}
