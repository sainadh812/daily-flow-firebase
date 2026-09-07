package com.sainadh.dailyflow

import android.app.Application
import android.content.Context
import androidx.compose.runtime.*
import androidx.room.withTransaction
import com.google.firebase.FirebaseApp
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.tasks.await
import org.json.*

internal data class PendingProjection(val data: JSONObject, val conflicts: List<Pair<String, String>>)

/** Always replay over an acknowledged server baseline, never over the optimistic cached shadow. */
internal fun projectPendingDocument(base: JSONObject, pending: List<PendingOperation>): PendingProjection {
    var data = if (base.has("profiles") && !base.has("entries")) SyncProtocol.normalizeMeta(base) else SyncProtocol.normalizeProfile(base)
    val conflicts = mutableListOf<Pair<String, String>>()
    pending.sortedBy { JSONObject(it.json).optLong("seq") }.forEach { item ->
        val op = JSONObject(item.json)
        val acknowledged = base.optJSONObject("acks")?.optLong(op.optString("deviceId"), 0) ?: 0
        if (item.error.isEmpty() && op.optLong("seq") > acknowledged) {
            try { data = SyncProtocol.apply(data, op) }
            catch (e: Exception) { conflicts += item.id to (e.message ?: "Another device changed this item.") }
        }
    }
    return PendingProjection(data, conflicts)
}

internal fun chooseServerBaseline(previous: JSONObject?, incoming: JSONObject): JSONObject {
    val next = if (incoming.has("profiles") && !incoming.has("entries")) SyncProtocol.normalizeMeta(incoming) else SyncProtocol.normalizeProfile(incoming)
    if (previous == null) return next
    if (next.optLong("revision") < previous.optLong("revision")) return previous.copyJson()
    if (next.optLong("revision") == previous.optLong("revision")) {
        val oldAcks = previous.optJSONObject("acks") ?: JSONObject()
        if (oldAcks.keyList().any { key -> oldAcks.optLong(key) > (next.optJSONObject("acks")?.optLong(key) ?: 0) }) return previous.copyJson()
    }
    return next
}

internal fun retryableStreams(pending: List<PendingOperation>, uid: String): List<String> = pending
    .filter { it.owner == uid }
    .groupBy { it.profileId }
    .filterValues { rows -> rows.minByOrNull { JSONObject(it.json).optLong("seq") }?.error?.isEmpty() == true }
    .keys.toList()

internal fun reconcileProfileSelection(current: String, ids: List<String>, beforeChange: () -> Unit): String {
    val selected = if (current in ids) current else ids.firstOrNull() ?: ""
    if (current.isNotBlank() && selected != current) beforeChange()
    return selected
}

internal fun taskCanCarry(task: JSONObject, settings: JSONObject, sourceDate: String, targetDate: String, automatic: Boolean = false): Boolean {
    fun valid(date: String): Boolean = runCatching { java.time.LocalDate.parse(date).toString() == date }.getOrDefault(false)
    return valid(sourceDate) && valid(targetDate) && targetDate > sourceDate && !task.optBoolean("done") &&
        !taskIsArchived(task, settings) && (task.isNull("rolledTo") || task.optString("rolledTo").isBlank()) &&
        (!automatic || (settings.optBoolean("autoRollover") && task.optBoolean("autoRollover")))
}

internal fun orderLegacyArchiveOperations(operations: List<JSONObject>): List<JSONObject> {
    // Preserve explicit per-date archives before removing an old globally-scoped dismissed id.
    // All operations still share one local Room transaction; remote intermediate versions stay hidden.
    val (legacySettings, ordinary) = operations.partition { it.optString("type") == "patch" &&
        it.optJSONObject("target")?.optString("kind") == "settings" && it.optJSONObject("changes")?.has("ghostDismissed") == true }
    return ordinary + legacySettings
}

