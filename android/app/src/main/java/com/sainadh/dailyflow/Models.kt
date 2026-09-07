package com.sainadh.dailyflow

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.UUID

fun JSONObject.copyJson(): JSONObject = JSONObject(toString())
fun JSONObject.obj(key: String): JSONObject = optJSONObject(key) ?: JSONObject().also { put(key, it) }
fun JSONObject.arr(key: String): JSONArray = optJSONArray(key) ?: JSONArray().also { put(key, it) }
fun JSONArray.objects(): List<JSONObject> = (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray.strings(): List<String> = (0 until length()).map { optString(it) }
fun JSONObject.keyList(): List<String> = keys().asSequence().toList()
fun jsonArray(values: List<Any?>): JSONArray = JSONArray(values)
fun today(): String = LocalDate.now().toString()
fun newId(): String = UUID.randomUUID().toString()
fun nowTime(): String = LocalTime.now().format(DateTimeFormatter.ofPattern("HH:mm"))
fun displayTime(record: JSONObject, settings: JSONObject): String {
    val timestamp = record.optLong("ts")
    if (timestamp <= 0) return record.optString("time")
    val zone = runCatching { val name = settings.optString("timezone", "local"); if (name == "local") java.time.ZoneId.systemDefault() else java.time.ZoneId.of(name) }.getOrDefault(java.time.ZoneId.systemDefault())
    return java.time.Instant.ofEpochMilli(timestamp).atZone(zone).format(DateTimeFormatter.ofPattern(if (settings.optBoolean("timeFormat24")) "HH:mm" else "h:mm a"))
}

fun blankProfile(): JSONObject = JSONObject()
    .put("schemaVersion", 3).put("revision", 0).put("updatedAt", 0)
    .put("entries", JSONObject()).put("pomLog", JSONObject()).put("focusLog", JSONObject())
    .put("settings", JSONObject())
    .put("achievements", JSONObject().put("unlocked", JSONArray())).put("quickNotes", JSONArray()).put("customCats", JSONArray())

fun newTask(content: String, notes: String = "", category: String = "work", priority: String = "none"): JSONObject {
    val id = newId()
    return JSONObject().put("id", id).put("lineageId", id).put("content", content.trim()).put("notes", notes)
        .put("cat", category).put("priority", priority).put("tags", JSONArray(Regex("#([\\p{L}\\p{N}_-]+)").findAll(content).map { it.groupValues[1] }.toList()))
        .put("time", nowTime()).put("ts", System.currentTimeMillis()).put("done", false).put("archived", false)
        .put("pomodoros", 0).put("focusSeconds", 0).put("subtasks", JSONArray()).put("comments", JSONArray())
        .put("rolledFrom", JSONObject.NULL).put("rolledTo", JSONObject.NULL).put("autoRollover", false)
}

data class Category(val id: String, val label: String, val emoji: String, val color: String)
val baseCategories = listOf(Category("work", "Work", "💼", "#7C3AED"), Category("personal", "Personal", "🏠", "#3B82F6"),
    Category("health", "Health", "💪", "#10B981"), Category("study", "Study", "📚", "#F59E0B"), Category("creative", "Creative", "🎨", "#8B5CF6"), Category("other", "Other", "✨", "#6B7280"))
fun categories(profile: JSONObject): List<Category> = baseCategories + profile.arr("customCats").objects().map { Category(it.optString("id"), it.optString("label"), it.optString("emoji", "✨"), it.optString("color", "#7C3AED")) }

fun JSONObject.toMap(): Map<String, Any?> = keyList().associateWith { key ->
    when (val v = opt(key)) { JSONObject.NULL -> null; is JSONObject -> v.toMap(); is JSONArray -> v.toList(); else -> v }
}
fun JSONArray.toList(): List<Any?> = (0 until length()).map { i ->
    when (val v = opt(i)) { JSONObject.NULL -> null; is JSONObject -> v.toMap(); is JSONArray -> v.toList(); else -> v }
}
