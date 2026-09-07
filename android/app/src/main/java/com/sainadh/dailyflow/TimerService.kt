package com.sainadh.dailyflow

import android.app.*
import android.content.*
import android.os.*
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import org.json.JSONObject
import java.util.UUID
import kotlin.math.max

/** Device-only clock state. elapsedRealtime keeps wall-clock changes from changing a running timer. */
data class TimerState(
    val sessionId: String = "", val profileId: String = "", val taskId: String = "", val taskDate: String = "",
    val kind: String = "pomodoro", val mode: String = "work", val running: Boolean = false,
    val durationSeconds: Long = 1500, val accruedSeconds: Long = 0, val startedElapsed: Long = 0,
    val startedWall: Long = 0, val segmentStart: Long = 0, val segmentAccrued: Long = 0,
    val cycle: Int = 0, val label: String = "Focus time", val owner: String = "guest"
) {
    fun elapsed(now: Long = SystemClock.elapsedRealtime()) = accruedSeconds + if (running) max(0, now - startedElapsed) / 1000 else 0
    fun displaySeconds() = if (kind == "stopwatch") elapsed() else max(0, durationSeconds - elapsed())
}

object DeviceTimer {
    private val mutable = MutableStateFlow(TimerState())
    val state = mutable.asStateFlow()
    private lateinit var context: Context
    var onSegment: ((String, JSONObject, () -> Unit) -> Unit)? = null
    var ownerProvider: () -> String = { "guest" }
    var onComplete: ((TimerState) -> Unit)? = null
    private var lastCheckpoint = 0L
    private val prefs get() = context.getSharedPreferences("dailyflow_device_timer", Context.MODE_PRIVATE)