/** Explicit user conflict resolution, never automatic last-writer-wins. Envelope and proposed values survive. */
internal fun reassertLocalOperation(latest: JSONObject, original: JSONObject): JSONObject {
    val op = original.copyJson()
    fun slot(record: JSONObject, key: String): JSONObject = if (record.has(key)) JSONObject().put("exists", true).put("value", record.opt(key)) else JSONObject().put("exists", false)
    fun absent(): JSONObject = JSONObject().put("exists", false)
    fun present(value: JSONObject): JSONObject = JSONObject().put("exists", true).put("value", value.copyJson())
    fun review(message: String): Nothing = throw SyncConflict("review", message)
    fun task(date: String, id: String): JSONObject {
        val target = JSONObject().put("kind", "task").put("date", date).put("id", id)
        if (latest.obj("tombstones").optBoolean(SyncProtocol.tombstoneKey(target))) review("This task was deleted. Copy the proposed change into a new task instead.")
        val record = latest.obj("entries").optJSONArray(date)?.objects()?.find { it.optString("id") == id }
            ?: review("This task no longer exists. Copy the proposed change into a new task instead.")
        if (!record.isNull("rolledTo") && record.optString("rolledTo").isNotEmpty()) review("This task was carried to another day. Open that task and reapply the change there.")
        return record
    }
    fun guard(record: JSONObject) { op.put("guard", JSONObject().also { g -> listOf("done", "archived", "rolledTo").forEach { g.put(it, slot(record, it)) } }) }
    fun list(target: JSONObject): List<JSONObject> = when (val kind = target.getString("kind")) {
        "task", "tasks" -> latest.obj("entries").optJSONArray(target.getString("date"))?.objects() ?: emptyList()
        "subtask", "subtasks", "comment", "comments" -> {
            val parent = task(target.getString("date"), target.getString("taskId")); guard(parent)
            parent.optJSONArray(if (kind.startsWith("subtask")) "subtasks" else "comments")?.objects() ?: emptyList()
        }
        "quickNote", "quickNotes" -> latest.arr("quickNotes").objects()
        "customCat", "customCats" -> latest.arr("customCats").objects()
        "profile", "profiles" -> latest.arr("profiles").objects()
        else -> review("This change needs to be reapplied from its editor.")
    }
    when (op.optString("type")) {
        "patch" -> {
            val target = op.getJSONObject("target")
            val record = when (target.getString("kind")) {
                "settings" -> latest.obj("settings")
                "task" -> task(target.getString("date"), target.getString("id")).also(::guard)
                else -> review("This change needs to be reapplied from its editor.")
            }
            val changes = op.getJSONObject("changes")
            if (changes.has("rolledTo") || changes.has("rolledFrom") || changes.has("rolledFromTaskId")) review("Carry history needs a fresh review. Copy this change and reopen the task.")
            changes.keyList().forEach { field -> changes.getJSONObject(field).put("before", slot(record, field)) }
        }
        "record" -> {
            val target = op.getJSONObject("target"); val id = target.getString("id")
            val current = list(target).find { it.optString("id") == id }
            val after = op.getJSONObject("after")
            if (latest.obj("tombstones").optBoolean(SyncProtocol.tombstoneKey(target)) || (current == null && op.getJSONObject("before").optBoolean("exists"))) review("This item was deleted. Copy the proposed change into a new item instead.")
            if (target.getString("kind") == "task" && current != null) {
                task(target.getString("date"), id)
                if (after.optBoolean("exists")) review("A task already uses this identity. Copy the proposed change into a new task instead.")
            }
            val expected = current?.copyJson()?.also { if (target.getString("kind") == "task") { it.remove("pomodoros"); it.remove("focusSeconds") } }
            op.put("before", expected?.let(::present) ?: absent())
        }
        "order" -> {
            val current = list(op.getJSONObject("target")).map { it.getString("id") }
            val proposed = op.getJSONArray("after").strings().filter { it in current }.distinct()
            val known = proposed.toSet(); var index = 0
            op.put("before", JSONArray(current)).put("after", JSONArray(current.map { if (it in known) proposed[index++] else it }))
        }
        "noop", "unlock", "segment" -> Unit
        "carry" -> review("The carry source changed. Review the current task and carry it again; the proposed copy remains available here.")
        "import-metrics" -> review("Progress changed since import preview. Copy this proposal and preview the backup again to protect newer sessions.")
        else -> review("This change needs to be reapplied from its editor.")
    }
    SyncProtocol.apply(latest, op) // Validate before replacing the only durable copy of the user's proposal.
    return op
}

class AppRepository(private val context: Context) {
    private val database = LocalDatabase.open(context)
    private val dao = database.dao()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val diskMutex = Mutex()
    private val flushMutex = Mutex()
    private val preferences = context.getSharedPreferences("dailyflow_device", Context.MODE_PRIVATE)
    private val listeners = mutableListOf<ListenerRegistration>()
    private val snapshots = mutableMapOf<String, JSONObject>()
    private data class LocalBatch(val token: String, val owner: String, val profileId: String, val operations: List<JSONObject>, var saving: Boolean = false)
    private val localBatches = mutableListOf<LocalBatch>()
    private val blockedDocuments = mutableSetOf<String>()
    private var deviceId = ""
    private var networkError: String? = null
    var owner by mutableStateOf("guest"); private set
    var activeProfileId by mutableStateOf(""); private set
    var profile by mutableStateOf(blankProfile()); private set
    var meta by mutableStateOf(JSONObject().put("profiles", JSONArray())); private set
    var ready by mutableStateOf(false); private set
    var syncStatus by mutableStateOf("Loading your workspace…"); private set
    var pendingCount by mutableIntStateOf(0); private set
    var conflicts by mutableStateOf<List<PendingOperation>>(emptyList()); private set
    var error by mutableStateOf<String?>(null)
    val auth: FirebaseAuth? = if (FirebaseApp.getApps(context).isEmpty()) null else FirebaseAuth.getInstance()
    private val firestore: FirebaseFirestore? = auth?.let { FirebaseFirestore.getInstance() }
    val settings get() = profile.obj("settings")
    val profiles get() = meta.arr("profiles").objects()

