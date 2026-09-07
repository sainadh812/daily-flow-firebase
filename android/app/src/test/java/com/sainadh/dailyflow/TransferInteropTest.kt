package com.sainadh.dailyflow

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class TransferInteropTest {
    private fun source(): JSONObject {
        val source = listOf(File("../../shared/backup-fixture.json"),File("../shared/backup-fixture.json")).first { it.exists() }
        return JSONObject(source.readText())
    }
    @Test fun allNativeFormatsPreserveFullProfileAndProduceWebFixtures() {
        val profile=source(); val output=File("build/cross-platform-backups").apply { mkdirs() }
        for ((format,ext) in listOf("json" to "json","csv" to "csv","markdown" to "md","xlsx" to "xlsx")) {
            val bytes=Transfer.export(profile,format);File(output,"native.$ext").writeBytes(bytes)
            val parsed=Transfer.parse(bytes,"native.$ext")
            profile.keyList().forEach { key -> assertTrue("$format lost $key",SyncProtocol.equal(profile.opt(key),parsed.opt(key))) }
        }
    }
    @Test fun rejectsFutureBackupAndIncompleteParts() {
        assertThrows(IllegalArgumentException::class.java) { Transfer.parse("{\"version\":4,\"entries\":{}}".toByteArray(),"new.json") }
        assertThrows(IllegalArgumentException::class.java) { Transfer.parse("Kind,Date,ID,Title,Details,Data\nbackup-json,,1,,,{}".toByteArray(),"partial.csv") }
        val hostile=source();hostile.obj("entries").arr("2026-09-07").getJSONObject(0).put("id","a');alert(1);//")
        assertThrows(IllegalArgumentException::class.java) { Transfer.parse(hostile.toString().toByteArray(),"unsafe.json") }
    }
    @Test fun formulaCharactersAndEmojiAtChunkBoundariesRoundTrip() {
        val profile=source();val task=profile.obj("entries").arr("2026-09-07").getJSONObject(0)
        task.put("notes",("=+-@🏍️\"'".repeat(12000)))
        val parsed=Transfer.parse(Transfer.export(profile,"csv"),"large.csv")
        assertEquals(task.getString("notes"),parsed.obj("entries").arr("2026-09-07").getJSONObject(0).getString("notes"))
    }
}