    fun initialize(appContext: Context) {
        context = appContext.applicationContext
        runCatching {
            val j = JSONObject(prefs.getString("state", "{}")!!)
            val wasRunning = j.optBoolean("running")
            val elapsed = j.optLong("startedElapsed")
            // Across reboot, preserve already accrued time but pause instead of guessing.
            val sameBoot = SystemClock.elapsedRealtime() >= elapsed &&
                kotlin.math.abs((System.currentTimeMillis() - SystemClock.elapsedRealtime()) - j.optLong("bootEpoch")) < 120000
            mutable.value = TimerState(j.optString("sessionId"), j.optString("profileId"), j.optString("taskId"), j.optString("taskDate"),
                j.optString("kind", "pomodoro"), j.optString("mode", "work"), wasRunning && sameBoot,
                j.optLong("durationSeconds", 1500), j.optLong("accruedSeconds"), elapsed,
                j.optLong("startedWall"), j.optLong("segmentStart"), j.optLong("segmentAccrued"),
                j.optInt("cycle"), j.optString("label", "Focus time"), j.optString("owner", "guest"))
            if (wasRunning && !sameBoot) {
                val previous = mutable.value
                val knownSeconds = max(previous.accruedSeconds, j.optLong("checkpointSeconds"))
                mutable.value = previous.copy(running = false, accruedSeconds = knownSeconds)
                emitSegment(previous, knownSeconds, false, "device-restart")
            }
        }
    }
    @Synchronized private fun persist(journal: JSONObject? = null) {
        val s = mutable.value
        val j = JSONObject().put("sessionId", s.sessionId).put("profileId", s.profileId).put("taskId", s.taskId).put("taskDate", s.taskDate)
            .put("kind", s.kind).put("mode", s.mode).put("running", s.running).put("durationSeconds", s.durationSeconds)
            .put("accruedSeconds", s.accruedSeconds).put("startedElapsed", s.startedElapsed).put("startedWall", s.startedWall)
            .put("segmentStart", s.segmentStart).put("segmentAccrued", s.segmentAccrued).put("cycle", s.cycle).put("label", s.label)
            .put("bootEpoch", System.currentTimeMillis() - SystemClock.elapsedRealtime())
            .put("owner", s.owner).put("checkpointSeconds", s.elapsed())
        val edit = prefs.edit().putString("state", j.toString())
        if (journal != null) edit.putString("segments", journal.toString())
        check(edit.commit()) { "Could not save the timer state on this device." }
    }
    fun configure(profileId: String, taskId: String = "", taskDate: String = "", kind: String = "pomodoro", mode: String = "work", seconds: Long = 1500, label: String = "Focus time", owner: String = ownerProvider()) {
        stop("switch")
        mutable.value = TimerState(profileId = profileId, taskId = taskId, taskDate = taskDate, kind = kind, mode = mode, durationSeconds = seconds.coerceAtLeast(1), label = label, owner = owner)
        persist()
    }
    fun start() {
        val s = mutable.value
        if (s.running) return
        val wall = System.currentTimeMillis()
        mutable.value = s.copy(sessionId = s.sessionId.ifBlank { UUID.randomUUID().toString() }, running = true,
            startedElapsed = SystemClock.elapsedRealtime(), startedWall = s.startedWall.takeIf { it > 0 } ?: wall,
            segmentStart = wall, segmentAccrued = s.accruedSeconds)
        persist()
        try {
            ContextCompat.startForegroundService(context, Intent(context, TimerService::class.java).setAction("START"))
            TimerAlarm.schedule(context, mutable.value)
        } catch (e: Exception) {
            mutable.value = s.copy(running = false); persist(); TimerAlarm.cancel(context)
            throw e
        }
    }
    fun setCycle(cycle: Int) { mutable.value = mutable.value.copy(cycle = cycle); persist() }
    fun pause(reason: String = "pause") {
        val s = mutable.value
        if (!s.running) return
        val seconds = if (s.kind == "pomodoro") s.elapsed().coerceAtMost(s.durationSeconds) else s.elapsed()
        mutable.value = s.copy(running = false, accruedSeconds = seconds)
        emitSegment(s, seconds, false, reason)
        persist()
        TimerAlarm.cancel(context)
        context.stopService(Intent(context, TimerService::class.java))
    }
    fun stop(reason: String = "stop") {
        pause(reason)
        mutable.value = mutable.value.copy(sessionId = "", accruedSeconds = 0, startedWall = 0, segmentStart = 0, segmentAccrued = 0)
        persist()
    }
    fun tick() {
        val s = mutable.value
        if (!s.running) return
        if (s.kind == "pomodoro" && s.elapsed() >= s.durationSeconds) {
            mutable.value = s.copy(running = false, accruedSeconds = s.durationSeconds)
            emitSegment(s, s.durationSeconds, s.mode == "work", "complete")
            persist()
            TimerAlarm.cancel(context)
            onComplete?.invoke(s)
        } else {
            // New immutable value makes Compose re-read elapsed time each second.
            mutable.value = s.copy(label = s.label)
            if (SystemClock.elapsedRealtime() - lastCheckpoint > 15000) { persist(); lastCheckpoint = SystemClock.elapsedRealtime() }
        }
    }
    private fun emitSegment(s: TimerState, total: Long, completed: Boolean, reason: String) {
        if (s.mode != "work" && s.kind != "stopwatch") return
        val active = max(0, total - s.segmentAccrued)
        if (active == 0L && !completed) return
        val pieces = splitFocusSegments(s.sessionId, s.segmentStart, active, completed, java.time.ZoneId.systemDefault()).map { piece ->
            JSONObject().put("id", piece.id).put("sessionId", s.sessionId).put("profileId", s.profileId)
                .put("taskId", s.taskId.ifBlank { null } ?: JSONObject.NULL).put("taskDate", s.taskDate.ifBlank { null } ?: JSONObject.NULL)
                .put("date", piece.date).put("kind", s.kind).put("startedAt", piece.startedAt)
                .put("endedAt", piece.endedAt).put("activeSeconds", piece.activeSeconds).put("completedPomodoro", piece.completed).put("reason", reason)
        }
        synchronized(this) {
            val journal = JSONObject(prefs.getString("segments", "{}")!!)
            pieces.forEach { segment -> journal.put(segment.getString("id"), JSONObject().put("owner", s.owner).put("segment", segment)) }
            // Journal and paused/completed snapshot commit together before invoking the repository.
            persist(journal)
        }
        replayJournal()
    }
    fun replayJournal() {
        val journal = synchronized(this) { JSONObject(prefs.getString("segments", "{}")!!) }
        journal.keyList().forEach { id ->
            val item = journal.getJSONObject(id)
            onSegment?.invoke(item.getString("owner"), item.getJSONObject("segment")) {
                synchronized(this) { val current = JSONObject(prefs.getString("segments", "{}")!!); current.remove(id); prefs.edit().putString("segments", current.toString()).commit() }
            }
        }
    }
}

class TimerService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    override fun onBind(intent: Intent?) = null
    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("focus_running", "Active focus timer", NotificationManager.IMPORTANCE_LOW))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "PAUSE" -> { DeviceTimer.pause(); stopSelf(); return START_NOT_STICKY }
            "STOP" -> { DeviceTimer.stop(); stopSelf(); return START_NOT_STICKY }
        }
        startForeground(71, notification())
        scope.coroutineContext.cancelChildren()
        scope.launch {
            while (DeviceTimer.state.value.running) {
                DeviceTimer.tick()
                getSystemService(NotificationManager::class.java).notify(71, notification())
                delay(1000)
            }
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        }
        return START_STICKY
    }
    private fun notification(): Notification {
        val s = DeviceTimer.state.value
        fun action(action: String, request: Int) = PendingIntent.getService(this, request,
            Intent(this, TimerService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, "focus_running").setSmallIcon(R.drawable.ic_dailyflow)
            .setContentTitle(s.label).setContentText(formatDuration(s.displaySeconds())).setContentIntent(open)
            .setOnlyAlertOnce(true).setOngoing(true).setCategory(NotificationCompat.CATEGORY_STOPWATCH)
            .addAction(0, "Pause", action("PAUSE", 1)).addAction(0, "Stop", action("STOP", 2)).build()
    }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
}

fun formatDuration(seconds: Long): String = if (seconds >= 3600) "%d:%02d:%02d".format(seconds / 3600, seconds / 60 % 60, seconds % 60) else "%02d:%02d".format(seconds / 60, seconds % 60)
