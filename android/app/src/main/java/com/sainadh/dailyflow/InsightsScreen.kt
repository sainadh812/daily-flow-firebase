package com.sainadh.dailyflow

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

data class Achievement(val id: String, val icon: String, val title: String, val description: String, val target: Int, val progress: Int, val tier: String = "bronze")

fun achievementProgress(profile: JSONObject): List<Achievement> {
    val entries = profile.obj("entries")
    val all = entries.keyList().flatMap { entries.arr(it).objects() }
    val completed = all.count { it.optBoolean("done") }
    val pomLog = profile.obj("pomLog")
    val poms = pomLog.keyList().sumOf { pomLog.optInt(it) }
    val bestDay = pomLog.keyList().maxOfOrNull { pomLog.optInt(it) } ?: 0
    var streak = 0; var day = LocalDate.now()
    if ((entries.optJSONArray(day.toString())?.length() ?: 0) == 0) day = day.minusDays(1)
    while ((entries.optJSONArray(day.toString())?.length() ?: 0) > 0) { streak++; day = day.minusDays(1) }
    val tags = all.flatMap { it.arr("tags").strings() }.toSet().size
    val allClear = entries.keyList().any { d -> val list = entries.arr(d).objects(); list.size >= 3 && list.all { it.optBoolean("done") } }
    fun hasHour(predicate: (Int) -> Boolean) = all.any { t -> val ts = t.optLong("ts"); ts > 0 && predicate(Instant.ofEpochMilli(ts).atZone(ZoneId.systemDefault()).hour) }
    return listOf(
        Achievement("first_entry", "📝", "First Steps", "Log your first activity", 1, all.size),
        Achievement("first_pom", "🍅", "Pomodoro Rookie", "Complete your first pomodoro", 1, poms),
        Achievement("first_done", "✅", "Task Done!", "Complete your first task", 1, completed),
        Achievement("first_comment", "💬", "Communicator", "Add a comment to a task", 1, all.sumOf { it.arr("comments").length() }),
        Achievement("first_subtask", "📋", "Planner", "Add a subtask to a task", 1, all.sumOf { it.arr("subtasks").length() }),
        Achievement("first_roll", "📅", "Rolling Forward", "Carry a task to another day", 1, all.count { !it.isNull("rolledTo") }),
        Achievement("fire_day", "🔥", "On Fire", "Complete 4 pomodoros in one day", 4, bestDay, "silver"),
        Achievement("power_day", "⚡", "Power Day", "Complete 8 pomodoros in one day", 8, bestDay, "gold"),
        Achievement("tasks_10", "📌", "Getting Things Done", "Complete 10 tasks", 10, completed, "silver"),
        Achievement("tasks_50", "🏆", "Task Master", "Complete 50 tasks", 50, completed, "gold"),
        Achievement("poms_10", "🍅", "Pomodoro Pro", "Complete 10 pomodoros", 10, poms, "silver"),
        Achievement("poms_50", "🍅", "Pomodoro Master", "Complete 50 pomodoros", 50, poms, "gold"),
        Achievement("poms_100", "🍅", "Pomodoro Legend", "Complete 100 pomodoros", 100, poms, "platinum"),
        Achievement("streak_3", "🌱", "Seedling", "Keep a 3-day logging streak", 3, streak),
        Achievement("streak_7", "💪", "One Week Strong", "Keep a 7-day logging streak", 7, streak, "silver"),
        Achievement("streak_14", "🚀", "Two Weeks!", "Keep a 14-day logging streak", 14, streak, "gold"),
        Achievement("streak_30", "👑", "Unstoppable", "Keep a 30-day logging streak", 30, streak, "platinum"),
        Achievement("early_bird", "🌅", "Early Bird", "Log an activity before 8 AM", 1, if (hasHour { it < 8 }) 1 else 0, "silver"),
        Achievement("night_owl", "🦉", "Night Owl", "Log an activity after 10 PM", 1, if (hasHour { it >= 22 }) 1 else 0, "silver"),
        Achievement("all_clear", "✨", "All Clear", "Complete every task in a day (at least 3)", 1, if (allClear) 1 else 0, "gold"),
        Achievement("tagger", "🏷️", "Tag Collector", "Use 5 unique hashtags", 5, tags, "silver"),
        Achievement("deep_focus", "🧘", "Deep Focus", "Finish a pomodoro on a tracked task", 1, all.count { it.optInt("pomodoros") > 0 }, "silver")
    )
}

