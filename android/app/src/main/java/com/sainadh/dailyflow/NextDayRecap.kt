package com.sainadh.dailyflow

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import kotlinx.coroutines.delay
import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.format.DateTimeFormatter

data class DayRecap(val date: String, val completed: Int, val total: Int, val pomodoros: Long, val focusSeconds: Long, val activities: List<String>)

/** Device-only, injective identity: separators inside either component cannot collide. */
fun recapStorageKey(owner: String, profileId: String): String = JSONArray().put(owner).put(profileId).toString()

fun nextDayRecap(profile: JSONObject, previousDate: String?, currentDate: String, shownOn: String?): DayRecap? {
    if (previousDate == null || shownOn == currentDate) return null
    val previous = runCatching { LocalDate.parse(previousDate) }.getOrNull() ?: return null
    val current = runCatching { LocalDate.parse(currentDate) }.getOrNull() ?: return null
    if (previous >= current) return null
    val tasks = profile.optJSONObject("entries")?.optJSONArray(previousDate)?.objects().orEmpty()
    if (tasks.isEmpty()) return null
    return DayRecap(previousDate, tasks.count { it.optBoolean("done") }, tasks.size,
        profile.optJSONObject("pomLog")?.optLong(previousDate)?.coerceAtLeast(0) ?: 0,
        profile.optJSONObject("focusLog")?.optLong(previousDate)?.coerceAtLeast(0) ?: 0,
        tasks.take(3).map { it.optString("content") })
}

/** Like the website, shows the previous visited day's recap on next-day use, not a background alarm. */
@Composable
fun NextDayRecap(repository: AppRepository, activity: MainActivity) {
    val owner = repository.owner
    val profileId = repository.activeProfileId
    val scopeKey = recapStorageKey(owner, profileId)
    val enabled = repository.settings.optBoolean("endOfDaySummary")
    val preferences = remember(activity) { activity.getSharedPreferences("dailyflow_recaps", Context.MODE_PRIVATE) }
    var recap by remember(scopeKey) { mutableStateOf<DayRecap?>(null) }
    fun visit() {
        if (!repository.ready || profileId.isBlank() || owner != repository.owner || profileId != repository.activeProfileId) return
        val currentDate = today()
        val previous = preferences.getString("last:$scopeKey", null)
        val shown = preferences.getString("shown:$scopeKey", null)
        val candidate = if (enabled) nextDayRecap(repository.profile, previous, currentDate, shown) else null
        if (previous != currentDate) {
            val edit = preferences.edit().putString("last:$scopeKey", currentDate)
            if (candidate != null) edit.putString("shown:$scopeKey", currentDate)
            // Persist the once-per-day decision before displaying, including activity recreation.
            if (edit.commit() && candidate != null) recap = candidate
        }
    }
    DisposableEffect(scopeKey, repository.ready, enabled, activity) {
        val observer = LifecycleEventObserver { _, event -> if (event == Lifecycle.Event.ON_RESUME) visit() }
        activity.lifecycle.addObserver(observer)
        if (activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) visit()
        onDispose { activity.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(scopeKey, repository.ready, enabled) {
        while (true) {
            if (activity.lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) visit()
            delay(30_000) // Also covers leaving the app open across local midnight.
        }
    }
    if (enabled && repository.ready) recap?.let { day ->
        AlertDialog(onDismissRequest = { recap = null }, title = { Text("Your day in review") }, text = {
            Column(Modifier.heightIn(max = 380.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text(LocalDate.parse(day.date).format(DateTimeFormatter.ofPattern("EEEE, d MMMM")), style = MaterialTheme.typography.titleMedium)
                Text("${day.completed} of ${day.total} activities completed")
                Text("${day.pomodoros} pomodoros · ${day.focusSeconds / 60} minutes of recorded focus")
                Text("From your log", style = MaterialTheme.typography.labelLarge)
                day.activities.forEach { Text("• $it") }
                Text("A fresh day, at your own pace.", style = MaterialTheme.typography.bodySmall)
            }
        }, confirmButton = { TextButton(onClick = { recap = null }) { Text("Let's begin") } })
    }
}
