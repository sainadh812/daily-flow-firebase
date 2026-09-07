package com.sainadh.dailyflow

import android.app.DatePickerDialog
import androidx.compose.foundation.*
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import org.json.*
import java.time.LocalDate
import java.time.format.DateTimeFormatter

@Composable
fun TasksScreen(repository: AppRepository, onFocus: (String, JSONObject) -> Unit) {
    var date by remember { mutableStateOf(today()) }
    var search by remember { mutableStateOf("") }
    var scope by remember { mutableStateOf("Daily log") }
    var filter by remember { mutableStateOf("All") }
    var category by remember { mutableStateOf("all") }
    var priority by remember { mutableStateOf("all") }
    var edit by remember { mutableStateOf<JSONObject?>(null) }
    var editDate by remember { mutableStateOf(today()) }
    var adding by remember { mutableStateOf(false) }
    var details by remember { mutableStateOf<TaskReference?>(null) }
    var quick by remember { mutableStateOf("") }
    var showNotes by remember { mutableStateOf(false) }
    val context = LocalContext.current
    val tasks = repository.tasks(date).filterNot { taskIsArchived(it, repository.settings) }
    val groups = groupedTasks(repository.profile, date, scope, filter, search, category, priority)
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 12.dp, top = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(when (scope) { "Unfinished" -> "One place for unfinished work"; "Archived" -> "Your archived activities"; else -> if (date == today()) "Make room for what matters" else LocalDate.parse(date).format(DateTimeFormatter.ofPattern("EEEE")) }, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                Text(if (scope == "Daily log") "${tasks.count { it.optBoolean("done") }} of ${tasks.size} activities complete" else "${groups.sumOf { it.tasks.size }} activities across all dates", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = { showNotes = true }) { Icon(Icons.Default.StickyNote2, "Quick notes") }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("Daily log", "Unfinished", "Archived").forEach { option -> FilterChip(scope == option, { scope = option; filter = "All" }, label = { Text(option) }) }
        }
        if (scope == "Daily log") Row(Modifier.fillMaxWidth().padding(horizontal = 10.dp), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { date = LocalDate.parse(date).minusDays(1).toString() }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Previous day") }
            TextButton(onClick = {
                val d = LocalDate.parse(date); DatePickerDialog(context, { _, y, m, day -> date = LocalDate.of(y, m + 1, day).toString() }, d.year, d.monthValue - 1, d.dayOfMonth).apply { datePicker.firstDayOfWeek = if (repository.settings.optBoolean("weekStartMonday", true)) java.util.Calendar.MONDAY else java.util.Calendar.SUNDAY }.show()
            }) { Icon(Icons.Default.CalendarToday, null, Modifier.size(16.dp)); Spacer(Modifier.width(6.dp)); Text(LocalDate.parse(date).format(DateTimeFormatter.ofPattern("EEE, d MMM yyyy"))) }
            IconButton(onClick = { date = LocalDate.parse(date).plusDays(1).toString() }) { Icon(Icons.AutoMirrored.Filled.ArrowForward, "Next day") }
            Spacer(Modifier.weight(1f)); TextButton(onClick = { date = today() }) { Text("Today") }
        }
        OutlinedTextField(search, { search = it }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp), placeholder = { Text("Search tasks, notes or #tags") }, leadingIcon = { Icon(Icons.Default.Search, null) }, singleLine = true, shape = RoundedCornerShape(14.dp))
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            (when (scope) { "Unfinished" -> listOf("All", "Earlier", "Today", "Upcoming"); "Archived" -> emptyList(); else -> listOf("All", "Open", "Done") }).forEach { option -> FilterChip(filter == option, { filter = option }, label = { Text(option) }) }
            DropChoice("Category", category, listOf("all" to "All categories") + categories(repository.profile).map { it.id to "${it.emoji} ${it.label}" }) { category = it }
            DropChoice("Priority", priority, listOf("all" to "All priorities", "high" to "High", "medium" to "Medium", "low" to "Low", "none" to "None")) { priority = it }
        }
        LazyColumn(Modifier.weight(1f).testTag("activity-list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            if (groups.isEmpty()) item {
                Column(Modifier.fillMaxWidth().padding(vertical = 28.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.WbSunny, null, Modifier.size(48.dp), tint = MaterialTheme.colorScheme.primary)
                    Spacer(Modifier.height(12.dp)); Text(if (search.isBlank()) "A little space to begin" else "No activities found", style = MaterialTheme.typography.titleMedium)
                    Text(if (scope == "Archived") "Archived activities from any date appear here." else if (scope == "Unfinished") "No unfinished activities match this view." else if (search.isBlank()) "Capture one thing you want to do today." else "Try another search or filter.", style = MaterialTheme.typography.bodySmall)
                }
            }
            groups.forEach { group ->
                if (scope != "Daily log") item(key = "date:${group.date}") { Text("${group.period} · ${LocalDate.parse(group.date).format(DateTimeFormatter.ofPattern("EEE, d MMM yyyy"))}", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary) }
            items(group.tasks, key = { it.reference.key }) { row ->
                val task = row.task
                val id = task.getString("id")
                Card(onClick = { details = row.reference }, shape = RoundedCornerShape(16.dp), colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.Top) {
                            Checkbox(task.optBoolean("done"), { done -> repository.updateTask(row.date, id) { it.put("done", done) } }, modifier = Modifier.size(28.dp))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(task.optString("content"), fontWeight = FontWeight.SemiBold, textDecoration = if (task.optBoolean("done")) TextDecoration.LineThrough else TextDecoration.None)
                                if (task.optString("notes").isNotBlank()) Text(task.optString("notes"), style = MaterialTheme.typography.bodySmall, maxLines = 2, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                Spacer(Modifier.height(7.dp))
                                val cat = categories(repository.profile).find { it.id == task.optString("cat") }
                                Text("${cat?.emoji ?: "✨"} ${cat?.label ?: task.optString("cat")}  ·  ${displayTime(task, repository.settings)}" + if (task.optString("priority", "none") != "none") "  ·  ${task.optString("priority")}" else "", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                            IconButton(onClick = { onFocus(row.date, task) }, modifier = Modifier.size(32.dp)) { Icon(Icons.Default.PlayCircle, "Focus on this task", tint = MaterialTheme.colorScheme.primary) }
                        }
                        if (task.arr("subtasks").length() > 0 || task.arr("comments").length() > 0 || task.optLong("focusSeconds") > 0 || task.optInt("pomodoros") > 0) {
                            Spacer(Modifier.height(10.dp))
                            val subtasks = task.arr("subtasks").objects()
                            Text(listOfNotNull(if (subtasks.isNotEmpty()) "${subtasks.count { it.optBoolean("done") }}/${subtasks.size} subtasks" else null,
                                if (task.arr("comments").length() > 0) "${task.arr("comments").length()} comments" else null,
                                if (task.optInt("pomodoros") > 0) "🍅 ${task.optInt("pomodoros")}" else null,
                                if (task.optLong("focusSeconds") > 0) "${task.optLong("focusSeconds") / 60}m focus" else null).joinToString("  ·  "), style = MaterialTheme.typography.labelSmall)
                        }
                        if (!task.isNull("rolledTo")) Text("Carried to ${task.optString("rolledTo")}", style = MaterialTheme.typography.labelSmall)
                        if (!task.isNull("rolledFrom")) Text("Continued from ${task.optString("rolledFrom")}", style = MaterialTheme.typography.labelSmall)
                        if (scope == "Archived") TextButton(onClick = { repository.mutateProfile { setTaskArchived(it, row.date, id, false) } }) { Text("Restore activity") }
                    }
                }
            }
            }
        }
        Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(quick, { quick = it }, placeholder = { Text("Add an activity…") }, modifier = Modifier.weight(1f), singleLine = true, shape = RoundedCornerShape(14.dp))
            FilledIconButton(onClick = { if (quick.isNotBlank()) { repository.addTask(if (scope == "Daily log") date else today(), newTask(quick, category = repository.settings.optString("defaultCat", "work"))); quick = "" } else { edit = null; editDate = if (scope == "Daily log") date else today(); adding = true } }, modifier = Modifier.size(48.dp)) { Icon(Icons.Default.Add, "Add activity") }
            IconButton(onClick = { edit = null; editDate = if (scope == "Daily log") date else today(); adding = true }) { Icon(Icons.Default.EditNote, "Add activity with details") }
        }
    }
    if (adding) TaskEditor(repository, edit, editDate, { adding = false }) { targetDate, task ->
        if (edit == null) repository.addTask(targetDate, task) else repository.updateTask(editDate, task.getString("id")) { existing -> task.keyList().forEach { existing.put(it, task.opt(it)) } }
        adding = false
    }
    details?.let { ref -> repository.tasks(ref.date).find { it.optString("id") == ref.id }?.let { task ->
        TaskDetails(repository, ref.date, task, { details = null }, onEdit = { edit = task.copyJson(); editDate = ref.date; details = null; adding = true }, onFocus = { details = null; onFocus(ref.date, task) })
    } }
    if (showNotes) QuickNotesDialog(repository) { showNotes = false }
}

