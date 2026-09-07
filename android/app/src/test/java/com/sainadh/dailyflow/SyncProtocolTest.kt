package com.sainadh.dailyflow

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class SyncProtocolTest {
    private val date = "2026-09-07"
    private fun task(id: String = "a") = JSONObject("""{"id":"$id","content":"Original","done":false,"rolledTo":null,"subtasks":[],"comments":[]}""")
    private fun profile(vararg tasks: JSONObject) = SyncProtocol.normalizeProfile(JSONObject().put("entries", JSONObject().put(date, JSONArray(tasks.toList()))))
    private fun first(d: JSONObject) = d.getJSONObject("entries").getJSONArray(date).getJSONObject(0)
    private fun applyAll(base: JSONObject, operations: List<JSONObject>) = operations.fold(base) { data, op -> SyncProtocol.apply(data, op) }
    private fun conflict(code: String, block: () -> Unit) {
        try { block(); fail("Expected $code conflict") } catch (error: SyncConflict) { assertEquals(code, error.code) }
    }
    @Test fun sharedFixturesHaveIdenticalResultsAndConflicts() {
        val candidates = listOf(File("../../shared/fixtures.json"), File("../shared/fixtures.json"), File("shared/fixtures.json"))
        val fixtureFile = candidates.firstOrNull { it.isFile } ?: error("Cannot locate shared/fixtures.json from ${File(".").absolutePath}")
        val fixtures = JSONObject(fixtureFile.readText()).getJSONArray("cases")
        fixtures.objects().forEach { fixture ->
            val meta = fixture.optBoolean("meta")
            var data = if (meta) SyncProtocol.normalizeMeta(fixture.getJSONObject("base")) else SyncProtocol.normalizeProfile(fixture.getJSONObject("base"))
            val conflicts = mutableListOf<String>()
            fixture.getJSONArray("ops").objects().forEach { op -> try { data = SyncProtocol.apply(data, op) } catch (error: SyncConflict) { conflicts += error.code } }
            val expected = if (meta) SyncProtocol.normalizeMeta(fixture.getJSONObject("expected")) else SyncProtocol.normalizeProfile(fixture.getJSONObject("expected"))
            assertTrue("${fixture.getString("name")}: expected $expected, actual $data", SyncProtocol.equal(expected, data))
            assertEquals(fixture.getString("name"), fixture.getJSONArray("conflictCodes").strings(), conflicts)
        }
    }
    @Test fun differentFieldsMergeAndSameFieldConflicts() {
        val base = profile(task()); val local = base.copyJson(); val remote = base.copyJson()
        first(local).put("content", "Local"); first(remote).put("notes", "Remote notes")
        val operations = SyncProtocol.diffProfile(base, local)
        val result = applyAll(remote, operations)
        assertEquals("Local", first(result).getString("content")); assertEquals("Remote notes", first(result).getString("notes"))
        first(remote).put("content", "Remote title")
        conflict("field") { applyAll(remote, operations) }
    }
    @Test fun missingAndNullAreDistinct() {
        val base = profile(task()); val local = base.copyJson(); val remote = base.copyJson()
        first(local).put("notes", "Local"); first(remote).put("notes", JSONObject.NULL)
        val operations = SyncProtocol.diffProfile(base, local)
        assertFalse(operations[0].getJSONObject("changes").getJSONObject("notes").getJSONObject("before").getBoolean("exists"))
        conflict("field") { applyAll(remote, operations) }
    }
    @Test fun childRecordsMergeByIdBeforeParentLifecycleChanges() {
        val t = task().put("subtasks", JSONArray("""[{"id":"s1","done":false},{"id":"s2","done":false}]"""))
        val base = profile(t); val local = base.copyJson(); val remote = base.copyJson()
        first(local).getJSONArray("subtasks").getJSONObject(0).put("done", true); first(local).put("done", true)
        first(remote).getJSONArray("subtasks").getJSONObject(1).put("text", "Remote")
        val result = applyAll(remote, SyncProtocol.diffProfile(base, local))
        assertTrue(first(result).getBoolean("done")); assertTrue(first(result).getJSONArray("subtasks").getJSONObject(0).getBoolean("done")); assertEquals("Remote", first(result).getJSONArray("subtasks").getJSONObject(1).getString("text"))
    }
    @Test fun deletionTombstonesBlockStaleResurrection() {
        val base = profile(task()); val empty = profile(); val removed = applyAll(base, SyncProtocol.diffProfile(base, empty))
        val key = SyncProtocol.tombstoneKey(JSONObject().put("kind", "task").put("date", date).put("id", "a"))
        assertEquals("[\"task\",\"2026-09-07\",\"\",\"a\"]", key); assertTrue(removed.getJSONObject("tombstones").getBoolean(key))
        conflict("deleted") { applyAll(removed, SyncProtocol.diffProfile(empty, base)) }
    }
    @Test fun insertionOrderAndConcurrentAdditionsArePreserved() {
        val base = profile(task("a"), task("b")); val local = profile(task("new"), task("b"), task("a")); val remote = profile(task("a"), task("remote"), task("b"))
        val operations = SyncProtocol.diffProfile(base, local)
        assertEquals(listOf("record", "order"), operations.map { it.getString("type") })
        val result = applyAll(remote, operations)
        assertEquals(listOf("new", "remote", "b", "a"), result.getJSONObject("entries").getJSONArray(date).objects().map { it.getString("id") })
    }
    @Test fun metricsCannotBeOverwrittenByOrdinaryDiff() {
        val base = profile(task()); val local = base.copyJson()
        first(local).put("pomodoros", 42).put("focusSeconds", 999); local.getJSONObject("pomLog").put(date, 42); local.getJSONObject("focusLog").put(date, 999)
        assertTrue(SyncProtocol.diffProfile(base, local).isEmpty())
    }
    @Test fun carryCanonicalizesDestinationAndKeepsCompletedSubtasks() {
        val source = task().put("subtasks", JSONArray("""[{"id":"s","done":true}]""")).put("pomodoros", 2)
        val base = profile(source); val after = base.copyJson(); first(after).put("rolledTo", "2026-09-08")
        after.getJSONObject("entries").put("2026-09-08", JSONArray().put(task("temporary").put("rolledFrom", date).put("subtasks", JSONArray("""[{"id":"s","done":false}]"""))))
        val operations = SyncProtocol.diffProfile(base, after)
        assertEquals(1, operations.count { it.getString("type") == "carry" })
        val carried = applyAll(base, operations); val next = carried.getJSONObject("entries").getJSONArray("2026-09-08").getJSONObject(0)
        assertEquals("carry:2026-09-07:a:2026-09-08", next.getString("id")); assertTrue(next.getJSONArray("subtasks").getJSONObject(0).getBoolean("done")); assertEquals(0, next.getInt("pomodoros"))
        assertTrue(SyncProtocol.equal(carried, applyAll(carried, operations)))
        val completed = base.copyJson(); first(completed).put("done", true)
        conflict("lifecycle") { applyAll(completed, operations) }
    }
    @Test fun metadataUsesRecordOperationsAndLocalSelectionDoesNotSync() {
        val before = JSONObject("""{"profiles":[{"id":"p","name":"Old"}],"activeProfileId":"p"}"""); val after = before.copyJson()
        after.getJSONArray("profiles").getJSONObject(0).put("name", "New")
        val result = applyAll(before, SyncProtocol.diffMeta(before, after))
        assertEquals("New", result.getJSONArray("profiles").getJSONObject(0).getString("name")); assertFalse(result.has("activeProfileId"))
    }
    @Test fun futureSchemasCannotBeDowngraded() {
        conflict("schema") { SyncProtocol.normalizeProfile(JSONObject().put("schemaVersion", 4)) }
        conflict("schema") { SyncProtocol.normalizeMeta(JSONObject().put("schemaVersion", 4).put("profiles", JSONArray())) }
    }
    @Test fun tombstoneEscapingMatchesJavascriptEvenForHtmlAndControlCharacters() {
        val target = JSONObject().put("kind", "comment").put("date", date).put("taskId", "</a>").put("id", "q\n\"\\")
        assertEquals("[\"comment\",\"2026-09-07\",\"</a>\",\"q\\n\\\"\\\\\"]", SyncProtocol.tombstoneKey(target))
    }
    private fun pending(op: JSONObject, seq: Long, owner: String = "user-a", createdAt: Long = seq): PendingOperation {
        val wrapped = op.copyJson().put("deviceId", "device").put("seq", seq)
        return PendingOperation("$owner:device:p:$seq", owner, "p", wrapped.toString(), createdAt, sequence = seq)
    }
    private fun segmentOp(id: String) = JSONObject().put("type", "segment").put("segment", JSONObject()
        .put("id", id).put("sessionId", "session").put("profileId", "p").put("taskId", "a").put("taskDate", date).put("date", date)
        .put("kind", "stopwatch").put("startedAt", 1000).put("endedAt", 61000).put("activeSeconds", 60).put("completedPomodoro", false).put("reason", "pause"))
    @Test fun durableBaselineReplayDoesNotCountAnAcknowledgedSegmentTwice() {
        val baseline = profile(task()); val first = pending(segmentOp("s1"), 1)
        val shadow = projectPendingDocument(baseline, listOf(first)).data
        assertEquals(60, shadow.getJSONObject("focusLog").getInt(date))
        // Restart restores the baseline and replays its queue, not the already-projected shadow.
        assertTrue(SyncProtocol.equal(shadow, projectPendingDocument(baseline.copyJson(), listOf(first)).data))
        val acknowledged = shadow.copyJson().put("revision", 1).put("acks", JSONObject().put("device", 1))
        assertEquals(60, projectPendingDocument(acknowledged, listOf(first)).data.getJSONObject("focusLog").getInt(date))
        val second = pending(segmentOp("s2"), 2)
        assertEquals(120, projectPendingDocument(acknowledged, listOf(first, second)).data.getJSONObject("focusLog").getInt(date))
    }
    @Test fun delayedServerSnapshotCannotRegressCommittedBaselineOrReceiptFrontier() {
        val old = profile(task()).put("revision", 0)
        val current = SyncProtocol.apply(old, segmentOp("s1")).put("revision", 1).put("acks", JSONObject().put("device", 1))
        assertTrue(SyncProtocol.equal(current, chooseServerBaseline(current, old)))
        val staleMirror = current.copyJson().put("acks", JSONObject())
        assertTrue(SyncProtocol.equal(current, chooseServerBaseline(current, staleMirror)))
        val next = SyncProtocol.apply(current, segmentOp("remote")).put("revision", 2)
        assertTrue(SyncProtocol.equal(next, chooseServerBaseline(current, next)))
    }
    @Test fun pendingProjectionUsesSequenceDespiteClockChangesAndPreservesConflicts() {
        val base = profile(task()); val one = base.copyJson(); first(one).put("content", "One")
        val two = one.copyJson(); first(two).put("content", "Two")
        val op1 = pending(SyncProtocol.diffProfile(base, one).single(), 1, createdAt = 200)
        val op2 = pending(SyncProtocol.diffProfile(one, two).single(), 2, createdAt = 100)
        assertEquals("Two", first(projectPendingDocument(base, listOf(op2, op1)).data).getString("content"))
        val remote = base.copyJson(); first(remote).put("content", "Remote")
        val result = projectPendingDocument(remote, listOf(op1, op2))
        assertEquals(2, result.conflicts.size); assertEquals("Remote", first(result.data).getString("content"))
        assertEquals("Original", first(base).getString("content"))
    }
    @Test fun receiptSequenceIsPerDeviceAndOutboxRowsIncludeAccountIdentity() {
        val a = pending(segmentOp("s"), 1, owner = "user-a"); val b = pending(segmentOp("s"), 1, owner = "user-b")
        assertNotEquals(a.id, b.id)
        val base = profile(task()).put("acks", JSONObject().put("another-device", 50))
        assertEquals(60, projectPendingDocument(base, listOf(a)).data.getJSONObject("focusLog").getInt(date))
    }
    @Test fun compactCarryUsesExactSha256AndStaysBoundedOverRepeatedMoves() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", SyncProtocol.sha256("abc"))
        val hash = "c2a908d98f5df987ade41b5fce213067efbcc21ef2240212a41e54b5e7c28ae5"
        assertEquals(hash, SyncProtocol.sha256("a".repeat(200)))
        assertEquals("carry-h:2026-09-07:$hash:2026-09-08", SyncProtocol.carryId(date, "a".repeat(200), "2026-09-08"))
        var id = "initial"; val seen = mutableSetOf(id)
        repeat(1000) { offset ->
            val from = java.time.LocalDate.parse(date).plusDays(offset.toLong()).toString(); val to = java.time.LocalDate.parse(from).plusDays(1).toString()
            val next = SyncProtocol.carryId(from, id, to)
            assertTrue(next.length <= 180); assertTrue(seen.add(next)); assertEquals(next, SyncProtocol.carryId(from, id, to)); id = next
        }
    }
    @Test fun backgroundRetriesPartitionAccountsAndStopAtTheFirstConflict() {
        val one = pending(segmentOp("s1"), 1).copy(error = "Needs review")
        val later = pending(segmentOp("s2"), 2)
        val otherProfile = pending(segmentOp("s3"), 1).copy(profileId = "other")
        val otherOwner = pending(segmentOp("s4"), 1, owner = "user-b")
        assertEquals(listOf("other"), retryableStreams(listOf(later, one, otherOwner, otherProfile), "user-a"))
        assertEquals(listOf("p"), retryableStreams(listOf(later, one, otherOwner), "user-b"))
    }
    @Test fun keepLocalRechecksCurrentFieldsWithoutDroppingOtherEditsOrEnvelope() {
        val base = profile(task()); val desired = base.copyJson(); first(desired).put("content", "My title")
        val wrapped = JSONObject(pending(SyncProtocol.diffProfile(base, desired).single(), 7).json).put("id", "device:7")
        val remote = base.copyJson(); first(remote).put("content", "Cloud title").put("notes", "Cloud notes")
        val replacement = reassertLocalOperation(remote, wrapped)
        assertEquals(7, replacement.getInt("seq")); assertEquals("device:7", replacement.getString("id"))
        val result = SyncProtocol.apply(remote, replacement)
        assertEquals("My title", first(result).getString("content")); assertEquals("Cloud notes", first(result).getString("notes"))
        first(remote).put("content", "A newer edit")
        conflict("field") { SyncProtocol.apply(remote, replacement) }
    }
    @Test fun keepLocalDoesNotResurrectDeletedTasksOrUndoCarryHistory() {
        val base = profile(task()); val desired = base.copyJson(); first(desired).put("content", "My title")
        val operation = SyncProtocol.diffProfile(base, desired).single()
        val deleted = applyAll(base, SyncProtocol.diffProfile(base, profile()))
        conflict("review") { reassertLocalOperation(deleted, operation) }
        val carried = base.copyJson(); first(carried).put("rolledTo", "2026-09-08")
        conflict("review") { reassertLocalOperation(carried, operation) }
    }
    @Test fun keepLocalOrderPreservesConcurrentAdditionsAndIgnoresDeletedIds() {
        val base = profile(task("a"), task("b"), task("c")); val desired = profile(task("c"), task("a"), task("b"))
        val operation = SyncProtocol.diffProfile(base, desired).single()
        val remote = profile(task("b"), task("new"), task("a"))
        val result = SyncProtocol.apply(remote, reassertLocalOperation(remote, operation))
        assertEquals(listOf("a", "new", "b"), result.obj("entries").arr(date).objects().map { it.getString("id") })
    }
    @Test fun metadataSelectionStopsOnlyAnActuallyChangedExistingProfile() {
        var stops = 0
        assertEquals("saved", reconcileProfileSelection("saved", listOf("other", "saved")) { stops++ })
        assertEquals(0, stops) // A restored timer remains linked to the saved profile.
        assertEquals("first", reconcileProfileSelection("", listOf("first")) { stops++ })
        assertEquals(0, stops)
        assertEquals("other", reconcileProfileSelection("deleted", listOf("other")) { stops++ })
        assertEquals(1, stops)
        assertEquals("", reconcileProfileSelection("deleted", emptyList()) { stops++ })
        assertEquals(2, stops)
    }
    @Test fun automaticAndManualCarryRespectLegacyDismissedIdsAndValidDates() {
        val source = task().put("autoRollover", true)
        val settings = JSONObject().put("autoRollover", true).put("ghostDismissed", JSONArray().put("a"))
        assertFalse(taskCanCarry(source, settings, date, "2026-09-08"))
        assertFalse(taskCanCarry(source, settings, date, "2026-09-08", automatic = true))
        settings.put("ghostDismissed", JSONArray().put("other"))
        assertTrue(taskCanCarry(source, settings, date, "2026-09-08", automatic = true))
        assertFalse(taskCanCarry(source, settings, date, date))
        assertFalse(taskCanCarry(source, settings, date, "2026-99-99"))
        source.put("ghostDismissed", true)
        assertFalse(taskCanCarry(source, settings, date, "2026-09-08"))
    }
    @Test fun legacyRestoreAppliesPerDateArchivesBeforeRemovingGlobalDismissal() {
        val before = profile(task().put("focusSeconds", 42).put("subtasks", JSONArray().put(JSONObject().put("id", "s").put("done", true))))
        before.obj("entries").put("2026-09-06", JSONArray().put(task()))
        before.obj("settings").put("ghostDismissed", JSONArray().put("a").put("unrelated"))
        val desired = before.copyJson(); setTaskArchived(desired, date, "a", false)
        val operations = orderLegacyArchiveOperations(SyncProtocol.diffProfile(before, desired))
        assertEquals("settings", operations.last().getJSONObject("target").getString("kind"))
        val intermediate = applyAll(before, operations.dropLast(1))
        assertTrue(taskIsArchived(first(intermediate), intermediate.obj("settings")))
        val restored = applyAll(before, operations)
        assertFalse(taskIsArchived(first(restored), restored.obj("settings")))
        assertTrue(restored.obj("entries").arr("2026-09-06").getJSONObject(0).getBoolean("archived"))
        assertEquals(listOf("unrelated"), restored.obj("settings").arr("ghostDismissed").strings())
        assertEquals(42, first(restored).getInt("focusSeconds")); assertTrue(first(restored).arr("subtasks").getJSONObject(0).getBoolean("done"))
    }
}
