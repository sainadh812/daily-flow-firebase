package com.sainadh.dailyflow

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.security.MessageDigest

/** Pure schema-3 reducer. Receipt/segment deduplication and revision updates belong to the adapter. */
class SyncConflict(val code: String, message: String, val details: JSONObject = JSONObject()) : Exception(message)

object SyncProtocol {
    private fun json(vararg fields: Pair<String, Any?>): JSONObject = JSONObject().also { o -> fields.forEach { (k, v) -> o.put(k, v ?: JSONObject.NULL) } }
    private fun cloneValue(value: Any?): Any? = when (value) { is JSONObject -> value.copyJson(); is JSONArray -> JSONArray(value.toString()); else -> value }
    private fun safe(key: String) { require(key !in listOf("__proto__", "prototype", "constructor")) { "Unsafe field: $key" } }
    fun equal(a: Any?, b: Any?): Boolean {
        val an = a == null || a === JSONObject.NULL; val bn = b == null || b === JSONObject.NULL
        if (an || bn) return an && bn
        if (a is Number && b is Number) return a.toDouble() == b.toDouble()
        if (a is JSONObject && b is JSONObject) return a.keyList().sorted() == b.keyList().sorted() && a.keyList().all { equal(a.opt(it), b.opt(it)) }
        if (a is JSONArray && b is JSONArray) return a.length() == b.length() && (0 until a.length()).all { equal(a.opt(it), b.opt(it)) }
        return a == b
    }
    private fun slot(o: JSONObject, key: String): JSONObject = if (o.has(key)) present(o.opt(key)) else absent()
    private fun present(value: Any?): JSONObject = json("exists" to true, "value" to cloneValue(value))
    private fun absent(): JSONObject = json("exists" to false)
    private fun sameSlot(a: JSONObject, b: JSONObject): Boolean = a.optBoolean("exists") == b.optBoolean("exists") && (!a.optBoolean("exists") || equal(a.opt("value"), b.opt("value")))
    private fun stripMetrics(task: JSONObject): JSONObject = task.copyJson().also { it.remove("pomodoros"); it.remove("focusSeconds") }
    private fun lifecycle(task: JSONObject): JSONObject = JSONObject().also { g -> listOf("done", "archived", "rolledTo").forEach { g.put(it, slot(task, it)) } }
    // Match JSON.stringify exactly. Some org.json builds escape </, which would split tombstone keys across clients.
    private fun jsQuote(value: String): String = buildString {
        append('"'); value.forEach { c -> when (c) {
            '"' -> append("\\\""); '\\' -> append("\\\\"); '\b' -> append("\\b"); '\u000c' -> append("\\f"); '\n' -> append("\\n"); '\r' -> append("\\r"); '\t' -> append("\\t")
            else -> if (c.code < 32) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
        } }; append('"')
    }
    fun tombstoneKey(t: JSONObject): String = listOf("kind", "date", "taskId", "id").joinToString(prefix = "[", postfix = "]", separator = ",") { jsQuote(if (t.isNull(it)) "" else t.optString(it)) }
    fun sha256(value: String): String {
        // TextEncoder in JS replaces lone UTF-16 surrogates with U+FFFD. Match it on the JVM.
        val wellFormed = buildString {
            var i = 0
            while (i < value.length) {
                val c = value[i]
                when {
                    c.isHighSurrogate() && i + 1 < value.length && value[i + 1].isLowSurrogate() -> { append(c); append(value[++i]) }
                    c.isSurrogate() -> append('\uFFFD')
                    else -> append(c)
                }
                i++
            }
        }
        return MessageDigest.getInstance("SHA-256").digest(wellFormed.toByteArray(Charsets.UTF_8)).joinToString("") { (it.toInt() and 255).toString(16).padStart(2, '0') }
    }
    fun carryId(date: String, id: String, targetDate: String): String {
        val literal = "carry:$date:$id:$targetDate"
        return if (literal.length <= 180) literal else "carry-h:$date:${sha256(id)}:$targetDate"
    }
    private fun conflict(code: String, message: String, details: JSONObject = JSONObject()): Nothing = throw SyncConflict(code, message, details)
    private fun records(value: Any?, label: String): JSONArray {
        if (value == null || value === JSONObject.NULL) return JSONArray()
        require(value is JSONArray) { "$label must be an array" }
        val seen = mutableSetOf<String>()
        return JSONArray().also { out -> (0 until value.length()).forEach { index ->
            val item = value.optJSONObject(index)
            require(item != null && item.opt("id") is String && item.getString("id").isNotEmpty() && seen.add(item.getString("id"))) { "$label requires unique nonempty string ids" }
            out.put(item.copyJson())
        } }
    }
    private fun base(data: JSONObject): JSONObject = data.copyJson().also { d ->
        if (d.optDouble("schemaVersion", 0.0) > 3) conflict("schema", "This data requires a newer app version", json("schemaVersion" to d.opt("schemaVersion")))
        d.put("schemaVersion", 3)
        val revision = d.opt("revision") as? Number
        if (revision == null || revision.toDouble() < 0 || revision.toDouble() % 1.0 != 0.0 || revision.toDouble() > 9007199254740991.0) d.put("revision", 0)
        if (d.optJSONObject("tombstones") == null) d.put("tombstones", JSONObject())
    }
    fun normalizeProfile(data: JSONObject): JSONObject = base(data).also { d ->
        if (d.optJSONObject("entries") == null) d.put("entries", JSONObject())
        val entries = d.getJSONObject("entries")
        entries.keyList().forEach { date ->
            safe(date); val tasks = records(entries.opt(date), "entries.$date")
            tasks.objects().forEach { task -> listOf("subtasks", "comments").forEach { k -> if (task.has(k)) task.put(k, records(task.opt(k), k)) } }
            entries.put(date, tasks)
        }
        listOf("pomLog", "focusLog", "settings", "achievements").forEach { if (d.optJSONObject(it) == null) d.put(it, JSONObject()) }
        val achievements = d.getJSONObject("achievements")
        val unlocked = achievements.optJSONArray("unlocked") ?: JSONArray()
        achievements.put("unlocked", JSONArray((0 until unlocked.length()).mapNotNull { unlocked.opt(it) as? String }.distinct()))
        d.put("quickNotes", records(d.opt("quickNotes"), "quickNotes")); d.put("customCats", records(d.opt("customCats"), "customCats"))
    }
    fun normalizeMeta(data: JSONObject): JSONObject = base(data).also { d ->
        d.put("profiles", records(d.opt("profiles"), "profiles")); d.remove("activeProfile"); d.remove("activeProfileId")
    }
    private fun normalize(data: JSONObject): JSONObject = if (data.has("profiles") && !data.has("entries")) normalizeMeta(data) else normalizeProfile(data)
    private fun taskAt(d: JSONObject, date: String, id: String): JSONObject? = d.optJSONObject("entries")?.optJSONArray(date)?.objects()?.find { it.optString("id") == id }
    private fun checkGuard(task: JSONObject?, guard: JSONObject?, target: JSONObject) {
        if (task == null) conflict("deleted", "Task no longer exists", json("target" to target))
        guard?.keyList()?.forEach { field -> if (!sameSlot(slot(task, field), guard.getJSONObject(field))) conflict("lifecycle", "Task lifecycle changed", json("target" to target, "field" to field, "expected" to guard.getJSONObject(field), "actual" to slot(task, field))) }
    }
    private fun listAt(d: JSONObject, target: JSONObject, create: Boolean): JSONArray {
        val kind = target.getString("kind")
        if (kind == "task" || kind == "tasks") {
            val entries = d.optJSONObject("entries") ?: error("Task operation requires a profile")
            val date = target.getString("date"); safe(date)
            if (entries.optJSONArray(date) == null && create) entries.put(date, JSONArray())
            return entries.optJSONArray(date) ?: JSONArray()
        }
        if (kind in listOf("subtask", "subtasks", "comment", "comments")) {
            val task = taskAt(d, target.getString("date"), target.getString("taskId")) ?: conflict("deleted", "Parent task no longer exists", json("target" to target))
            val key = if (kind.startsWith("subtask")) "subtasks" else "comments"
            if (task.optJSONArray(key) == null && create) task.put(key, JSONArray())
            return task.optJSONArray(key) ?: JSONArray()
        }
        val key = when (kind) { "quickNote", "quickNotes" -> "quickNotes"; "customCat", "customCats" -> "customCats"; "profile", "profiles" -> "profiles"; else -> error("Unknown collection: $kind") }
        return d.optJSONArray(key) ?: error("Missing collection: $key")
    }
    private fun parentGuard(d: JSONObject, target: JSONObject, guard: JSONObject?) {
        if (target.optString("kind") in listOf("subtask", "subtasks", "comment", "comments")) checkGuard(taskAt(d, target.getString("date"), target.getString("taskId")), guard, target)
    }
    private fun applyPatch(d: JSONObject, op: JSONObject) {
        val target = op.getJSONObject("target"); val kind = target.getString("kind")
        val dest = when (kind) { "settings" -> d.optJSONObject("settings"); "task" -> taskAt(d, target.getString("date"), target.getString("id")); else -> null } ?: conflict("deleted", "Patch target no longer exists", json("target" to target))
        if (kind == "task") checkGuard(dest, op.optJSONObject("guard"), target)
        val changes = op.getJSONObject("changes")
        changes.keyList().forEach { field ->
            safe(field); require(kind != "task" || field !in listOf("id", "subtasks", "comments", "pomodoros", "focusSeconds")) { "Field requires a semantic operation: $field" }
            val change = changes.getJSONObject(field); val current = slot(dest, field)
            if (!sameSlot(current, change.getJSONObject("before")) && !sameSlot(current, change.getJSONObject("after"))) conflict("field", "Field was edited on another device", json("target" to target, "field" to field, "expected" to change.getJSONObject("before"), "actual" to current, "proposed" to change.getJSONObject("after")))
        }
        changes.keyList().forEach { field -> val s = changes.getJSONObject(field).getJSONObject("after"); if (s.getBoolean("exists")) dest.put(field, cloneValue(s.opt("value")) ?: JSONObject.NULL) else dest.remove(field) }
    }
    private fun applyRecord(d: JSONObject, op: JSONObject) {
        val target = op.getJSONObject("target"); val kind = target.getString("kind"); val id = target.getString("id")
        parentGuard(d, target, op.optJSONObject("guard"))
        val list = listAt(d, target, true); val index = list.objects().indexOfFirst { it.optString("id") == id }
        val current = if (index < 0) absent() else present(if (kind == "task") stripMetrics(list.getJSONObject(index)) else list.getJSONObject(index))
        val before = op.getJSONObject("before"); val after = op.getJSONObject("after"); val key = tombstoneKey(target)
        val tombstones = d.getJSONObject("tombstones")
        if (after.getBoolean("exists") && tombstones.optBoolean(key)) conflict("deleted", "Deleted record cannot be recreated by a stale operation", json("target" to target))
        if (sameSlot(current, after)) { if (!after.getBoolean("exists")) tombstones.put(key, true); return }
        if (!sameSlot(current, before)) conflict(if (index < 0) "deleted" else "record", "Record changed on another device", json("target" to target, "expected" to before, "actual" to current, "proposed" to after))
        if (!after.getBoolean("exists")) { if (index >= 0) list.remove(index); tombstones.put(key, true) }
        else {
            val item = after.getJSONObject("value").copyJson(); require(item.optString("id") == id) { "Record id must match target" }
            if (kind == "task") { require(index < 0) { "Existing tasks must use field patches" }; item.put("pomodoros", 0); item.put("focusSeconds", 0) }
            if (index < 0) list.put(item) else list.put(index, item)
        }
    }
    private fun applyOrder(d: JSONObject, op: JSONObject) {
        val target = op.getJSONObject("target"); parentGuard(d, target, op.optJSONObject("guard"))
        val list = listAt(d, target, false); val items = list.objects(); val current = items.map { it.getString("id") }
        val before = op.getJSONArray("before").strings(); val after = op.getJSONArray("after").strings()
        require(before.distinct().size == before.size && after.distinct().size == after.size && before.sorted() == after.sorted()) { "Order must be a permutation of before ids" }
        val known = before.toSet(); val live = current.toSet(); val currentKnown = current.filter { it in known }; val beforeLive = before.filter { it in live }; val afterLive = after.filter { it in live }
        if (currentKnown == afterLive) return
        if (currentKnown != beforeLive) conflict("order", "List was reordered on another device", json("target" to target, "expected" to JSONArray(beforeLive), "actual" to JSONArray(currentKnown), "proposed" to JSONArray(afterLive)))
        val byId = items.associateBy { it.getString("id") }; var pos = 0
        val reordered = items.map { if (it.getString("id") in known) byId.getValue(afterLive[pos++]) else it }
        reordered.forEachIndexed { index, item -> list.put(index, item) }
    }
    private fun applyCarry(d: JSONObject, op: JSONObject) {
        val source = op.getJSONObject("source"); val date = source.getString("date"); val sourceId = source.getString("id"); val targetDate = op.getString("targetDate")
        val src = taskAt(d, date, sourceId); val id = carryId(date, sourceId, targetDate)
        require(targetDate > date) { "Carry date must be later than source date" }
        val existing = taskAt(d, targetDate, id)
        if (src?.optString("rolledTo") == targetDate && existing?.optString("rolledFromTaskId") == sourceId) return
        val tombstones = d.getJSONObject("tombstones")
        if (src == null || tombstones.optBoolean(tombstoneKey(json("kind" to "task", "date" to date, "id" to sourceId)))) conflict("deleted", "Carry source was deleted", json("source" to source))
        val legacyDismissed = d.getJSONObject("settings").optJSONArray("ghostDismissed")?.strings()?.contains(sourceId) == true
        if (src.optBoolean("done") || src.optBoolean("archived") || src.optBoolean("ghostDismissed") || legacyDismissed || (!src.isNull("rolledTo") && src.optString("rolledTo").isNotEmpty())) conflict("lifecycle", "Only an active uncarried task can be carried", json("source" to source))
        if (!equal(stripMetrics(src), op.getJSONObject("sourceBefore"))) conflict("record", "Carry source changed on another device", json("source" to source, "expected" to op.getJSONObject("sourceBefore"), "actual" to stripMetrics(src)))
        if (existing != null || tombstones.optBoolean(tombstoneKey(json("kind" to "task", "date" to targetDate, "id" to id)))) conflict("carry", "Carry destination already exists or was deleted", json("source" to source, "targetDate" to targetDate))
        val next = op.getJSONObject("target").copyJson().put("id", id).put("done", false).put("rolledFrom", date).put("rolledFromTaskId", sourceId).put("rolledTo", JSONObject.NULL).put("pomodoros", 0).put("focusSeconds", 0)
        val states = (src.optJSONArray("subtasks") ?: JSONArray()).objects().associateBy { it.getString("id") }
        val childList = next.optJSONArray("subtasks") ?: src.optJSONArray("subtasks") ?: JSONArray()
        next.put("subtasks", JSONArray(childList.objects().map { child -> child.copyJson().also { copy -> states[child.getString("id")]?.let { old -> if (old.has("done")) copy.put("done", old.opt("done")) else copy.remove("done") } } }))
        val sourceNext = op.getJSONObject("sourceAfter").copyJson().put("id", sourceId).put("rolledTo", targetDate)
        listOf("pomodoros", "focusSeconds").forEach { if (src.has(it)) sourceNext.put(it, src.opt(it)) }
        val entries = d.getJSONObject("entries"); val list = entries.getJSONArray(date); val index = list.objects().indexOfFirst { it.getString("id") == sourceId }; list.put(index, sourceNext)
        if (entries.optJSONArray(targetDate) == null) entries.put(targetDate, JSONArray())
        entries.getJSONArray(targetDate).put(next)
    }
    private fun validDate(value: String): Boolean = Regex("\\d{4}-\\d{2}-\\d{2}").matches(value) && runCatching { LocalDate.parse(value).toString() == value }.getOrDefault(false)
    fun applySegment(latest: JSONObject, segment: JSONObject): JSONObject {
        val d = normalizeProfile(latest); val s = segment; val kind = s.optString("kind"); val date = s.optString("date")
        val start = (s.opt("startedAt") as? Number)?.toDouble() ?: Double.NaN; val end = (s.opt("endedAt") as? Number)?.toDouble() ?: Double.NaN; val seconds = (s.opt("activeSeconds") as? Number)?.toDouble() ?: Double.NaN
        require(kind in listOf("pomodoro", "stopwatch") && validDate(date) && listOf("id", "sessionId", "profileId").all { s.opt(it) is String && s.getString(it).isNotEmpty() } && start.isFinite() && end.isFinite() && end >= start && seconds.isFinite() && seconds >= 0 && seconds <= (end - start) / 1000.0 + 1 && s.opt("completedPomodoro") is Boolean && (kind == "pomodoro" || !s.getBoolean("completedPomodoro"))) { "Invalid session segment" }
        val taskId = if (s.isNull("taskId")) null else s.opt("taskId") as? String
        val taskDate = if (s.isNull("taskDate")) null else s.opt("taskDate") as? String
        require((taskId == null && taskDate == null) || (taskId != null && taskId.isNotEmpty() && taskDate != null && validDate(taskDate))) { "Task attribution requires taskId and taskDate" }
        val count = if (s.getBoolean("completedPomodoro")) 1 else 0
        val poms = d.getJSONObject("pomLog"); poms.put(date, poms.optDouble(date, 0.0) + count)
        val focus = d.getJSONObject("focusLog"); focus.put(date, focus.optDouble(date, 0.0) + seconds)
        if (taskId != null && taskDate != null) taskAt(d, taskDate, taskId)?.let { task -> task.put("pomodoros", task.optDouble("pomodoros", 0.0) + count); task.put("focusSeconds", task.optDouble("focusSeconds", 0.0) + seconds) }
        return d
    }
    fun apply(latest: JSONObject, op: JSONObject): JSONObject {
        val type = op.getString("type")
        if (type == "segment") return applySegment(latest, op.getJSONObject("segment"))
        val metaTarget = op.optJSONObject("target")?.optString("kind") in listOf("profile", "profiles")
        val d = if (metaTarget) normalizeMeta(latest) else normalize(latest)
        when (type) {
            "noop" -> Unit
            "patch" -> applyPatch(d, op)
            "record" -> applyRecord(d, op)
            "order" -> applyOrder(d, op)
            "carry" -> applyCarry(d, op)
            "unlock" -> { val achievements = d.getJSONObject("achievements"); achievements.put("unlocked", JSONArray((achievements.getJSONArray("unlocked").strings() + op.getJSONArray("ids").strings()).distinct())) }
            "import-metrics" -> {
                val current = json("pomLog" to d.getJSONObject("pomLog"), "focusLog" to d.getJSONObject("focusLog"))
                if (!equal(current, op.getJSONObject("before")) && !equal(current, op.getJSONObject("after"))) conflict("metrics", "Metrics changed since import was prepared", json("expected" to op.getJSONObject("before"), "actual" to current))
                val after = op.getJSONObject("after")
                listOf("pomLog", "focusLog").forEach { key ->
                    val map = after.getJSONObject(key)
                    require(map.keyList().all { (map.opt(it) as? Number)?.toDouble()?.let { n -> n.isFinite() && n >= 0 } == true }) { "Imported metrics must be nonnegative finite numbers" }
                }
                require(!op.has("taskMetrics") || op.opt("taskMetrics") is JSONArray) { "taskMetrics must be an array" }
                val taskMetricArray = op.optJSONArray("taskMetrics") ?: JSONArray()
                val taskMetrics = taskMetricArray.objects(); val seen = mutableSetOf<String>()
                require(taskMetrics.size == taskMetricArray.length()) { "Task metrics must contain objects" }
                taskMetrics.forEach { m ->
                    val target = json("kind" to "task", "date" to m.getString("date"), "id" to m.getString("id")); val key = tombstoneKey(target)
                    require(seen.add(key)) { "Duplicate task metric import" }
                    val task = taskAt(d, m.getString("date"), m.getString("id"))
                    if (task == null || d.getJSONObject("tombstones").optBoolean(key)) conflict("deleted", "Cannot import metrics into a deleted task", json("target" to target))
                    listOf("pomodoros", "focusSeconds").forEach { field ->
                        val previous = m.getJSONObject("before").getJSONObject(field); val next = m.getJSONObject("after").getJSONObject(field)
                        val number = (next.opt("value") as? Number)?.toDouble()
                        require(previous.opt("exists") is Boolean && next.opt("exists") is Boolean && (!next.getBoolean("exists") || (number != null && number.isFinite() && number >= 0))) { "Task metric imports require valid before/after slots" }
                        val actual = slot(task, field)
                        if (!sameSlot(actual, previous) && !sameSlot(actual, next)) conflict("metrics", "Task metrics changed since import was prepared", json("target" to target, "field" to field, "expected" to previous, "actual" to actual))
                    }
                }
                d.put("pomLog", after.getJSONObject("pomLog").copyJson()); d.put("focusLog", after.getJSONObject("focusLog").copyJson())
                taskMetrics.forEach { m ->
                    val task = taskAt(d, m.getString("date"), m.getString("id"))!!
                    listOf("pomodoros", "focusSeconds").forEach { field -> val s = m.getJSONObject("after").getJSONObject(field); if (s.getBoolean("exists")) task.put(field, s.opt("value")) else task.remove(field) }
                }
            }
            else -> error("Unknown operation type: $type")
        }
        return d
    }
    private fun fieldChanges(before: JSONObject, after: JSONObject, excluded: Set<String> = emptySet()): JSONObject = JSONObject().also { changes ->
        (before.keyList() + after.keyList()).distinct().sorted().forEach { field -> if (field !in excluded) { safe(field); val a = slot(before, field); val b = slot(after, field); if (!sameSlot(a, b)) changes.put(field, json("before" to a, "after" to b)) } }
    }
    private fun diffList(before: List<JSONObject>, after: List<JSONObject>, kind: String, target: JSONObject, orderTarget: JSONObject, operations: MutableList<JSONObject>, guard: JSONObject? = null) {
        val a = before.associateBy { it.getString("id") }; val b = after.associateBy { it.getString("id") }
        fun record(id: String, previous: JSONObject, next: JSONObject): JSONObject = json("type" to "record", "target" to target.copyJson().put("kind", kind).put("id", id), "before" to previous, "after" to next).also { if (guard != null) it.put("guard", guard.copyJson()) }
        before.forEach { item -> if (!b.containsKey(item.getString("id"))) operations += record(item.getString("id"), present(if (kind == "task") stripMetrics(item) else item), absent()) }
        after.forEach { item -> val old = a[item.getString("id")]; if (old == null || (kind != "task" && !equal(old, item))) operations += record(item.getString("id"), if (old == null) absent() else present(old), present(if (kind == "task") stripMetrics(item) else item)) }
        val intermediate = before.filter { b.containsKey(it.getString("id")) }.map { it.getString("id") } + after.filter { !a.containsKey(it.getString("id")) }.map { it.getString("id") }
        val desired = after.map { it.getString("id") }
        if (intermediate != desired) operations += json("type" to "order", "target" to orderTarget.copyJson(), "before" to JSONArray(intermediate), "after" to JSONArray(desired)).also { if (guard != null) it.put("guard", guard.copyJson()) }
    }
    fun diffProfile(before: JSONObject, after: JSONObject): List<JSONObject> {
        if (before.has("profiles") && !before.has("entries")) return diffMeta(before, after)
        var a = normalizeProfile(before); val b = normalizeProfile(after); val ops = mutableListOf<JSONObject>(); val used = mutableSetOf<String>()
        a.getJSONObject("entries").keyList().sorted().forEach { date -> a.getJSONObject("entries").getJSONArray(date).objects().forEach sourceLoop@ { source ->
            val sourceId = source.getString("id"); val changed = taskAt(b, date, sourceId) ?: return@sourceLoop
            val wasCarried = !source.isNull("rolledTo") && source.optString("rolledTo").isNotEmpty()
            val targetDate = if (changed.isNull("rolledTo")) "" else changed.optString("rolledTo")
            if (wasCarried || targetDate.isEmpty() || targetDate == source.optString("rolledTo")) return@sourceLoop
            val candidates = (b.getJSONObject("entries").optJSONArray(targetDate) ?: JSONArray()).objects().filter { t -> taskAt(a, targetDate, t.getString("id")) == null && t.getString("id") !in used && t.optString("rolledFrom") == date && (if (t.has("rolledFromTaskId") && !t.isNull("rolledFromTaskId") && t.optString("rolledFromTaskId").isNotEmpty()) t.optString("rolledFromTaskId") == sourceId else equal(t.opt("content"), source.opt("content"))) }
            if (candidates.size != 1) conflict("carry", "Carry must identify exactly one new target task", json("source" to json("date" to date, "id" to sourceId), "targetDate" to targetDate))
            val target = candidates.single(); val oldId = target.getString("id")
            val op = json("type" to "carry", "source" to json("date" to date, "id" to sourceId), "targetDate" to targetDate, "sourceBefore" to stripMetrics(source), "sourceAfter" to stripMetrics(changed), "target" to stripMetrics(target))
            ops += op; used += oldId; a = apply(a, op)
            val canonical = taskAt(a, targetDate, carryId(date, sourceId, targetDate))!!
            val targetList = b.getJSONObject("entries").getJSONArray(targetDate); targetList.put(targetList.objects().indexOfFirst { it.getString("id") == oldId }, canonical.copyJson())
        } }
        val settings = fieldChanges(a.getJSONObject("settings"), b.getJSONObject("settings"))
        if (settings.length() > 0) ops += json("type" to "patch", "target" to json("kind" to "settings"), "changes" to settings)
        val unlocked = b.getJSONObject("achievements").getJSONArray("unlocked").strings().filter { it !in a.getJSONObject("achievements").getJSONArray("unlocked").strings() }
        if (unlocked.isNotEmpty()) ops += json("type" to "unlock", "ids" to JSONArray(unlocked))
        val dates = (a.getJSONObject("entries").keyList() + b.getJSONObject("entries").keyList()).distinct().sorted()
        dates.forEach { date ->
            val oldList = (a.getJSONObject("entries").optJSONArray(date) ?: JSONArray()).objects(); val newList = (b.getJSONObject("entries").optJSONArray(date) ?: JSONArray()).objects()
            newList.forEach taskLoop@ { task ->
                val old = oldList.find { it.getString("id") == task.getString("id") } ?: return@taskLoop; val guard = lifecycle(old); val target = json("date" to date, "taskId" to task.getString("id"))
                diffList((old.optJSONArray("subtasks") ?: JSONArray()).objects(), (task.optJSONArray("subtasks") ?: JSONArray()).objects(), "subtask", target, target.copyJson().put("kind", "subtasks"), ops, guard)
                diffList((old.optJSONArray("comments") ?: JSONArray()).objects(), (task.optJSONArray("comments") ?: JSONArray()).objects(), "comment", target, target.copyJson().put("kind", "comments"), ops, guard)
                val changes = fieldChanges(old, task, setOf("id", "subtasks", "comments", "pomodoros", "focusSeconds"))
                if (changes.length() > 0) ops += json("type" to "patch", "target" to json("kind" to "task", "date" to date, "id" to task.getString("id")), "changes" to changes, "guard" to guard)
            }
            diffList(oldList, newList, "task", json("date" to date), json("kind" to "tasks", "date" to date), ops)
        }
        diffList(a.getJSONArray("quickNotes").objects(), b.getJSONArray("quickNotes").objects(), "quickNote", JSONObject(), json("kind" to "quickNotes"), ops)
        diffList(a.getJSONArray("customCats").objects(), b.getJSONArray("customCats").objects(), "customCat", JSONObject(), json("kind" to "customCats"), ops)
        return ops
    }
    fun diffMeta(before: JSONObject, after: JSONObject): List<JSONObject> {
        val a = normalizeMeta(before); val b = normalizeMeta(after); val operations = mutableListOf<JSONObject>()
        diffList(a.getJSONArray("profiles").objects(), b.getJSONArray("profiles").objects(), "profile", JSONObject(), json("kind" to "profiles"), operations)
        return operations
    }
}