@Composable
fun DropChoice(label: String, value: String, choices: List<Pair<String, String>>, onChange: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }) { Text(choices.find { it.first == value }?.second ?: label); Icon(Icons.Default.ExpandMore, null, Modifier.size(16.dp)) }
        DropdownMenu(expanded, { expanded = false }) { choices.forEach { choice -> DropdownMenuItem(text = { Text(choice.second) }, onClick = { onChange(choice.first); expanded = false }) } }
    }
}

@Composable
fun TaskEditor(repository: AppRepository, initial: JSONObject?, initialDate: String, close: () -> Unit, save: (String, JSONObject) -> Unit) {
    var content by remember { mutableStateOf(initial?.optString("content") ?: "") }
    var notes by remember { mutableStateOf(initial?.optString("notes") ?: "") }
    var cat by remember { mutableStateOf(initial?.optString("cat") ?: repository.settings.optString("defaultCat", "work")) }
    var priority by remember { mutableStateOf(initial?.optString("priority") ?: "none") }
    var date by remember { mutableStateOf(initialDate) }
    var rollover by remember { mutableStateOf(initial?.optBoolean("autoRollover") ?: false) }
    var timeSpent by remember { mutableStateOf(initial?.optString("timeSpent") ?: "") }
    val validDate = runCatching { LocalDate.parse(date) }.isSuccess
    AlertDialog(onDismissRequest = close, title = { Text(if (initial == null) "New activity" else "Edit activity") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            OutlinedTextField(content, { content = it }, label = { Text("What would you like to do?") }, modifier = Modifier.fillMaxWidth())
            OutlinedTextField(notes, { notes = it }, label = { Text("Notes / description") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            Text("Add #hashtags to your title to organize activities.", style = MaterialTheme.typography.bodySmall)
            DropChoice("Category", cat, categories(repository.profile).map { it.id to "${it.emoji} ${it.label}" }) { cat = it }
            DropChoice("Priority", priority, listOf("none" to "No priority", "low" to "Low", "medium" to "Medium", "high" to "High")) { priority = it }
            if (initial == null) OutlinedTextField(date, { date = it }, label = { Text("Date (YYYY-MM-DD)") }, isError = !validDate, singleLine = true)
            OutlinedTextField(timeSpent, { timeSpent = it }, label = { Text("Time spent (optional)") }, placeholder = { Text("45 min") }, singleLine = true)
            Row(verticalAlignment = Alignment.CenterVertically) { Checkbox(rollover, { rollover = it }); Text("Automatically carry unfinished activity") }
        }
    }, confirmButton = { TextButton(enabled = content.isNotBlank() && validDate, onClick = {
        val task = initial?.copyJson() ?: newTask(content)
        task.put("content", content.trim()).put("notes", notes).put("cat", cat).put("priority", priority).put("autoRollover", rollover).put("timeSpent", timeSpent)
        task.put("tags", newTask(content).arr("tags")); save(date, task)
    }) { Text("Save activity") } }, dismissButton = { TextButton(onClick = close) { Text("Cancel") } })
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskDetails(repository: AppRepository, date: String, task: JSONObject, close: () -> Unit, onEdit: () -> Unit, onFocus: () -> Unit) {
    val id = task.getString("id")
    var subtask by remember { mutableStateOf("") }; var comment by remember { mutableStateOf("") }
    var carryDate by remember { mutableStateOf(LocalDate.parse(date).plusDays(1).toString()) }
    var delete by remember { mutableStateOf(false) }
    var editingPart by remember { mutableStateOf<Pair<String, String>?>(null) }
    var partText by remember { mutableStateOf("") }
    ModalBottomSheet(onDismissRequest = close) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(task.optString("content"), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            if (task.optString("notes").isNotBlank()) Text(task.optString("notes"))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = onFocus) { Icon(Icons.Default.PlayArrow, "Focus on activity"); Text("Focus") }
                OutlinedButton(onClick = onEdit) { Text("Edit") }
                IconButton(onClick = { repository.mutateProfile { setTaskArchived(it, date, id, !taskIsArchived(task, repository.settings)) }; close() }) { Icon(if (taskIsArchived(task, repository.settings)) Icons.Default.Unarchive else Icons.Default.Archive, "Archive or restore") }
                IconButton(onClick = { delete = true }) { Icon(Icons.Default.DeleteOutline, "Delete activity") }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                listOf(-1 to "Move earlier", 1 to "Move later").forEach { (direction, label) -> TextButton(onClick = {
                    repository.mutateProfile { p -> val list = p.obj("entries").arr(date).objects().toMutableList(); val at = list.indexOfFirst { it.optString("id") == id }; val to = (at + direction).coerceIn(0, list.lastIndex); if (at >= 0 && at != to) { val moved = list.removeAt(at); list.add(to, moved); p.obj("entries").put(date, JSONArray(list)) } }
                }) { Text(label) } }
            }
            Text("Subtasks", style = MaterialTheme.typography.titleMedium)
            task.arr("subtasks").objects().forEach { sub ->
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Checkbox(sub.optBoolean("done"), { checked -> repository.updateTask(date, id) { t -> t.arr("subtasks").objects().find { it.optString("id") == sub.optString("id") }?.put("done", checked) } })
                    Text(sub.optString("text"), Modifier.weight(1f).clickable { editingPart = "subtasks" to sub.optString("id"); partText = sub.optString("text") }, textDecoration = if (sub.optBoolean("done")) TextDecoration.LineThrough else TextDecoration.None)
                    IconButton(onClick = { repository.updateTask(date, id) { t -> val list = t.arr("subtasks").objects().toMutableList(); val at = list.indexOfFirst { it.optString("id") == sub.optString("id") }; if (at > 0) { val moved = list.removeAt(at); list.add(at - 1, moved); t.put("subtasks", JSONArray(list)) } } }, Modifier.size(30.dp)) { Icon(Icons.Default.ArrowUpward, "Move subtask up", Modifier.size(16.dp)) }
                    IconButton(onClick = { repository.updateTask(date, id) { t -> t.put("subtasks", JSONArray(t.arr("subtasks").objects().filterNot { it.optString("id") == sub.optString("id") })) } }) { Icon(Icons.Default.Close, "Remove subtask") }
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                OutlinedTextField(subtask, { subtask = it }, label = { Text("Add subtask") }, modifier = Modifier.weight(1f))
                IconButton(enabled = subtask.isNotBlank(), onClick = { repository.updateTask(date, id) { it.arr("subtasks").put(JSONObject().put("id", newId()).put("text", subtask.trim()).put("done", false)) }; subtask = "" }) { Icon(Icons.Default.Add, "Add subtask") }
            }
            HorizontalDivider(); Text("Comments", style = MaterialTheme.typography.titleMedium)
            task.arr("comments").objects().forEach { c ->
                Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)) {
                    Column(Modifier.padding(12.dp)) { Text(c.optString("text"), Modifier.clickable { editingPart = "comments" to c.optString("id"); partText = c.optString("text") }); Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(displayTime(c, repository.settings), Modifier.weight(1f), style = MaterialTheme.typography.labelSmall)
                        IconButton(onClick = { repository.updateTask(date, id) { t -> t.put("comments", JSONArray(t.arr("comments").objects().filterNot { it.optString("id") == c.optString("id") })) } }, Modifier.size(26.dp)) { Icon(Icons.Default.Close, "Remove comment", Modifier.size(16.dp)) }
                    } }
                }
            }
            OutlinedTextField(comment, { comment = it }, label = { Text("Add a comment") }, modifier = Modifier.fillMaxWidth())
            TextButton(enabled = comment.isNotBlank(), onClick = { repository.updateTask(date, id) { it.arr("comments").put(JSONObject().put("id", newId()).put("text", comment.trim()).put("time", nowTime()).put("ts", System.currentTimeMillis())) }; comment = "" }) { Text("Post comment") }
            HorizontalDivider(); Text("Carry activity forward", style = MaterialTheme.typography.titleMedium)
            OutlinedTextField(carryDate, { carryDate = it }, label = { Text("Target date (YYYY-MM-DD)") }, singleLine = true)
            OutlinedButton(enabled = runCatching { LocalDate.parse(carryDate) > LocalDate.parse(date) }.getOrDefault(false) && !task.optBoolean("done") && !taskIsArchived(task, repository.settings) && task.isNull("rolledTo"), onClick = { repository.carryTask(date, id, carryDate); close() }) { Text("Carry to selected day") }
            Spacer(Modifier.height(32.dp))
        }
    }
    if (delete) AlertDialog(onDismissRequest = { delete = false }, title = { Text("Delete this activity?") }, text = { Text("Its notes, subtasks and comments will also be removed. Focus session history is retained.") }, confirmButton = { TextButton(onClick = { repository.removeTask(date, id); close() }) { Text("Delete") } }, dismissButton = { TextButton(onClick = { delete = false }) { Text("Keep activity") } })
    editingPart?.let { (kind, partId) -> AlertDialog(onDismissRequest = { editingPart = null }, title = { Text(if (kind == "subtasks") "Edit subtask" else "Edit comment") }, text = { OutlinedTextField(partText, { partText = it }, label = { Text("Text") }, modifier = Modifier.fillMaxWidth()) }, confirmButton = { TextButton(enabled = partText.isNotBlank(), onClick = { repository.updateTask(date, id) { t -> t.arr(kind).objects().find { it.optString("id") == partId }?.put("text", partText.trim()) }; editingPart = null }) { Text("Save") } }, dismissButton = { TextButton(onClick = { editingPart = null }) { Text("Cancel") } }) }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuickNotesDialog(repository: AppRepository, close: () -> Unit) {
    var text by remember { mutableStateOf("") }; var editing by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = close) {
        Column(Modifier.fillMaxWidth().padding(24.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text("Quick notes", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Text("A small place for ideas before they become activities.", style = MaterialTheme.typography.bodySmall)
            OutlinedTextField(text, { text = it }, label = { Text(if (editing == null) "Capture an idea…" else "Edit note") }, minLines = 3, modifier = Modifier.fillMaxWidth())
            Button(enabled = text.isNotBlank(), onClick = {
                repository.mutateProfile { p ->
                    if (editing == null) p.put("quickNotes", JSONArray(listOf(JSONObject().put("id", newId()).put("text", text).put("time", nowTime()).put("ts", System.currentTimeMillis())) + p.arr("quickNotes").objects()))
                    else p.arr("quickNotes").objects().find { it.optString("id") == editing }?.put("text", text)
                }; text = ""; editing = null
            }) { Text("Save note") }
            repository.profile.arr("quickNotes").objects().forEach { note ->
                Card(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                    Text(note.optString("text")); Row {
                        TextButton(onClick = { editing = note.optString("id"); text = note.optString("text") }) { Text("Edit") }
                        TextButton(onClick = { repository.addTask(today(), newTask(note.optString("text"))); repository.mutateProfile { p -> p.put("quickNotes", JSONArray(p.arr("quickNotes").objects().filterNot { it.optString("id") == note.optString("id") })) } }) { Text("Make activity") }
                        TextButton(onClick = { repository.mutateProfile { p -> p.put("quickNotes", JSONArray(p.arr("quickNotes").objects().filterNot { it.optString("id") == note.optString("id") })) } }) { Text("Delete") }
                    }
                } }
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}
