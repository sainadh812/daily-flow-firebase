package com.sainadh.dailyflow

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeSmokeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun localActivitySubtaskAndStopwatch() {
        val repository = (compose.activity.application as DailyFlowApplication).repository
        compose.waitUntil(30000) { repository.ready }
        // This test intentionally operates only in the emulator's local guest workspace.
        assertEquals("guest", repository.owner)
        val title = "Native verification #android ${System.currentTimeMillis()}"
        compose.onNode(hasSetTextAction() and hasText("Add an activity…")).performTextInput(title)
        compose.onNodeWithContentDescription("Add activity").performClick()
        compose.onNodeWithText(title).assertExists().performClick()
        compose.onNode(hasSetTextAction() and hasText("Add subtask")).performScrollTo().performTextInput("Verify local persistence")
        compose.onNodeWithContentDescription("Add subtask").performClick()
        compose.onNodeWithText("Verify local persistence").assertExists()
        compose.onNodeWithContentDescription("Focus on activity").performScrollTo().performClick()
        compose.onNodeWithText("Stopwatch").performClick()
        compose.onNodeWithText("Start").performScrollTo().performClick()
        compose.waitUntil(5000) { DeviceTimer.state.value.running && DeviceTimer.state.value.elapsed() >= 1 }
        compose.onNodeWithText("Pause").performClick()
        compose.waitUntil(5000) { !DeviceTimer.state.value.running }
        compose.waitUntil(10000) { repository.profile.obj("focusLog").optLong(today()) >= 1 }
        assertTrue(repository.tasks(today()).any { it.optString("content") == title && it.arr("subtasks").length() == 1 })
        compose.runOnUiThread { DeviceTimer.stop("test-cleanup") }
    }

    @Test fun transferFormatsRoundTripComplexActivity() {
        val task = newTask("Write, review & ship #native", "Multiline notes\nQuoted: \"yes\"")
            .put("pomodoros", 3).put("focusSeconds", 321).put("done", true)
            .put("subtasks", JSONArray().put(JSONObject().put("id", "sub1").put("text", "Review <draft>").put("done", true)))
            .put("comments", JSONArray().put(JSONObject().put("id", "comment1").put("text", "Unicode 🌱 and comma, quote\"")))
        val profile = blankProfile().put("entries", JSONObject().put("2026-09-07", JSONArray().put(task)))
        profile.obj("pomLog").put("2026-09-07", 3)
        profile.obj("focusLog").put("2026-09-07", 321)
        for (format in Transfer.formats) {
            val bytes = Transfer.export(profile, format.id)
            val restored = Transfer.parse(bytes, "test.${format.extension}")
            val restoredTask = restored.obj("entries").arr("2026-09-07").getJSONObject(0)
            assertTrue("${format.id} must preserve the full task", SyncProtocol.equal(task, restoredTask))
        }
    }
    @Test fun websiteBackupsImportWithoutLosingNestedData() {
        val assets = androidx.test.platform.app.InstrumentationRegistry.getInstrumentation().context.assets
        listOf("json", "csv", "md", "xlsx").forEach { extension ->
            val bytes = assets.open("web.$extension").use { it.readBytes() }
            val profile = Transfer.parse(bytes, "web.$extension")
            val task = profile.obj("entries").arr("2026-09-07").getJSONObject(0)
            assertEquals("fixture-task", task.optString("id"))
            assertEquals("Cross-device 🏍️ notes", task.optString("content"))
            assertTrue(task.arr("subtasks").getJSONObject(0).optBoolean("done"))
            assertEquals("Preserve this comment", task.arr("comments").getJSONObject(0).optString("text"))
            assertEquals(2, task.optInt("pomodoros")); assertEquals(81L, task.optLong("focusSeconds"))
            assertEquals(20, profile.obj("settings").optInt("workDuration")); assertTrue(profile.obj("settings").optBoolean("dark"))
            assertEquals("Personal project", profile.arr("customCats").getJSONObject(0).optString("label"))
            assertEquals(2, profile.obj("pomLog").optInt("2026-09-07")); assertEquals(81, profile.obj("focusLog").optInt("2026-09-07"))
        }
    }
    @Test fun completedTimerJournalReplaysExactlyOnce() {
        val repository = (compose.activity.application as DailyFlowApplication).repository
        compose.waitUntil(30000) { repository.ready }
        assertEquals("guest", repository.owner)
        val preferences = compose.activity.getSharedPreferences("dailyflow_device_timer", android.content.Context.MODE_PRIVATE)
        val original = DeviceTimer.onSegment
        val prior = repository.profile.obj("focusLog").optLong(today())
        val seen = mutableListOf<String>()
        try {
            compose.runOnUiThread {
                DeviceTimer.onSegment = { _, segment, _ -> seen.add(segment.getString("id")) }
                DeviceTimer.configure(repository.activeProfileId, seconds = 1, label = "Journal verification")
                DeviceTimer.start()
            }
            compose.waitUntil(10000) { seen.isNotEmpty() }
            assertTrue(JSONObject(preferences.getString("segments", "{}")!!).length() > 0)
            compose.runOnUiThread { DeviceTimer.onSegment = original; DeviceTimer.replayJournal(); DeviceTimer.replayJournal() }
            compose.waitUntil(10000) { JSONObject(preferences.getString("segments", "{}")!!).length() == 0 }
            assertEquals(prior + 1, repository.profile.obj("focusLog").optLong(today()))
        } finally {
            compose.runOnUiThread { DeviceTimer.onSegment = original; DeviceTimer.stop("test-cleanup"); DeviceTimer.replayJournal() }
        }
    }

    @Test fun unfinishedAndArchiveKeepOriginalTaskDates() {
        val repository = (compose.activity.application as DailyFlowApplication).repository
        compose.waitUntil(30000) { repository.ready }
        assertEquals("guest", repository.owner)
        val oldDate = java.time.LocalDate.now().minusDays(1).toString()
        val futureDate = java.time.LocalDate.now().plusDays(1).toString()
        val id = "all-date-${System.currentTimeMillis()}"
        val legacyId = "$id-legacy"
        val oldTitle = "Earlier verification $id"
        val futureTitle = "Upcoming verification $id"
        val legacyTitle = "Archived legacy verification $id"
        try {
            compose.runOnUiThread {
                repository.addTask(oldDate, newTask(oldTitle).put("id", id))
                repository.addTask(futureDate, newTask(futureTitle).put("id", id))
                repository.addTask(oldDate, newTask(legacyTitle).put("id", legacyId))
                repository.mutateProfile { it.obj("settings").arr("ghostDismissed").put(legacyId) }
            }
            compose.onNodeWithText("Unfinished").performClick()
            compose.onNodeWithText("Earlier", substring = false).performClick()
            compose.onNodeWithTag("activity-list").performScrollToNode(hasText(oldTitle))
            compose.onNodeWithText(oldTitle).performClick()
            compose.onNodeWithText("Edit", substring = false).performClick()
            compose.onNode(hasSetTextAction() and hasText(oldTitle)).performTextReplacement("Edited $oldTitle")
            compose.onNodeWithText("Save activity").performClick()
            assertEquals("Edited $oldTitle", repository.tasks(oldDate).first { it.optString("id") == id }.optString("content"))
            assertEquals(futureTitle, repository.tasks(futureDate).first { it.optString("id") == id }.optString("content"))
            compose.onNodeWithText("Upcoming", substring = false).performClick()
            compose.onNodeWithTag("activity-list").performScrollToNode(hasText(futureTitle))
            compose.onNodeWithText(futureTitle).performClick()
            compose.onNodeWithContentDescription("Focus on activity").performClick()
            assertEquals(futureDate, DeviceTimer.state.value.taskDate)
            assertEquals(id, DeviceTimer.state.value.taskId)
            compose.onNodeWithText("Log", substring = false).performClick()
            compose.onNodeWithText("Archived", substring = false).performClick()
            compose.onNodeWithTag("activity-list").performScrollToNode(hasText(legacyTitle))
            compose.onNodeWithText(legacyTitle).performClick()
            compose.onNodeWithContentDescription("Archive or restore").performClick()
            assertFalse(taskIsArchived(repository.tasks(oldDate).first { it.optString("id") == legacyId }, repository.settings))
            assertFalse(repository.settings.arr("ghostDismissed").strings().contains(legacyId))
        } finally {
            compose.runOnUiThread {
                DeviceTimer.stop("test-cleanup")
                repository.removeTask(oldDate, id); repository.removeTask(futureDate, id); repository.removeTask(oldDate, legacyId)
                repository.mutateProfile { p -> p.obj("settings").put("ghostDismissed", JSONArray(p.obj("settings").arr("ghostDismissed").strings().filterNot { it == legacyId })) }
            }
        }
    }
}
