package com.sainadh.dailyflow

import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NextDayRecapSmokeTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun nextDaySummaryIsLocalAndDoesNotRepeatAfterRecreation() {
        val repository = (compose.activity.application as DailyFlowApplication).repository
        compose.waitUntil(30_000) { repository.ready }
        assertEquals("guest", repository.owner)
        val originalProfile = repository.activeProfileId
        val previousDate = java.time.LocalDate.now().minusDays(1).toString()
        compose.runOnUiThread {
            repository.addProfile("Recap verification ${System.currentTimeMillis()}")
            repository.addTask(previousDate, newTask("Yesterday's achievement").put("done", true))
        }
        compose.waitForIdle()
        val preferences = compose.activity.getSharedPreferences("dailyflow_recaps", android.content.Context.MODE_PRIVATE)
        val recapProfile = repository.activeProfileId
        val key = recapStorageKey(repository.owner, repository.activeProfileId)
        try {
            compose.runOnUiThread {
                preferences.edit().putString("last:$key", previousDate).remove("shown:$key").commit()
                repository.mutateProfile { it.obj("settings").put("endOfDaySummary", true) }
            }
            compose.onNodeWithText("Your day in review").assertExists()
            compose.onNodeWithText("1 of 1 activities completed").assertExists()
            assertEquals(today(), preferences.getString("shown:$key", null))
            compose.onNodeWithText("Let's begin").performClick()
            compose.activityRule.scenario.recreate()
            compose.waitForIdle()
            compose.onNodeWithText("Your day in review").assertDoesNotExist()
        } finally {
            compose.runOnUiThread {
                assertEquals("guest", repository.owner)
                repository.mutateProfile { it.obj("settings").put("endOfDaySummary", false) }
                repository.selectProfile(originalProfile)
                repository.mutateMeta { meta -> meta.put("profiles", org.json.JSONArray(meta.arr("profiles").objects().filterNot { it.optString("id") == recapProfile })) }
                preferences.edit().remove("last:$key").remove("shown:$key").commit()
            }
        }
    }
}
