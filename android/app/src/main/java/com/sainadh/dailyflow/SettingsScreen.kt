package com.sainadh.dailyflow

import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.*

private data class ImportPreview(val data: JSONObject, val owner: String, val profileId: String, val baseline: String)

@Composable
fun SettingsScreen(repository: AppRepository, activity: MainActivity) {
    val scope = rememberCoroutineScope()
    var exportFormat by remember { mutableStateOf("json") }
    var exportBytes by remember { mutableStateOf<ByteArray?>(null) }
    var incoming by remember { mutableStateOf<ImportPreview?>(null) }
    var importOwner by remember { mutableStateOf("") }; var importProfile by remember { mutableStateOf("") }; var importBaseline by remember { mutableStateOf("") }
    var reviewConflict by remember { mutableStateOf<PendingOperation?>(null) }
    var transferMessage by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var catName by remember { mutableStateOf("") }
    var catEmoji by remember { mutableStateOf("✨") }
    var rename by remember(repository.activeProfileId) { mutableStateOf(repository.profiles.find { it.optString("id") == repository.activeProfileId }?.optString("name") ?: "") }
    var profileEmoji by remember(repository.activeProfileId) { mutableStateOf(repository.profiles.find { it.optString("id") == repository.activeProfileId }?.optString("emoji") ?: "👤") }
    var removeProfile by remember { mutableStateOf(false) }
    val createFile = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument(Transfer.formats.find { it.id == exportFormat }!!.mime)) { uri ->
        if (uri != null && exportBytes != null) scope.launch {
            runCatching { withContext(Dispatchers.IO) { activity.contentResolver.openOutputStream(uri)?.use { it.write(exportBytes!!) } ?: error("Cannot open the destination file.") } }
                .onSuccess { transferMessage = "Export saved." }.onFailure { transferMessage = it.localizedMessage ?: "Export failed." }
            exportBytes = null
        }
    }
    val openFile = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) scope.launch {
            busy = true
            runCatching {
                withContext(Dispatchers.IO) {
                    val name = activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { if (it.moveToFirst()) it.getString(0) else "import" } ?: "import"
                    val bytes = activity.contentResolver.openInputStream(uri)?.use { stream ->
                        val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                        while (true) { val size = stream.read(buffer); if (size < 0) break; require(output.size() + size <= 20 * 1024 * 1024) { "Choose a file smaller than 20 MB." }; output.write(buffer, 0, size) }; output.toByteArray()
                    } ?: error("Cannot read this file.")
                    Transfer.parse(bytes, name)
                }
            }.onSuccess { incoming = ImportPreview(it, importOwner, importProfile, importBaseline) }.onFailure { transferMessage = it.localizedMessage ?: "Import failed." }
            busy = false
        }
    }
    fun setting(key: String, value: Any) = repository.mutateProfile { it.obj("settings").put(key, value) }
    val settings = repository.settings
    var warmth by remember(repository.activeProfileId, settings.optInt("warmLight")) { mutableFloatStateOf(settings.optInt("warmLight", 0).toFloat()) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        Text("Make DailyFlow yours", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Focus rhythm", style = MaterialTheme.typography.titleMedium)
        SettingNumber("Focus duration", settings.optInt("workDuration", 25), 1..180, "minutes") { setting("workDuration", it) }
        SettingNumber("Short break", settings.optInt("shortBreakDuration", 5), 1..60, "minutes") { setting("shortBreakDuration", it) }
        SettingNumber("Long break", settings.optInt("longBreakDuration", 15), 1..120, "minutes") { setting("longBreakDuration", it) }
        SettingNumber("Long break interval", settings.optInt("longBreakInterval", 4), 1..12, "sessions") { setting("longBreakInterval", it) }
        SettingSwitch("Start breaks automatically", settings.optBoolean("autoStartBreaks")) { setting("autoStartBreaks", it) }
        SettingSwitch("Start focus automatically", settings.optBoolean("autoStartWork")) { setting("autoStartWork", it) }
        SettingNumber("Daily focus goal", settings.optInt("dailyGoal", 0), 0..24, "pomodoros") { setting("dailyGoal", it) }
        DropChoice("Timer sound", settings.optString("timerSound", "beep"), listOf("beep" to "Beep", "bell" to "Bell", "chime" to "Chime", "gentle" to "Gentle", "none" to "Silent")) { setting("timerSound", it) }
        OutlinedButton(onClick = { activity.requestNotifications(); setting("desktopNotifs", true) }) { Icon(Icons.Default.NotificationsActive, null); Spacer(Modifier.width(8.dp)); Text("Enable timer notifications") }
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            val exact = activity.getSystemService(android.app.AlarmManager::class.java).canScheduleExactAlarms()
            Text(if (exact) "Precise timer alerts are enabled." else "For timely alerts while your phone sleeps, allow precise alarms. Without this access Android may delay the fallback alert.", style = MaterialTheme.typography.bodySmall)
            if (!exact) TextButton(onClick = { activity.startActivity(android.content.Intent(android.provider.Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, android.net.Uri.parse("package:${activity.packageName}"))) }) { Text("Allow precise timer alerts") }
        }
        HorizontalDivider()
        Text("Appearance", style = MaterialTheme.typography.titleMedium)
        SettingSwitch("Dark appearance", settings.optBoolean("dark")) { setting("dark", it) }
        Text("Warm light · ${warmth.toInt()}%", style = MaterialTheme.typography.bodyMedium)
        Slider(warmth, { warmth = it }, valueRange = 0f..100f, onValueChangeFinished = { setting("warmLight", warmth.toInt()) })
        SettingSwitch("Distraction-free focus view", settings.optBoolean("focusMode")) { setting("focusMode", it) }
        DropChoice("Timer ring", settings.optString("ringStyle", "solid"), listOf("solid" to "Solid ring", "dashed" to "Dashed ring", "dots" to "Dotted ring")) { setting("ringStyle", it) }
        Text("Accent color", style = MaterialTheme.typography.bodyMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            listOf("#7C3AED", "#3B82F6", "#10B981", "#F59E0B", "#EC4899", "#EF4444").forEach { color ->
                Box(Modifier.size(36.dp).background(Color(android.graphics.Color.parseColor(color)), CircleShape).clickable { setting("accentColor", color) }, contentAlignment = Alignment.Center) { if (settings.optString("accentColor", "#7C3AED").equals(color, true)) Icon(Icons.Default.Check, "Selected", tint = Color.White, modifier = Modifier.size(22.dp)) }
            }
        }
        SettingNumber("Text size", settings.optInt("fontSize", 16), 12..24, "pt") { setting("fontSize", it) }
        SettingSwitch("24-hour time", settings.optBoolean("timeFormat24")) { setting("timeFormat24", it) }
        DropChoice("Display timezone", settings.optString("timezone", "local"), listOf("local" to "Device timezone", "UTC" to "UTC", "Asia/Kolkata" to "India", "America/New_York" to "New York", "America/Los_Angeles" to "Los Angeles", "Europe/London" to "London", "Asia/Tokyo" to "Tokyo")) { setting("timezone", it) }
        SettingSwitch("Week starts Monday", settings.optBoolean("weekStartMonday", true)) { setting("weekStartMonday", it) }
        SettingSwitch("Automatically carry unfinished activities", settings.optBoolean("autoRollover")) { setting("autoRollover", it) }
        SettingSwitch("End-of-day summary", settings.optBoolean("endOfDaySummary")) { setting("endOfDaySummary", it) }
        Text("See the previous visited day's recap when you next open DailyFlow on a later day. This does not schedule a background notification.", style = MaterialTheme.typography.bodySmall)
        DropChoice("Default category", settings.optString("defaultCat", "work"), categories(repository.profile).map { it.id to "${it.emoji} ${it.label}" }) { setting("defaultCat", it) }
        HorizontalDivider()
        Text("Custom categories", style = MaterialTheme.typography.titleMedium)
        repository.profile.arr("customCats").objects().forEach { c ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("${c.optString("emoji")} ${c.optString("label")}", Modifier.weight(1f))
                IconButton(onClick = { repository.mutateProfile { p ->
                    p.put("customCats", JSONArray(p.arr("customCats").objects().filterNot { it.optString("id") == c.optString("id") }))
                    p.obj("entries").keyList().forEach { d -> p.obj("entries").arr(d).objects().filter { it.optString("cat") == c.optString("id") }.forEach { it.put("cat", "other") } }
                } }) { Icon(Icons.Default.DeleteOutline, "Delete category") }
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(catEmoji, { catEmoji = it }, label = { Text("Icon") }, modifier = Modifier.width(76.dp), singleLine = true); OutlinedTextField(catName, { catName = it }, label = { Text("Category name") }, modifier = Modifier.weight(1f), singleLine = true) }
        OutlinedButton(enabled = catName.isNotBlank(), onClick = { repository.mutateProfile { it.arr("customCats").put(JSONObject().put("id", "custom_${newId()}").put("label", catName.trim()).put("emoji", catEmoji.ifBlank { "✨" }).put("color", settings.optString("accentColor", "#7C3AED"))) }; catName = "" }) { Text("Add category") }
        HorizontalDivider()
        Text("Current workspace", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) { OutlinedTextField(profileEmoji, { profileEmoji = it }, label = { Text("Icon") }, modifier = Modifier.width(76.dp), singleLine = true); OutlinedTextField(rename, { rename = it }, label = { Text("Workspace name") }, modifier = Modifier.weight(1f), singleLine = true) }
        Row {
            TextButton(enabled = rename.isNotBlank(), onClick = { repository.mutateMeta { it.arr("profiles").objects().find { it.optString("id") == repository.activeProfileId }?.put("name", rename.trim())?.put("emoji", profileEmoji.ifBlank { "👤" }) } }) { Text("Save workspace") }
            TextButton(enabled = repository.profiles.size > 1, onClick = { removeProfile = true }) { Text("Remove workspace", color = MaterialTheme.colorScheme.error) }
        }
        HorizontalDivider()
        Text("Import & export", style = MaterialTheme.typography.titleMedium)
        Text("Export your current workspace. Import merges activities by ID and lets you review the file before making changes.", style = MaterialTheme.typography.bodySmall)
        DropChoice("Export format", exportFormat, Transfer.formats.map { it.id to it.label }) { exportFormat = it }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(enabled = !busy, onClick = {
                scope.launch { busy = true
                    runCatching { withContext(Dispatchers.Default) { Transfer.export(repository.profile, exportFormat) } }
                        .onSuccess { bytes -> exportBytes = bytes; createFile.launch("dailyflow-${today()}.${Transfer.formats.find { it.id == exportFormat }!!.extension}") }
                        .onFailure { transferMessage = it.localizedMessage ?: "Export failed." }
                    busy = false
                }
            }) { Icon(Icons.Default.FileDownload, null); Spacer(Modifier.width(8.dp)); Text("Export") }
            OutlinedButton(enabled = !busy, onClick = { importOwner = repository.owner; importProfile = repository.activeProfileId; importBaseline = repository.profile.toString(); openFile.launch(arrayOf("application/json", "text/*", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/octet-stream")) }) { Icon(Icons.Default.FileUpload, null); Spacer(Modifier.width(8.dp)); Text("Import") }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (transferMessage.isNotBlank()) Text(transferMessage, style = MaterialTheme.typography.bodySmall)
        if (repository.conflicts.isNotEmpty()) {
            HorizontalDivider(); Text("Review sync conflicts", style = MaterialTheme.typography.titleMedium)
            repository.conflicts.forEach { conflict -> Card {
                Column(Modifier.padding(12.dp)) {
                    Text(conflict.error, style = MaterialTheme.typography.bodyMedium)
                    Text("Your saved change is retained in the local queue. Keeping the cloud version discards this pending change.", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { reviewConflict = conflict }) { Text("Review saved change") }
                    TextButton(onClick = { repository.discardConflict(conflict) }) { Text("Keep cloud version") }
                }
            } }
        }
        Text("DailyFlow 1.0 · Native Android\nYour local database is private to this app. Running timer state stays on this device.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(12.dp))
    }
    incoming?.let { preview -> AlertDialog(onDismissRequest = { incoming = null }, title = { Text("Import this workspace data?") }, text = {
        Text("${Transfer.count(preview.data)} activities across ${preview.data.obj("entries").length()} days. Activities with matching IDs will be updated; other existing activities will be kept. Included settings and daily totals will be restored.")
    }, confirmButton = { TextButton(onClick = {
        runCatching {
            require(repository.owner == preview.owner && repository.activeProfileId == preview.profileId) { "The selected account or workspace changed. Choose the file again in the intended workspace." }
            require(SyncProtocol.equal(repository.profile, JSONObject(preview.baseline))) { "This workspace changed while you reviewed the import. Choose the file again to prepare an updated preview." }
            repository.importProfile(preview.data)
        }.onSuccess { transferMessage = "Import saved. Changes will sync when connected." }.onFailure { transferMessage = it.localizedMessage ?: "Import failed." }
        incoming = null
    }) { Text("Import data") } }, dismissButton = { TextButton(onClick = { incoming = null }) { Text("Cancel") } }) }
    if (removeProfile) AlertDialog(onDismissRequest = { removeProfile = false }, title = { Text("Remove this workspace?") }, text = { Text("It will disappear from your workspace list. Export a backup first if you want a portable copy.") }, confirmButton = { TextButton(onClick = {
        val id = repository.activeProfileId
        repository.mutateMeta { it.put("profiles", JSONArray(it.arr("profiles").objects().filterNot { p -> p.optString("id") == id })) }
        repository.selectProfile(repository.profiles.first().getString("id")); removeProfile = false
    }) { Text("Remove") } }, dismissButton = { TextButton(onClick = { removeProfile = false }) { Text("Keep") } })
    reviewConflict?.let { conflict -> AlertDialog(onDismissRequest = { reviewConflict = null }, title = { Text("Your saved change") }, text = {
        Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(conflict.error)
            Text("Copy this record to preserve your local version before resolving it.", style = MaterialTheme.typography.bodySmall)
            androidx.compose.foundation.text.selection.SelectionContainer { Text(JSONObject(conflict.json).toString(2), style = MaterialTheme.typography.bodySmall) }
        }
    }, confirmButton = { TextButton(onClick = { activity.getSystemService(android.content.ClipboardManager::class.java).setPrimaryClip(android.content.ClipData.newPlainText("DailyFlow saved change", JSONObject(conflict.json).toString(2))); transferMessage = "Saved change copied." }) { Text("Copy local change") } }, dismissButton = {
        Row { TextButton(onClick = { repository.keepLocalConflict(conflict); reviewConflict = null }) { Text("Use my change") }; TextButton(onClick = { reviewConflict = null }) { Text("Close") } }
    }) }
}

@Composable
fun SettingSwitch(label: String, checked: Boolean, onChange: (Boolean) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { Text(label, Modifier.weight(1f)); Switch(checked, onChange) }
}
@Composable
fun SettingNumber(label: String, value: Int, range: IntRange, unit: String, onChange: (Int) -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) { Text(label); Text("$value $unit", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        IconButton(enabled = value > range.first, onClick = { onChange((value - 1).coerceIn(range)) }) { Icon(Icons.Default.Remove, "Decrease $label") }
        Text(value.toString(), fontWeight = FontWeight.SemiBold)
        IconButton(enabled = value < range.last, onClick = { onChange((value + 1).coerceIn(range)) }) { Icon(Icons.Default.Add, "Increase $label") }
    }
}