    init {
        scope.launch {
            deviceId = diskMutex.withLock {
                dao.document("_device", "id")?.json ?: newId().also { dao.save(CachedDocument("_device", "id", it)) }
            }
            loadAccount(auth?.currentUser?.uid ?: "guest")
            auth?.addAuthStateListener { changed ->
                val uid = changed.currentUser?.uid ?: "guest"
                if (uid != owner) scope.launch { DeviceTimer.stop("account-switch"); loadAccount(uid) }
            }
        }
        scope.launch { while (isActive) { delay(15000); flush() } }
    }

    private suspend fun loadAccount(uid: String) {
        diskMutex.withLock {
            if (uid != (auth?.currentUser?.uid ?: "guest")) return
            ready = false
            if (DeviceTimer.state.value.owner != uid && DeviceTimer.state.value.sessionId.isNotBlank()) DeviceTimer.stop("account-switch")
            listeners.forEach { it.remove() }; listeners.clear(); listenedProfiles.clear()
            owner = uid; snapshots.clear(); networkError = null
            // Install this account's saved selection before publishing its metadata; never reconcile
            // against the prior account's selected id or overwrite the saved choice during startup.
            activeProfileId = preferences.getString("active:$uid", "") ?: ""
            meta = normalized("_meta", JSONObject().put("profiles", JSONArray()))
            val rows = dao.documents(uid).filterNot { it.profileId.startsWith("_base:") || it.profileId.startsWith("_segment:") }
            val loaded = mutableMapOf<String, JSONObject>()
            database.withTransaction {
                rows.forEach { row ->
                    try {
                        val baseline = dao.document(uid, "_base:${row.profileId}")?.let { JSONObject(it.json) }
                        val shadow = if (baseline == null) normalized(row.profileId, JSONObject(row.json)) else projectLocked(uid, row.profileId, baseline)
                        dao.save(CachedDocument(uid, row.profileId, shadow.toString()))
                        loaded[row.profileId] = shadow
                    } catch (e: Exception) { blockedDocuments += "$uid:${row.profileId}"; error = e.message }
                }
            }
            loaded.forEach { (pid, shadow) -> publish(uid, pid, shadow) }
            meta = snapshots["_meta"] ?: normalized("_meta", JSONObject().put("profiles", JSONArray()))
            if (uid == "guest" && profiles.isEmpty()) {
                val p = JSONObject().put("id", "local").put("name", "My workspace").put("emoji", "🌱").put("color", "#7C3AED").put("createdAt", System.currentTimeMillis())
                meta.put("profiles", JSONArray().put(p)); snapshots["_meta"] = meta.copyJson()
                dao.save(CachedDocument(uid, "_meta", meta.toString()))
            }
            selectAvailableProfile(); ready = true; refreshQueue()
        }
        applyAutomaticRollover()
        if (uid != "guest") { listenMeta(uid); scheduleBackgroundSync(uid) } else syncStatus = "Saved on this device"
    }
    private fun normalized(pid: String, data: JSONObject): JSONObject = if (pid == "_meta") SyncProtocol.normalizeMeta(data) else SyncProtocol.normalizeProfile(data)
    private fun emptyDocument(pid: String): JSONObject = if (pid == "_meta") normalized(pid, JSONObject().put("profiles", JSONArray())) else SyncProtocol.normalizeProfile(blankProfile())
    private suspend fun projectLocked(uid: String, pid: String, baseline: JSONObject): JSONObject {
        val result = projectPendingDocument(baseline, dao.pending(uid).filter { it.profileId == pid })
        result.conflicts.forEach { (id, message) -> dao.conflict(id, message) }
        return result.data
    }
    private fun publish(uid: String, pid: String, durable: JSONObject) {
        if (owner != uid) return
        var visible = durable.copyJson()
        localBatches.filter { it.owner == uid && it.profileId == pid }.forEach { batch ->
            batch.operations.forEach { op -> try { visible = SyncProtocol.apply(visible, op) } catch (_: Exception) { /* Durable enqueue records the conflict. */ } }
        }
        snapshots[pid] = visible
        if (pid == "_meta") { meta = visible.copyJson(); selectAvailableProfile() }
        if (pid == activeProfileId) profile = visible.copyJson()
    }
    private fun selectAvailableProfile() {
        // Timer.stop durably journals the old owner's segment before the selected workspace changes.
        activeProfileId = reconcileProfileSelection(activeProfileId, profiles.map { it.optString("id") }) { DeviceTimer.stop("profile-switch") }
        preferences.edit().putString("active:$owner", activeProfileId).apply()
        profile = snapshots[activeProfileId]?.copyJson() ?: blankProfile()
    }
    private fun document(uid: String, pid: String) = firestore!!.document(if (pid == "_meta") "users/$uid/meta/root" else "users/$uid/profiles/$pid")
    private fun listenMeta(uid: String) {
        listeners += document(uid, "_meta").addSnapshotListener { snap, failure ->
            if (owner != uid) return@addSnapshotListener
            if (failure != null) { networkError = "Sync unavailable — changes saved locally"; syncStatus = networkError!!; error = failure.localizedMessage; return@addSnapshotListener }
            if (snap != null) scope.launch {
                if (!receive(uid, "_meta", if (snap.exists()) JSONObject(snap.data!!) else JSONObject().put("profiles", JSONArray()))) return@launch
                val ids = profiles.map { it.optString("id") }.toSet()
                ids.forEach { pid ->
                    if (listenedProfiles.add("$uid:$pid")) listeners += document(uid, pid).addSnapshotListener { data, ex ->
                        if (owner == uid && data != null && ex == null) scope.launch { receive(uid, pid, if (data.exists()) JSONObject(data.data!!) else blankProfile()) }
                        else if (owner == uid && ex != null) { error = ex.localizedMessage; networkError = "Sync unavailable — changes saved locally"; syncStatus = networkError!! }
                    }
                }
                if (profiles.isEmpty() && !snap.metadata.isFromCache) addProfile("My workspace", "🌱")
                flush()
            }
        }
    }
    private val listenedProfiles = mutableSetOf<String>()
    private suspend fun receive(uid: String, pid: String, cloud: JSONObject): Boolean {
        diskMutex.withLock {
            if (owner != uid) return false
            val incoming = try { normalized(pid, cloud) }
                catch (e: Exception) {
                    blockedDocuments += "$uid:$pid"; error = e.message
                    networkError = if (e is SyncConflict && e.code == "schema") "This workspace needs a newer app version" else "Workspace data needs review before syncing"
                    syncStatus = networkError!!; return false
                }
            var local = incoming
            database.withTransaction {
                val previous = dao.document(uid, "_base:$pid")?.let { JSONObject(it.json) }
                val baseline = chooseServerBaseline(previous, incoming)
                dao.save(CachedDocument(uid, "_base:$pid", baseline.toString()))
                local = projectLocked(uid, pid, baseline)
                dao.save(CachedDocument(uid, pid, local.toString()))
            }
            blockedDocuments.remove("$uid:$pid")
            publish(uid, pid, local)
            refreshQueue()
        }
        if (pid == activeProfileId) applyAutomaticRollover()
        return true
    }
    fun selectProfile(id: String) {
        if (id == activeProfileId) return
        DeviceTimer.stop("profile-switch")
        activeProfileId = id; preferences.edit().putString("active:$owner", id).apply()
        profile = snapshots[id]?.copyJson() ?: blankProfile()
        applyAutomaticRollover()
    }
    fun addProfile(name: String, emoji: String = "👤") {
        if (name.isBlank()) return
        val id = newId()
        mutateMeta { it.arr("profiles").put(JSONObject().put("id", id).put("name", name.trim()).put("emoji", emoji).put("color", "#7C3AED").put("createdAt", System.currentTimeMillis())) }
        selectProfile(id)
    }
    fun mutateMeta(block: (JSONObject) -> Unit) {
        if (!ready || "$owner:_meta" in blockedDocuments) return
        runCatching { val before = meta.copyJson(); val after = before.copyJson(); block(after); commit("_meta", after, SyncProtocol.diffMeta(before, after)) }.onFailure { error = it.message }
    }
    fun mutateProfile(block: (JSONObject) -> Unit) {
        if (!ready || activeProfileId.isBlank() || "$owner:_meta" in blockedDocuments || "$owner:$activeProfileId" in blockedDocuments) return
        runCatching { val before = profile.copyJson(); val after = before.copyJson(); block(after); commit(activeProfileId, after, orderLegacyArchiveOperations(SyncProtocol.diffProfile(before, after))) }.onFailure { error = it.message }
    }
    private fun commit(pid: String, data: JSONObject, operations: List<JSONObject>) {
        if (operations.isEmpty()) return
        val uid = owner
        if ("$uid:$pid" in blockedDocuments || "$uid:_meta" in blockedDocuments) return
        // The semantic reducer supplies tombstones/canonical ids and excludes metric writes.
        val current = snapshots[pid]?.copyJson() ?: if (pid == "_meta") meta.copyJson() else if (pid == activeProfileId) profile.copyJson() else emptyDocument(pid)
        var projected = current
        operations.forEach { projected = SyncProtocol.apply(projected, it) }
        val ops = operations.toMutableList()
        if (pid != "_meta") {
            val unlocked = projected.obj("achievements").arr("unlocked").strings().toSet()
            val earned = achievementProgress(projected).filter { it.progress >= it.target && it.id !in unlocked }.map { it.id }
            if (earned.isNotEmpty()) {
                val unlock = JSONObject().put("type", "unlock").put("ids", JSONArray(earned)); ops += unlock
                projected = SyncProtocol.apply(projected, unlock)
            }
        }
        val batch = LocalBatch(newId(), uid, pid, ops.map { it.copyJson() })
        localBatches += batch
        snapshots[pid] = projected.copyJson()
        if (pid == "_meta") { meta = projected; selectAvailableProfile() } else if (pid == activeProfileId) profile = projected
        syncStatus = "Saving on this device…"
        persistBatch(batch)
    }
    private suspend fun ensureDeviceIdLocked() {
        if (deviceId.isBlank()) deviceId = dao.document("_device", "id")?.json ?: newId().also { dao.save(CachedDocument("_device", "id", it)) }
    }
    private suspend fun enqueueLocked(uid: String, pid: String, operations: List<JSONObject>): List<PendingOperation> {
        ensureDeviceIdLocked()
        var seq = dao.stream(uid, pid)?.seq ?: 0
        val rows = mutableListOf<PendingOperation>()
        if (uid != "guest") operations.forEach { operation ->
            seq++
            val id = "$uid:$deviceId:$pid:$seq"
            val op = operation.copyJson().put("deviceId", deviceId).put("seq", seq).put("id", "$deviceId:$seq")
            val row = PendingOperation(id, uid, pid, op.toString(), System.currentTimeMillis(), sequence = seq)
            dao.enqueue(row); rows += row
        }
        dao.saveStream(StreamSequence(uid, pid, seq))
        return rows
    }
    private suspend fun storeBatchLocked(uid: String, pid: String, operations: List<JSONObject>): JSONObject {
        val rows = enqueueLocked(uid, pid, operations)
        val baseline = dao.document(uid, "_base:$pid")?.let { normalized(pid, JSONObject(it.json)) }
        val projected = if (baseline != null && uid != "guest") projectLocked(uid, pid, baseline) else {
            // Legacy cache has no baseline. Its shadow already contains its old outbox.
            // Apply only this newly enqueued batch until a fresh server snapshot arrives.
            var shadow = dao.document(uid, pid)?.let { normalized(pid, JSONObject(it.json)) } ?: emptyDocument(pid)
            operations.forEachIndexed { index, operation ->
                try { shadow = SyncProtocol.apply(shadow, operation) }
                catch (e: Exception) { if (uid == "guest") throw e else dao.conflict(rows[index].id, e.message ?: "Change needs review") }
            }
            shadow
        }
        dao.save(CachedDocument(uid, pid, projected.toString()))
        return projected
    }
    private fun persistBatch(batch: LocalBatch) {
        if (batch.saving) return
        batch.saving = true
        scope.launch {
            try {
                diskMutex.withLock {
                    val projected = database.withTransaction { storeBatchLocked(batch.owner, batch.profileId, batch.operations) }
                    localBatches.removeAll { it.token == batch.token }
                    publish(batch.owner, batch.profileId, projected)
                    refreshQueue()
                }
                scheduleBackgroundSync(batch.owner)
                flush()
            } catch (e: Exception) {
                batch.saving = false
                if (owner == batch.owner) {
                    error = e.message
                    networkError = "Could not save on this device — keep the app open and retry"
                    syncStatus = networkError!!
                }
            }
        }
    }
    fun tasks(date: String): List<JSONObject> = profile.obj("entries").optJSONArray(date)?.objects() ?: emptyList()
    fun addTask(date: String, task: JSONObject) = mutateProfile { p ->
        val items = p.obj("entries").arr(date).objects().toMutableList(); items.add(0, task); p.obj("entries").put(date, JSONArray(items))
    }
    fun updateTask(date: String, id: String, block: (JSONObject) -> Unit) = mutateProfile { p -> p.obj("entries").arr(date).objects().find { it.optString("id") == id }?.let(block) }
    fun removeTask(date: String, id: String) = mutateProfile { p -> p.obj("entries").put(date, JSONArray(p.obj("entries").arr(date).objects().filterNot { it.optString("id") == id })) }
    fun carryTask(date: String, id: String, targetDate: String) {
        if (!ready || activeProfileId.isBlank()) return
        val source = tasks(date).find { it.optString("id") == id } ?: return
        if (!taskCanCarry(source, settings, date, targetDate)) { error = "Only an unfinished, unarchived task can be carried to a later valid date."; return }
        val before = source.copyJson().apply { remove("pomodoros"); remove("focusSeconds") }
        val after = before.copyJson().put("rolledTo", targetDate)
        val target = before.copyJson().put("id", SyncProtocol.carryId(date, id, targetDate)).put("rolledFrom", date).put("rolledTo", JSONObject.NULL)
            .put("lineageId", source.optString("lineageId", id)).put("time", nowTime()).put("ts", System.currentTimeMillis())
        val op = JSONObject().put("type", "carry").put("source", JSONObject().put("date", date).put("id", id)).put("targetDate", targetDate)
            .put("sourceBefore", before).put("sourceAfter", after).put("target", target)
        runCatching { commit(activeProfileId, SyncProtocol.apply(profile.copyJson(), op), listOf(op)) }.onFailure { error = it.message }
    }
    private fun applyAutomaticRollover() {
        if (!ready || activeProfileId.isBlank()) return
        val target = today()
        val eligible = profile.obj("entries").keyList().filter { it < target }.sorted().flatMap { date ->
            tasks(date).filter { taskCanCarry(it, settings, date, target, automatic = true) }.map { date to it.getString("id") }
        }
        eligible.forEach { (date, id) -> carryTask(date, id, target) }
    }
    fun recordSegment(segmentOwner: String, segment: JSONObject, acknowledgeJournal: () -> Unit) {
        val pid = segment.optString("profileId")
        if (pid.isBlank() || segmentOwner.isBlank() || segment.optString("id").isBlank()) return
        val uid = segmentOwner; val savedSegment = segment.copyJson()
        scope.launch {
            try {
                diskMutex.withLock {
                    val marker = "_segment:${savedSegment.getString("id")}"
                    val projected = database.withTransaction {
                        if (dao.document(uid, marker) != null) {
                            dao.document(uid, pid)?.let { normalized(pid, JSONObject(it.json)) } ?: emptyDocument(pid)
                        } else {
                            val op = JSONObject().put("type", "segment").put("segment", savedSegment)
                            var next = storeBatchLocked(uid, pid, listOf(op))
                            val unlocked = next.obj("achievements").arr("unlocked").strings().toSet()
                            val earned = achievementProgress(next).filter { it.progress >= it.target && it.id !in unlocked }.map { it.id }
                            if (earned.isNotEmpty()) next = storeBatchLocked(uid, pid, listOf(JSONObject().put("type", "unlock").put("ids", JSONArray(earned))))
                            dao.save(CachedDocument(uid, marker, JSONObject().put("id", savedSegment.getString("id")).put("profileId", pid).toString()))
                            next
                        }
                    }
                    publish(uid, pid, projected)
                    refreshQueue()
                }
                // A process death before this callback safely replays the durable local marker.
                acknowledgeJournal()
                scheduleBackgroundSync(uid)
                flush()
            } catch (e: Exception) {
                error = e.message
                if (owner == uid) { networkError = "Timer progress is awaiting local save — retry"; syncStatus = networkError!! }
            }
        }
    }
    fun importProfile(incoming: JSONObject) {
        val before = profile.copyJson()
        val after = Transfer.merge(before, incoming)
        val operations = SyncProtocol.diffProfile(before, after).toMutableList()
        var projected = before.copyJson()
        operations.forEach { projected = SyncProtocol.apply(projected, it) }
        val metrics = JSONArray()
        incoming.obj("entries").keyList().forEach { date -> incoming.obj("entries").arr(date).objects().forEach { task ->
            val id = task.getString("id")
            val existing = projected.obj("entries").arr(date).objects().find { it.optString("id") == id } ?: return@forEach
            fun slots(t: JSONObject) = JSONObject().also { slots -> listOf("pomodoros", "focusSeconds").forEach { key -> slots.put(key, if (t.has(key)) JSONObject().put("exists", true).put("value", t.opt(key)) else JSONObject().put("exists", false)) } }
            val desired = task.copyJson()
            listOf("pomodoros", "focusSeconds").forEach { if (!desired.has(it)) desired.put(it, existing.optLong(it)) }
            if (!SyncProtocol.equal(slots(existing), slots(desired))) metrics.put(JSONObject().put("date", date).put("id", id).put("before", slots(existing)).put("after", slots(desired)))
        } }
        if (metrics.length() > 0 || !SyncProtocol.equal(projected.obj("pomLog"), after.obj("pomLog")) || !SyncProtocol.equal(projected.obj("focusLog"), after.obj("focusLog"))) {
            val metricsOp = JSONObject().put("type", "import-metrics")
                .put("before", JSONObject().put("pomLog", projected.obj("pomLog")).put("focusLog", projected.obj("focusLog")))
                .put("after", JSONObject().put("pomLog", after.obj("pomLog")).put("focusLog", after.obj("focusLog"))).put("taskMetrics", metrics)
            operations += metricsOp
            projected = SyncProtocol.apply(projected, metricsOp)
        }
        commit(activeProfileId, projected, operations)
    }
    private suspend fun scheduleBackgroundSync(uid: String) {
        if (uid == "guest" || auth?.currentUser?.uid != uid || !hasRetryablePending(uid)) return
        runCatching { SyncWorker.schedule(context, uid) }.onFailure {
            if (owner == uid) { error = it.message; networkError = "Background retry unavailable — open the app to sync" }
        }
    }
    suspend fun hasRetryablePending(uid: String): Boolean = retryableStreams(dao.pending(uid), uid).any { "$uid:$it" !in blockedDocuments }
    suspend fun flushForWorker(uid: String) = flush(expectedOwner = uid, waitForExisting = true)
    suspend fun flush(expectedOwner: String? = null, waitForExisting: Boolean = false) {
        if (owner == "guest" || firestore == null || !ready || deviceId.isBlank() || (!waitForExisting && flushMutex.isLocked)) return
        if (auth?.currentUser?.uid != owner || (expectedOwner != null && owner != expectedOwner)) return
        flushMutex.withLock {
            val uid = owner
            if (!ready || uid == "guest" || auth?.currentUser?.uid != uid || (expectedOwner != null && uid != expectedOwner)) return
            val blocked = mutableSetOf<String>()
            for (pending in dao.pending(uid).sortedWith(compareBy<PendingOperation> { it.profileId }.thenBy { JSONObject(it.json).optLong("seq") })) {
                if (owner != uid || auth?.currentUser?.uid != uid) break
                if (pending.profileId in blocked || pending.error.isNotEmpty()) { blocked += pending.profileId; continue }
                val op = JSONObject(pending.json)
                syncStatus = "Syncing changes…"
                try {
                    val committed = firestore.runTransaction<JSONObject> { tx ->
                        val ref = document(uid, pending.profileId)
                        val operationDevice = op.getString("deviceId")
                        val receipt = ref.collection("receipts").document(operationDevice)
                        val snap = tx.get(ref); val checkpoint = tx.get(receipt)
                        val current = normalized(pending.profileId, if (snap.exists()) JSONObject(snap.data!!) else emptyDocument(pending.profileId))
                        val last = checkpoint.getLong("seq") ?: 0
                        val seq = op.getLong("seq")
                        if (seq <= last) {
                            // Receipt is authoritative; remember its frontier even if an older writer omitted the mirror.
                            current.obj("acks").put(operationDevice, maxOf(last, current.obj("acks").optLong(operationDevice)))
                            return@runTransaction current
                        }
                        check(seq == last + 1) { "Sync sequence has a missing operation." }
                        val segment = op.optJSONObject("segment")
                        require(segment == null || segment.optString("profileId") == pending.profileId) { "Session profile does not match its workspace." }
                        val sessionRef = segment?.let { ref.collection("sessions").document(it.getString("id")) }
                        val existingSession = sessionRef?.let { tx.get(it).exists() } ?: false
                        val next = if (existingSession) current else SyncProtocol.apply(current, op)
                        val now = System.currentTimeMillis()
                        next.put("schemaVersion", 3).put("revision", current.optLong("revision") + 1).put("updatedAt", now)
                            .put("lastMutation", JSONObject().put("deviceId", operationDevice).put("seq", seq).put("segmentId", segment?.getString("id") ?: JSONObject.NULL))
                        next.obj("acks").put(operationDevice, seq)
                        tx.set(ref, next.toMap())
                        tx.set(receipt, mapOf("seq" to seq, "updatedAt" to now))
                        if (sessionRef != null && !existingSession) tx.set(sessionRef, segment!!.toMap())
                        next
                    }.await()
                    diskMutex.withLock {
                        var shadow = committed
                        database.withTransaction {
                            val previous = dao.document(uid, "_base:${pending.profileId}")?.let { JSONObject(it.json) }
                            val baseline = chooseServerBaseline(previous, committed)
                            dao.save(CachedDocument(uid, "_base:${pending.profileId}", baseline.toString()))
                            dao.acknowledge(pending.id)
                            shadow = projectLocked(uid, pending.profileId, baseline)
                            dao.save(CachedDocument(uid, pending.profileId, shadow.toString()))
                        }
                        publish(uid, pending.profileId, shadow)
                        refreshQueue()
                    }
                    if (owner == uid) networkError = null
                } catch (e: Exception) {
                    if (e is CancellationException) throw e
                    val causes = generateSequence(e as Throwable?) { it.cause }.toList()
                    val cause = causes.firstOrNull { it is SyncConflict || it is IllegalArgumentException || it is JSONException }
                    if (cause != null || causes.any { it.message?.contains("missing operation") == true }) {
                        diskMutex.withLock { dao.conflict(pending.id, cause?.message ?: e.message ?: "Conflict") }
                        if (cause is SyncConflict && cause.code == "schema") blockedDocuments += "$uid:${pending.profileId}"
                        blocked += pending.profileId
                    }
                    else {
                        if (owner == uid) { networkError = if (e is FirebaseFirestoreException && e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) "Sync permission denied — changes retained" else "Offline — changes queued"; syncStatus = networkError!! }
                        break
                    }
                }
            }
            refreshQueue()
        }
    }
    private suspend fun refreshQueue() {
        val uid = owner
        val queue = dao.pending(uid)
        if (uid != owner) return
        pendingCount = queue.size; conflicts = queue.filter { it.error.isNotEmpty() }
        syncStatus = when { localBatches.any { it.owner == uid } -> "Saving on this device…"; owner == "guest" -> "Saved on this device"; conflicts.isNotEmpty() -> "${conflicts.size} change(s) need review"; networkError != null -> networkError!!; pendingCount > 0 -> "$pendingCount change(s) saved locally"; else -> "Up to date" }
    }
    fun discardConflict(pending: PendingOperation) {
        if (pending.owner != owner) return
        scope.launch {
            diskMutex.withLock {
                val original = JSONObject(pending.json)
                var shadow: JSONObject? = null
                database.withTransaction {
                    dao.replace(pending.id, JSONObject().put("type", "noop").put("deviceId", original.getString("deviceId")).put("seq", original.getLong("seq")).put("id", original.optString("id")).toString())
                    dao.document(pending.owner, "_base:${pending.profileId}")?.let { row ->
                        shadow = projectLocked(pending.owner, pending.profileId, JSONObject(row.json))
                        dao.save(CachedDocument(pending.owner, pending.profileId, shadow.toString()))
                    }
                }
                shadow?.let { publish(pending.owner, pending.profileId, it) }
                refreshQueue()
            }
            scheduleBackgroundSync(pending.owner)
            flush()
        }
    }
    fun keepLocalConflict(pending: PendingOperation) {
        if (pending.owner != owner || auth?.currentUser?.uid != owner) return
        scope.launch {
            try {
                diskMutex.withLock {
                    if (pending.owner != owner || auth?.currentUser?.uid != owner) return@withLock
                    var shadow: JSONObject? = null
                    database.withTransaction {
                        val queue = dao.pending(pending.owner).filter { it.profileId == pending.profileId }
                        val current = queue.find { it.id == pending.id } ?: return@withTransaction
                        require(current.json == pending.json && current.error.isNotEmpty()) { "This change was already updated. Reopen conflict review." }
                        val baseline = dao.document(pending.owner, "_base:${pending.profileId}")?.let { JSONObject(it.json) }
                            ?: throw SyncConflict("review", "Connect once to load the current cloud version before choosing Keep local.")
                        val seq = JSONObject(current.json).getLong("seq")
                        val preceding = queue.filter { JSONObject(it.json).getLong("seq") < seq }
                        require(preceding.none { it.error.isNotEmpty() }) { "Resolve the earlier change in this workspace first." }
                        val projection = projectPendingDocument(baseline, preceding)
                        require(projection.conflicts.isEmpty()) { "An earlier change needs review first." }
                        val replacement = reassertLocalOperation(projection.data, JSONObject(current.json))
                        dao.replace(current.id, replacement.toString())
                        shadow = projectLocked(pending.owner, pending.profileId, baseline)
                        dao.save(CachedDocument(pending.owner, pending.profileId, shadow.toString()))
                    }
                    shadow?.let { publish(pending.owner, pending.profileId, it) }
                    refreshQueue()
                }
                scheduleBackgroundSync(pending.owner)
                flush()
            } catch (e: Exception) { error = e.message }
        }
    }
    fun retrySync() { localBatches.filter { !it.saving }.toList().forEach(::persistBatch); DeviceTimer.replayJournal(); scope.launch { scheduleBackgroundSync(owner); flush() } }
    fun signOut() { DeviceTimer.stop("sign-out"); auth?.signOut() }
}

class DailyFlowApplication : Application() {
    lateinit var repository: AppRepository; private set
    override fun onCreate() {
        super.onCreate()
        FirebaseApp.initializeApp(this)
        DeviceTimer.initialize(this)
        repository = AppRepository(this)
        DeviceTimer.ownerProvider = { repository.owner }
        DeviceTimer.onSegment = repository::recordSegment
        DeviceTimer.replayJournal()
        installCompletionHandler(this)
    }
}
