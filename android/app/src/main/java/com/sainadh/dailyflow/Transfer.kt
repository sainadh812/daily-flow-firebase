package com.sainadh.dailyflow

import android.util.Xml
import org.json.*
import org.xmlpull.v1.XmlPullParser
import java.io.*
import java.security.MessageDigest
import java.time.LocalDate
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import java.util.Base64

/** Portable transfers use only platform JSON, XML and ZIP APIs. No network or file path permissions. */
object Transfer {
    data class Format(val id: String, val label: String, val mime: String, val extension: String)
    val formats = listOf(Format("json", "JSON backup", "application/json", "json"), Format("csv", "CSV table", "text/csv", "csv"),
        Format("markdown", "Markdown journal", "text/markdown", "md"), Format("xlsx", "Excel workbook", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "xlsx"))
    private val headers = listOf("Kind", "Date", "ID", "Title", "Details", "Data")
    fun export(profile: JSONObject, format: String): ByteArray {
        val data = JSONObject().put("format", "dailyflow-backup").put("version", 3)
            .put("exportedAt", java.time.Instant.now().toString()).put("data", profile.copyJson())
        val rows = mutableListOf(headers)
        profile.obj("entries").keyList().sorted().forEach { date -> profile.obj("entries").arr(date).objects().forEach { t -> rows += listOf("task", date, t.optString("id"), t.optString("content"), t.optString("notes"), t.toString()) } }
        val json = data.toString(); var offset = 0; var part = 0
        while (offset < json.length) {
            var end = minOf(json.length, offset + 16000)
            if (end < json.length && Character.isHighSurrogate(json[end - 1])) end--
            rows += listOf("backup-json", "", (part++).toString(), "json-string", "", JSONObject.quote(json.substring(offset, end))); offset = end
        }
        return when (format) {
            "csv" -> ("\uFEFF" + rows.joinToString("\r\n") { row -> row.joinToString(",") { cell -> "\"${safeCell(cell).replace("\"", "\"\"")}\"" } }).toByteArray()
            "markdown" -> buildString {
                append("# DailyFlow journal\n\n")
                profile.obj("entries").keyList().sorted().forEach { date ->
                    append("## $date\n\n")
                    profile.obj("entries").arr(date).objects().forEach { task ->
                        append("- [${if (task.optBoolean("done")) "x" else " "}] ${task.optString("content").replace("\n", " ")}\n")
                        if (task.optString("notes").isNotBlank()) append("\n  ${task.optString("notes").replace("\n", "\n  ")}\n")
                        task.arr("subtasks").objects().forEach { sub -> append("  - [${if (sub.optBoolean("done")) "x" else " "}] ${sub.optString("text").replace("\n", " ")}\n") }
                        append("\n")
                    }
                }
                append("<details>\n<summary>Full backup data for import</summary>\n\n```dailyflow-backup\n${data.toString(2)}\n```\n\n</details>\n")
            }.toByteArray()
            "xlsx" -> xlsx(rows, data)
            else -> data.toString(2).toByteArray()
        }
    }
    private fun safeCell(value: String): String = if (value.firstOrNull() in listOf('=', '+', '-', '@', '\t', '\r')) "'$value" else value
    private fun xml(value: String) = value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;").filter { it >= ' ' || it == '\n' || it == '\r' || it == '\t' }
    private fun column(index: Int): String { var i = index + 1; var s = ""; while (i > 0) { i--; s = ('A' + i % 26) + s; i /= 26 }; return s }
    private fun xlsx(rows: List<List<String>>, profile: JSONObject): ByteArray {
        val output = ByteArrayOutputStream()
        ZipOutputStream(output).use { zip ->
            fun entry(name: String, text: String) { zip.putNextEntry(ZipEntry(name)); zip.write(text.toByteArray()); zip.closeEntry() }
            entry("[Content_Types].xml", """<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="json" ContentType="application/json"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>""")
            entry("_rels/.rels", """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>""")
            entry("xl/workbook.xml", """<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="DailyFlow" sheetId="1" r:id="rId1"/></sheets></workbook>""")
            entry("xl/_rels/workbook.xml.rels", """<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>""")
            entry("xl/worksheets/sheet1.xml", buildString {
                append("<?xml version=\"1.0\"?><worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\"><sheetViews><sheetView workbookViewId=\"0\"><pane ySplit=\"1\" topLeftCell=\"A2\" activePane=\"bottomLeft\" state=\"frozen\"/></sheetView></sheetViews><cols><col min=\"1\" max=\"4\" width=\"16\" customWidth=\"1\"/><col min=\"5\" max=\"6\" width=\"48\" customWidth=\"1\"/><col min=\"7\" max=\"13\" width=\"18\" customWidth=\"1\"/></cols><sheetData>")
                rows.forEachIndexed { r, row -> append("<row r=\"${r + 1}\">"); row.forEachIndexed { c, cell -> append("<c r=\"${column(c)}${r + 1}\" t=\"inlineStr\"><is><t xml:space=\"preserve\">${xml(cell)}</t></is></c>") }; append("</row>") }
                append("</sheetData><autoFilter ref=\"A1:M${rows.size}\"/></worksheet>")
            })
            entry("dailyflow/profile.json", profile.toString())
        }
        return output.toByteArray()
    }
    fun parse(bytes: ByteArray, filename: String): JSONObject {
        require(bytes.size <= 20 * 1024 * 1024) { "Please choose a file smaller than 20 MB." }
        val text = bytes.toString(Charsets.UTF_8).trimStart('\uFEFF', ' ', '\n', '\r', '\t')
        val decoded = when {
            bytes.take(2) == listOf(80.toByte(), 75.toByte()) -> readXlsx(bytes)
            text.startsWith("{") -> JSONObject(text)
            filename.endsWith(".md", true) || text.startsWith("# ") -> {
                val encoded = Regex("<!-- dailyflow-data:([A-Za-z0-9+/=]+) -->").find(text)?.groupValues?.get(1)
                val fenced = Regex("```dailyflow-backup\\s*\\n([\\s\\S]*?)\\n```").find(text)?.groupValues?.get(1)
                if (fenced != null) JSONObject(fenced) else if (encoded != null) JSONObject(String(Base64.getDecoder().decode(encoded))) else parseMarkdown(text)
            }
            else -> fromRows(parseCsv(text))
        }
        require(decoded.optInt("version", decoded.optInt("schemaVersion", 1)) <= 3) { "This backup requires a newer DailyFlow version." }
        val result = if (decoded.optString("format") == "dailyflow-backup") decoded.getJSONObject("data") else decoded
        require(result.optInt("schemaVersion", 1) <= 3) { "This profile requires a newer DailyFlow version." }
        require(result.optJSONObject("entries") != null) { "This file does not contain DailyFlow activity data." }
        result.obj("entries").keyList().forEach { date ->
            require(runCatching { LocalDate.parse(date) }.isSuccess) { "Invalid activity date: $date" }
            require(result.obj("entries").optJSONArray(date) != null) { "Invalid activities for $date" }
            result.obj("entries").arr(date).objects().forEach { task ->
                require(validId(task.optString("id")) && task.opt("content") is String && task.optString("content").isNotBlank()) { "Every activity needs a safe ID and title." }
                listOf("subtasks", "comments").forEach { field -> task.arr(field).objects().forEach { record ->
                    require(validId(record.optString("id")) && record.opt("text") is String) { "Invalid $field record." }
                } }
                listOf("pomodoros", "focusSeconds").forEach { field -> if (task.has(field)) require(task.opt(field) is Number && task.optDouble(field).isFinite() && task.optDouble(field) >= 0) { "Invalid task metrics." } }
                require(!task.optString("time").contains(Regex("[<>]"))) { "Invalid task time." }
            }
        }
        listOf("quickNotes", "customCats").forEach { field -> result.arr(field).objects().forEach { require(validId(it.optString("id"))) { "Invalid $field ID." } } }
        result.arr("customCats").objects().forEach { category -> require(Regex("^#[0-9a-fA-F]{6}$").matches(category.optString("color")) && !Regex("[<>]").containsMatchIn(category.optString("label") + category.optString("emoji"))) { "Invalid category label, icon or color." } }
        listOf("pomLog", "focusLog").forEach { field -> result.optJSONObject(field)?.let { values -> values.keyList().forEach { key -> require(runCatching { LocalDate.parse(key) }.isSuccess && values.opt(key) is Number && values.optDouble(key).isFinite() && values.optDouble(key) >= 0) { "Invalid daily totals." } } } }
        // Both clients share these identity and schema checks before an import can be reviewed.
        SyncProtocol.normalizeProfile(result)
        return result
    }
    private fun validId(value: String) = value.length in 1..240 && Regex("^[A-Za-z0-9_.:%-]+$").matches(value)
    fun merge(current: JSONObject, incoming: JSONObject): JSONObject {
        val result = current.copyJson()
        incoming.obj("entries").keyList().forEach { date ->
            val merged = result.obj("entries").arr(date).objects().associateBy { it.optString("id") }.toMutableMap()
            incoming.obj("entries").arr(date).objects().forEach { merged[it.optString("id")] = it }
            result.obj("entries").put(date, JSONArray(merged.values.toList()))
        }
        listOf("quickNotes", "customCats").forEach { key ->
            if (incoming.has(key)) {
                val merged = result.arr(key).objects().associateBy { it.optString("id") }.toMutableMap()
                incoming.arr(key).objects().forEach { merged[it.optString("id")] = it }
                result.put(key, JSONArray(merged.values.toList()))
            }
        }
        listOf("settings", "pomLog", "focusLog").forEach { key -> incoming.optJSONObject(key)?.let { values -> values.keyList().forEach { result.obj(key).put(it, values.opt(it)) } } }
        incoming.optJSONObject("achievements")?.optJSONArray("unlocked")?.let { ids -> result.obj("achievements").put("unlocked", JSONArray((result.obj("achievements").arr("unlocked").strings() + ids.strings()).distinct())) }
        return result
    }
    fun count(profile: JSONObject) = profile.obj("entries").keyList().sumOf { profile.obj("entries").arr(it).length() }
    private fun parseCsv(text: String): List<List<String>> {
        val rows = mutableListOf<List<String>>(); val row = mutableListOf<String>(); val cell = StringBuilder(); var quoted = false; var i = 0
        while (i < text.length) {
            val c = text[i]
            when {
                c == '"' && quoted && i + 1 < text.length && text[i + 1] == '"' -> { cell.append('"'); i++ }
                c == '"' -> quoted = !quoted
                c == ',' && !quoted -> { row += cell.toString(); cell.clear() }
                (c == '\n' || c == '\r') && !quoted -> { row += cell.toString(); cell.clear(); if (row.any { it.isNotEmpty() }) rows += row.toList(); row.clear(); if(c == '\r' && i + 1 < text.length && text[i + 1] == '\n') i++ }
                else -> cell.append(c)
            }; i++
        }
        require(!quoted) { "The CSV contains an unclosed quoted cell." }
        row += cell.toString(); if (row.any { it.isNotEmpty() }) rows += row
        return rows
    }
    private fun fromRows(rows: List<List<String>>): JSONObject {
        require(rows.isNotEmpty()) { "The file is empty." }
        val parts = rows.filter { it.firstOrNull() == "backup-json" }.sortedBy { it.getOrNull(2)?.toIntOrNull() ?: -1 }
        if (parts.isNotEmpty()) {
            require(parts.withIndex().all { (index, row) -> row.getOrNull(2)?.toIntOrNull() == index }) { "Full backup data is incomplete." }
            return JSONObject(parts.joinToString("") { row ->
                val value = row.getOrElse(5) { "" }
                if (row.getOrNull(3) == "json-string") JSONTokener(value).nextValue() as String else value
            })
        }
        val columns = rows.first().map { it.lowercase().trim() }
        require("date" in columns && "content" in columns) { "The table needs Date and Content columns." }
        val result = blankProfile()
        rows.drop(1).forEachIndexed { index, row ->
            fun cell(name: String): String = row.getOrNull(columns.indexOf(name.lowercase())) ?: ""
            if (cell("content").isNotBlank()) {
                val date = cell("date").take(10)
                val raw = cell("taskjson")
                val task = if (raw.startsWith("{")) JSONObject(raw) else newTask(cell("content"), cell("notes"), cell("category").ifBlank { "other" }, cell("priority").ifBlank { "none" })
                    .put("id", cell("id").ifBlank { "import:" + MessageDigest.getInstance("SHA-256").digest((row.joinToString("|") + index).toByteArray()).take(12).joinToString("") { "%02x".format(it) } })
                    .put("time", cell("time")).put("done", cell("done").lowercase() in listOf("yes", "true", "1", "done"))
                    .put("pomodoros", cell("pomodoros").toIntOrNull() ?: 0).put("focusSeconds", cell("focusseconds").toLongOrNull() ?: 0).put("archived", cell("archived").toBoolean())
                result.obj("entries").arr(date).put(task)
            }
        }
        result.remove("settings"); result.remove("pomLog"); result.remove("focusLog")
        return result
    }
    private fun parseMarkdown(text: String): JSONObject {
        val result = blankProfile(); var date = today()
        text.lineSequence().forEach { line ->
            Regex("^## (\\d{4}-\\d{2}-\\d{2})").find(line)?.let { date = it.groupValues[1] }
            Regex("^- \\[([ xX])\\] (.+)$").find(line)?.let { m -> result.obj("entries").arr(date).put(newTask(m.groupValues[2]).put("done", m.groupValues[1].lowercase() == "x")) }
        }
        result.remove("settings"); result.remove("pomLog"); result.remove("focusLog")
        return result
    }
    private fun readXlsx(bytes: ByteArray): JSONObject {
        val entries = mutableMapOf<String, ByteArray>(); var total = 0; var entryCount = 0
        ZipInputStream(ByteArrayInputStream(bytes)).use { zip ->
            var item = zip.nextEntry
            while (item != null) {
                require(++entryCount <= 2000) { "The workbook has too many files." }
                if (!item.isDirectory) {
                    val selected = item.name == "dailyflow/profile.json" || item.name == "xl/sharedStrings.xml" || item.name.matches(Regex("xl/worksheets/sheet[0-9]+.xml"))
                    val output = ByteArrayOutputStream(); val buffer = ByteArray(8192)
                    while (true) { val count = zip.read(buffer); if (count < 0) break; total += count; require(total <= 40 * 1024 * 1024) { "The workbook expands beyond 40 MB." }; if (selected) output.write(buffer, 0, count) }
                    if (selected) entries[item.name] = output.toByteArray()
                }
                item = zip.nextEntry
            }
        }
        entries["dailyflow/profile.json"]?.let { return JSONObject(it.toString(Charsets.UTF_8)) }
        val shared = mutableListOf<String>()
        entries["xl/sharedStrings.xml"]?.let { xml ->
            val parser = Xml.newPullParser(); parser.setInput(ByteArrayInputStream(xml), "UTF-8"); var value = StringBuilder()
            while (parser.eventType != XmlPullParser.END_DOCUMENT) { if (parser.eventType == XmlPullParser.START_TAG && parser.name == "si") value = StringBuilder(); if(parser.eventType == XmlPullParser.START_TAG && parser.name == "t") value.append(parser.nextText()); if(parser.eventType == XmlPullParser.END_TAG && parser.name == "si") shared += value.toString(); parser.next() }
        }
        val sheet = entries["xl/worksheets/sheet1.xml"] ?: entries.entries.firstOrNull { it.key.startsWith("xl/worksheets/") }?.value ?: error("No activity sheet found.")
        val rows = mutableListOf<List<String>>(); var row = mutableListOf<String>(); var type = ""; var col = 0; var cellValue = StringBuilder()
        val parser = Xml.newPullParser(); parser.setInput(ByteArrayInputStream(sheet), "UTF-8")
        while (parser.eventType != XmlPullParser.END_DOCUMENT) {
            if (parser.eventType == XmlPullParser.START_TAG) when (parser.name) {
                "row" -> row = mutableListOf()
                "c" -> { type = parser.getAttributeValue(null, "t") ?: ""; val ref = parser.getAttributeValue(null, "r") ?: "A1"; col = ref.takeWhile { it.isLetter() }.fold(0) { n, c -> n * 26 + c.uppercaseChar().code - 64 } - 1; cellValue = StringBuilder() }
                "v", "t" -> cellValue.append(parser.nextText())
            }
            if (parser.eventType == XmlPullParser.END_TAG) when (parser.name) {
                "c" -> { while(row.size <= col) row += ""; row[col] = if(type == "s") shared.getOrNull(cellValue.toString().toIntOrNull() ?: -1) ?: "" else cellValue.toString() }
                "row" -> rows += row.toList()
            }
            parser.next()
        }
        return fromRows(rows)
    }
}
