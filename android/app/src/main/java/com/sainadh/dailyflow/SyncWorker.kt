package com.sainadh.dailyflow

import android.content.Context
import androidx.work.*
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.TimeUnit

/** Work is only a wake-up hint. Room remains the durable, UID-partitioned source of pending work. */
class SyncWorker(context: Context, parameters: WorkerParameters) : CoroutineWorker(context, parameters) {
    override suspend fun doWork(): Result = withContext(Dispatchers.Main.immediate) {
        val uid = inputData.getString(OWNER) ?: return@withContext Result.failure()
        val repository = (applicationContext as DailyFlowApplication).repository
        // Never sign in, create a workspace, or transfer queued rows on behalf of this job.
        if (uid == "guest" || repository.auth?.currentUser?.uid != uid) return@withContext Result.success()
        val initialized = withTimeoutOrNull(30_000) {
            while (!repository.ready || repository.owner != uid) {
                if (repository.auth?.currentUser?.uid != uid) return@withTimeoutOrNull false
                delay(100)
            }
            true
        } ?: return@withContext Result.retry()
        if (!initialized || repository.auth?.currentUser?.uid != uid) return@withContext Result.success()
        // Await the real drain, including an already-running foreground drain, not a launched coroutine.
        repository.flushForWorker(uid)
        if (repository.owner != uid || repository.auth?.currentUser?.uid != uid) return@withContext Result.success()
        if (repository.hasRetryablePending(uid)) Result.retry() else Result.success()
    }

    companion object {
        private const val OWNER = "owner"
        fun schedule(context: Context, uid: String) {
            if (uid.isBlank() || uid == "guest") return
            val request = OneTimeWorkRequestBuilder<SyncWorker>()
                .setInputData(workDataOf(OWNER to uid))
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
                .build()
            // Appending closes KEEP's lost-wakeup window when an edit lands as a worker finishes.
            // Completed/conflicted drains succeed; a new mutation can replace a failed chain.
            WorkManager.getInstance(context).enqueueUniqueWork("dailyflow-sync:$uid", ExistingWorkPolicy.APPEND_OR_REPLACE, request)
        }
    }
}
