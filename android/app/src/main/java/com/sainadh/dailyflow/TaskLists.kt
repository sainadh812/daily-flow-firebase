package com.sainadh.dailyflow

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate

data class TaskReference(val date: String, val id: String) {
    val key: String get() = JSONArray().put(date).put(id).toString()
}
data class DatedTask(val date: String, val task: JSONObject) {
    val reference: TaskReference get() = TaskReference(date, task.getString("id"))
}
data class TaskDateGroup(val date: String, val period: String, val tasks: List<DatedTask>)

fun taskIsArchived(task: JSONObject, settings: JSONObject? = null): Boolean = task.optBoolean("archived") || task.optBoolean("ghostDismissed") ||
    settings?.optJSONArray("ghostDismissed")?.strings()?.contains(task.optString("id")) == true

fun setTaskArchived(profile: JSONObject, date: String, id: String, archived: Boolean) {
    val entries = profile.obj("entries")
    val task = entries.optJSONArray(date)?.objects()?.find { it.optString("id") == id } ?: return
    task.put("archived", archived)
    if (!archived) {
        if (task.has("ghostDismissed")) task.put("ghostDismissed", false)
        val settings = profile.obj("settings")
        val legacy = settings.optJSONArray("ghostDismissed")?.strings().orEmpty()
        if (id in legacy) {
            // Old dismissal IDs were not date-scoped. Restore only the selected row,
            // retaining the hidden state of any other historical row with the same ID.
            entries.keyList().filter { it != date }.forEach { otherDate ->
                entries.optJSONArray(otherDate)?.objects()?.filter { it.optString("id") == id }?.forEach { it.put("archived", true) }
            }
            settings.put("ghostDismissed", JSONArray(legacy.filterNot { it == id }))
        }
    }
}

/** Derived views retain bucket dates; IDs alone are not unique across the profile. */
fun groupedTasks(
    profile: JSONObject, selectedDate: String, scope: String = "Daily log", filter: String = "All",
    search: String = "", category: String = "all", priority: String = "all", currentDate: String = today()
): List<TaskDateGroup> {
    val entries = profile.optJSONObject("entries") ?: return emptyList()
    val legacyDismissed = profile.optJSONObject("settings")?.optJSONArray("ghostDismissed")?.strings()?.toSet().orEmpty()
    val dates = if (scope == "Daily log") listOf(selectedDate) else entries.keyList().filter { runCatching { LocalDate.parse(it) }.isSuccess }.sorted()
    return (if (scope == "Archived") dates.reversed() else dates).mapNotNull { date ->
        val period = when { date < currentDate -> "Earlier"; date > currentDate -> "Upcoming"; else -> "Today" }
        val tasks = entries.optJSONArray(date)?.objects().orEmpty().filter { task ->
            val archived = taskIsArchived(task) || task.optString("id") in legacyDismissed
            val inScope = when (scope) {
                "Unfinished" -> !archived && !task.optBoolean("done") && (task.isNull("rolledTo") || task.optString("rolledTo").isBlank()) && (filter == "All" || filter == period)
                "Archived" -> archived
                else -> (if (filter == "Archived") archived else !archived) &&
                    (filter != "Open" || !task.optBoolean("done")) && (filter != "Done" || task.optBoolean("done"))
            }
            inScope && (category == "all" || task.optString("cat") == category) &&
                (priority == "all" || task.optString("priority") == priority) &&
                (search.isBlank() || listOf(task.optString("content"), task.optString("notes"), task.optJSONArray("tags")?.strings()?.joinToString().orEmpty()).any { it.contains(search, true) })
        }.map { DatedTask(date, it) }
        if (tasks.isEmpty()) null else TaskDateGroup(date, period, tasks)
    }
}