@Composable
fun InsightsScreen(repository: AppRepository) {
    var range by remember { mutableIntStateOf(7) }
    var offset by remember { mutableIntStateOf(0) }
    val end = LocalDate.now().minusDays(offset.toLong() * range)
    val dates = (range - 1 downTo 0).map { end.minusDays(it.toLong()).toString() }
    val entries = repository.profile.obj("entries")
    val tasks = dates.flatMap { entries.optJSONArray(it)?.objects() ?: emptyList() }
    val focus = repository.profile.obj("focusLog")
    val minutes = dates.map { focus.optLong(it) / 60 }
    val maximum = (minutes.maxOrNull() ?: 0).coerceAtLeast(1)
    val achievements = achievementProgress(repository.profile)
    val unlocked = repository.profile.obj("achievements").arr("unlocked").strings().toSet()
    LaunchedEffect(repository.profile.toString()) {
        val earned = achievements.filter { it.progress >= it.target && it.id !in unlocked }.map { it.id }
        if (earned.isNotEmpty()) repository.mutateProfile { p -> earned.forEach { p.obj("achievements").arr("unlocked").put(it) } }
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
        Text("See your progress grow", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { listOf(7, 14, 30).forEach { count -> FilterChip(range == count, { range = count; offset = 0 }, label = { Text("$count days") }) } }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MetricCard("Focus time", "${minutes.sum()}m", Modifier.weight(1f))
            MetricCard("Completed", "${tasks.count { it.optBoolean("done") }}/${tasks.size}", Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            MetricCard("Pomodoros", dates.sumOf { repository.profile.obj("pomLog").optInt(it) }.toString(), Modifier.weight(1f))
            MetricCard("Logging streak", "${achievements.find { it.id == "streak_3" }?.progress ?: 0} days", Modifier.weight(1f))
        }
        Card {
            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                Text("Your focus rhythm", fontWeight = FontWeight.SemiBold)
                Text("${dates.first()} — ${dates.last()}", style = MaterialTheme.typography.labelSmall)
                Row(Modifier.fillMaxWidth().height(135.dp), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.Bottom) {
                    minutes.forEach { value -> Box(Modifier.weight(1f).height((120f * value / maximum).coerceAtLeast(3f).dp).background(MaterialTheme.colorScheme.primary.copy(alpha = if (value == 0L) 0.15f else 0.8f), RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp))) }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) { TextButton(onClick = { offset++ }) { Text("Earlier") }; TextButton(onClick = { offset = (offset - 1).coerceAtLeast(0) }, enabled = offset > 0) { Text("Later") } }
            }
        }
        Text("Where your energy goes", style = MaterialTheme.typography.titleMedium)
        categories(repository.profile).forEach { category ->
            val group = tasks.filter { it.optString("cat") == category.id }
            if (group.isNotEmpty()) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text("${category.emoji} ${category.label}", Modifier.weight(1f)); Text("${group.count { it.optBoolean("done") }}/${group.size} done · ${group.sumOf { it.optLong("focusSeconds") } / 60}m", style = MaterialTheme.typography.bodySmall)
            }
        }
        HorizontalDivider()
        Text("Achievements · ${unlocked.size}/22", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        achievements.forEach { achievement ->
            val earned = achievement.id in unlocked || achievement.progress >= achievement.target
            Card(colors = CardDefaults.cardColors(containerColor = if (earned) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow)) {
                Row(Modifier.fillMaxWidth().padding(14.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(if (earned) achievement.icon else "○", style = MaterialTheme.typography.headlineMedium)
                    Spacer(Modifier.width(14.dp)); Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(achievement.title, fontWeight = FontWeight.SemiBold)
                        Text(achievement.description, style = MaterialTheme.typography.bodySmall)
                        if (!earned) LinearProgressIndicator(progress = { (achievement.progress.toFloat() / achievement.target).coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth())
                        Text(if (earned) "Unlocked · ${achievement.tier}" else "${achievement.progress.coerceAtMost(achievement.target)}/${achievement.target}", style = MaterialTheme.typography.labelSmall)
                    }
                }
            }
        }
    }
}

@Composable
fun MetricCard(label: String, value: String, modifier: Modifier = Modifier) {
    Card(modifier) { Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) { Text(value, style = MaterialTheme.typography.headlineMedium, fontWeight = FontWeight.Bold); Text(label, style = MaterialTheme.typography.labelMedium) } }
}
