package com.sainadh.dailyflow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TaskListsTest {
    private fun fixture(): JSONObject = blankProfile().put("entries", JSONObject()
        .put("2026-09-06", JSONArray().put(newTask("Earlier #review").put("id", "shared-id"))
            .put(newTask("Already carried").put("rolledTo", "2026-09-07"))
            .put(newTask("Legacy hidden").put("id", "legacy-hidden")))
        .put("2026-09-07", JSONArray().put(newTask("Today")) .put(newTask("Done").put("done", true)))
        .put("2026-09-08", JSONArray().put(newTask("Upcoming").put("id", "shared-id"))
            .put(newTask("Archived").put("archived", true))))
        .put("settings", JSONObject().put("ghostDismissed", JSONArray().put("legacy-hidden")))

    @Test fun unfinishedGroupsOnlyLatestOpenTasksWithCompositeIdentity() {
        val groups = groupedTasks(fixture(), "2026-09-07", "Unfinished", currentDate = "2026-09-07")
        assertEquals(listOf("Earlier", "Today", "Upcoming"), groups.map { it.period })
        assertEquals(listOf("Earlier #review", "Today", "Upcoming"), groups.flatMap { it.tasks }.map { it.task.optString("content") })
        assertNotEquals(groups.first().tasks.first().reference.key, groups.last().tasks.first().reference.key)
        assertEquals("2026-09-08", groupedTasks(fixture(), "2026-09-07", "Unfinished", "Upcoming", currentDate = "2026-09-07").single().date)
        assertEquals("Earlier #review", groupedTasks(fixture(), "2026-09-07", "Unfinished", search = "review", currentDate = "2026-09-07").single().tasks.single().task.optString("content"))
    }

    @Test fun archiveIncludesLegacyDismissalsAndRestoreRevealsOriginalDate() {
        val profile = fixture()
        val archived = groupedTasks(profile, "2026-09-07", "Archived", currentDate = "2026-09-07")
        assertEquals(listOf("2026-09-08", "2026-09-06"), archived.map { it.date })
        val legacy = archived.last().tasks.single().task
        setTaskArchived(profile, "2026-09-06", "legacy-hidden", false)
        assertFalse(taskIsArchived(legacy, profile.obj("settings")))
        assertEquals(0, profile.obj("settings").arr("ghostDismissed").length())
        assertTrue(groupedTasks(profile, "2026-09-07", "Unfinished", "Earlier", currentDate = "2026-09-07").single().tasks.any { it.task.optString("content") == "Legacy hidden" })
    }

    @Test fun dailyFiltersRetainDateScope() {
        val profile = fixture()
        assertEquals(2, groupedTasks(profile, "2026-09-07").single().tasks.size)
        assertEquals("Done", groupedTasks(profile, "2026-09-07", filter = "Done").single().tasks.single().task.optString("content"))
        assertEquals("Today", groupedTasks(profile, "2026-09-07", filter = "Open").single().tasks.single().task.optString("content"))
    }

    @Test fun restoringLegacyIdDoesNotRestoreAnotherDateWithSameId() {
        val profile = fixture()
        profile.obj("entries").arr("2026-09-08").put(newTask("Other hidden date").put("id", "legacy-hidden"))
        setTaskArchived(profile, "2026-09-06", "legacy-hidden", false)
        val other = profile.obj("entries").arr("2026-09-08").objects().last()
        assertTrue(taskIsArchived(other, profile.obj("settings")))
        assertTrue(other.optBoolean("archived"))
    }
}
