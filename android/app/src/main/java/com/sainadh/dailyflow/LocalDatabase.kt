package com.sainadh.dailyflow

import android.content.Context
import androidx.room.*

@Entity(tableName = "documents", primaryKeys = ["owner", "profileId"])
data class CachedDocument(val owner: String, val profileId: String, val json: String)

@Entity(tableName = "outbox")
data class PendingOperation(@PrimaryKey val id: String, val owner: String, val profileId: String, val json: String, val createdAt: Long, val error: String = "", val sequence: Long = 0)

@Entity(tableName = "streams", primaryKeys = ["owner", "profileId"])
data class StreamSequence(val owner: String, val profileId: String, val seq: Long)

@Dao
interface LocalDao {
    @Query("SELECT * FROM documents WHERE owner = :owner") suspend fun documents(owner: String): List<CachedDocument>
    @Query("SELECT * FROM documents WHERE owner = :owner AND profileId = :profileId LIMIT 1") suspend fun document(owner: String, profileId: String): CachedDocument?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun save(document: CachedDocument)
    @Insert(onConflict = OnConflictStrategy.IGNORE) suspend fun enqueue(operation: PendingOperation)
    @Query("SELECT * FROM outbox WHERE owner = :owner ORDER BY createdAt ASC, sequence ASC") suspend fun pending(owner: String): List<PendingOperation>
    @Query("DELETE FROM outbox WHERE id = :id") suspend fun acknowledge(id: String)
    @Query("UPDATE outbox SET error = :error WHERE id = :id") suspend fun conflict(id: String, error: String)
    @Query("UPDATE outbox SET json = :json, error = '' WHERE id = :id") suspend fun replace(id: String, json: String)
    @Query("SELECT * FROM streams WHERE owner = :owner AND profileId = :profileId") suspend fun stream(owner: String, profileId: String): StreamSequence?
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun saveStream(stream: StreamSequence)
    @Transaction suspend fun saveWithOperation(document: CachedDocument, operation: PendingOperation) { save(document); enqueue(operation) }
}

@Database(entities = [CachedDocument::class, PendingOperation::class, StreamSequence::class], version = 1, exportSchema = false)
abstract class LocalDatabase : RoomDatabase() {
    abstract fun dao(): LocalDao
    companion object { fun open(context: Context) = Room.databaseBuilder(context.applicationContext, LocalDatabase::class.java, "dailyflow-native.db").build() }
}
