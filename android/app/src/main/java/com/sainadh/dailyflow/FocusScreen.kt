package com.sainadh.dailyflow

import android.app.*
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.ToneGenerator
import android.media.AudioManager
import android.media.AudioFocusRequest
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.*
import kotlin.math.PI
import kotlin.math.sin
import kotlin.random.Random

@Composable
fun FocusScreen(repository: AppRepository, activity: MainActivity) {
    val timer by DeviceTimer.state.collectAsState()
    var seconds by remember { mutableLongStateOf(timer.displaySeconds()) }
    var ambient by remember { mutableStateOf("none") }
    var volume by remember { mutableFloatStateOf(0.35f) }
    val accent = MaterialTheme.colorScheme.primary
    val track = MaterialTheme.colorScheme.surfaceContainerHighest
    LaunchedEffect(timer) { while (true) { seconds = DeviceTimer.state.value.displaySeconds(); delay(200) } }
    DisposableEffect(Unit) { onDispose { AmbientAudio.stop() } }
    fun configure(kind: String = timer.kind, mode: String = timer.mode) {
        val minutes = when (mode) { "shortBreak" -> repository.settings.optLong("shortBreakDuration", 5); "longBreak" -> repository.settings.optLong("longBreakDuration", 15); else -> repository.settings.optLong("workDuration", 25) }
        DeviceTimer.configure(repository.activeProfileId, timer.taskId, timer.taskDate, kind, mode, minutes * 60,
            if (kind == "stopwatch") "Task stopwatch" else when (mode) { "shortBreak" -> "Short break"; "longBreak" -> "Long break"; else -> "Focus time" })
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
        if (repository.settings.optBoolean("focusMode")) TextButton(onClick = { repository.mutateProfile { it.obj("settings").put("focusMode", false) } }) { Text("Exit focus view") }
        Text("One thing at a time", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
        Text("Find your rhythm. Give yourself room to focus.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            FilterChip(timer.kind == "pomodoro", { configure("pomodoro", "work") }, label = { Text("Pomodoro") }, leadingIcon = { Icon(Icons.Default.Timer, null, Modifier.size(16.dp)) })
            FilterChip(timer.kind == "stopwatch", { configure("stopwatch", "work") }, label = { Text("Stopwatch") }, leadingIcon = { Icon(Icons.Default.AvTimer, null, Modifier.size(16.dp)) })
        }
        if (timer.kind == "pomodoro") Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("work" to "Focus", "shortBreak" to "Short", "longBreak" to "Long").forEach { (mode, label) -> FilterChip(timer.mode == mode, { configure(mode = mode) }, label = { Text(label) }) }
        }
        Box(Modifier.size(270.dp), contentAlignment = Alignment.Center) {
            Canvas(Modifier.fillMaxSize().padding(6.dp)) {
                val diameter = size.minDimension - 16.dp.toPx()
                val top = Offset((size.width - diameter) / 2, (size.height - diameter) / 2)
                drawArc(track, -90f, 360f, false, top, Size(diameter, diameter), style = Stroke(8.dp.toPx(), cap = StrokeCap.Round))
                val fraction = if (timer.kind == "stopwatch") (seconds % 3600).toFloat() / 3600 else seconds.toFloat() / timer.durationSeconds.coerceAtLeast(1)
                val pattern = when (repository.settings.optString("ringStyle", "solid")) { "dashed" -> androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(12.dp.toPx(), 9.dp.toPx())); "dots" -> androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(1.dp.toPx(), 13.dp.toPx())); else -> null }
                drawArc(accent, -90f, 360f * fraction, false, top, Size(diameter, diameter), style = Stroke(8.dp.toPx(), cap = StrokeCap.Round, pathEffect = pattern))
            }
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(formatDuration(seconds), fontSize = 54.sp, fontWeight = FontWeight.Light)
                Text(if (timer.running) "In your flow" else if (timer.accruedSeconds > 0) "Paused" else "Ready when you are", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (timer.taskId.isNotBlank()) {
            val task = repository.profile.obj("entries").optJSONArray(timer.taskDate)?.objects()?.find { it.optString("id") == timer.taskId }
            AssistChip(onClick = { }, label = { Text(task?.optString("content") ?: timer.label, maxLines = 2) }, leadingIcon = { Icon(Icons.Default.TaskAlt, null, Modifier.size(18.dp)) })
        }
        Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedIconButton(onClick = { DeviceTimer.stop() }, modifier = Modifier.size(50.dp)) { Icon(Icons.Default.RestartAlt, "Reset timer") }
            Button(onClick = {
                if (timer.running) DeviceTimer.pause() else {
                    activity.requestNotifications()
                    if (timer.profileId != repository.activeProfileId || (timer.kind == "pomodoro" && seconds == 0L)) configure()
                    runCatching { DeviceTimer.start() }.onFailure { repository.error = "Android could not start the focus service. Your timer is paused; try again with DailyFlow open." }
                }
            }, contentPadding = PaddingValues(horizontal = 42.dp, vertical = 18.dp)) { Icon(if (timer.running) Icons.Default.Pause else Icons.Default.PlayArrow, null); Spacer(Modifier.width(8.dp)); Text(if (timer.running) "Pause" else "Start") }
            OutlinedIconButton(onClick = { DeviceTimer.stop("finish"); configure() }, modifier = Modifier.size(50.dp)) { Icon(Icons.Default.Stop, "Finish session") }
        }
        Text("${repository.profile.obj("pomLog").optInt(today())} pomodoros today  ·  ${repository.profile.obj("focusLog").optLong(today()) / 60} minutes focused", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Text("Set the atmosphere", style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf("none" to "Quiet", "rain" to "Rain", "brown" to "Brown noise", "waves" to "Waves").forEach { (id, label) ->
                FilterChip(ambient == id, { ambient = id; if (id == "none") AmbientAudio.stop() else AmbientAudio.start(activity, id, volume) }, label = { Text(label, fontSize = 11.sp) })
            }
        }
        if (ambient != "none") Slider(volume, { volume = it; AmbientAudio.volume = it })
        Text("Timers run on this device. Finished focus time appears on all your signed-in devices after syncing.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

object AmbientAudio {
    @Volatile var volume = 0.35f
    private var job: Job? = null
    fun stop() { job?.cancel(); job = null }
    fun start(context: android.content.Context, kind: String, level: Float) {
        stop(); volume = level
        val manager = context.getSystemService(AudioManager::class.java)
        val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
        val focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener { change -> if (change == AudioManager.AUDIOFOCUS_LOSS || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) stop() }.build()
        if (manager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return
        job = CoroutineScope(Dispatchers.Default).launch {
            val sampleRate = 22050
            val min = AudioTrack.getMinBufferSize(sampleRate, AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_16BIT)
            val audio = AudioTrack.Builder().setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
                .setAudioFormat(AudioFormat.Builder().setSampleRate(sampleRate).setEncoding(AudioFormat.ENCODING_PCM_16BIT).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build()).setBufferSizeInBytes(min * 2).build()
            val samples = ShortArray(2048); var last = 0.0; var offset = 0L
            try {
                audio.play()
                while (isActive) {
                    for (i in samples.indices) {
                        val white = Random.nextDouble(-1.0, 1.0)
                        last = ((last + white * 0.03) / 1.02).coerceIn(-1.0, 1.0)
                        val sample = when(kind) { "rain" -> white * 0.22 + last; "waves" -> last * (0.35 + 0.3 * sin(2 * PI * offset++ / (sampleRate * 8))); else -> last }
                        samples[i] = (sample * volume * 22000).toInt().coerceIn(-32767, 32767).toShort()
                    }
                    audio.write(samples, 0, samples.size)
                }
            } finally { audio.stop(); audio.release(); manager.abandonAudioFocusRequest(focus) }
        }
    }
}

fun installCompletionHandler(application: DailyFlowApplication) {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    DeviceTimer.onComplete = { finished ->
        val repository = application.repository
        val settings = repository.settings
        val sound = settings.optString("timerSound", "beep")
        if (sound != "none" && sound != "silent") scope.launch {
            val tone = ToneGenerator(AudioManager.STREAM_NOTIFICATION, 65)
            val type = when(sound) { "bell" -> ToneGenerator.TONE_CDMA_ALERT_CALL_GUARD; "chime" -> ToneGenerator.TONE_PROP_ACK; "gentle" -> ToneGenerator.TONE_PROP_PROMPT; else -> ToneGenerator.TONE_PROP_BEEP2 }
            tone.startTone(type, 800); delay(1000); tone.release()
        }
        val manager = application.getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("focus_complete", "Focus session completed", NotificationManager.IMPORTANCE_DEFAULT))
        val open = PendingIntent.getActivity(application, 0, android.content.Intent(application, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        runCatching { manager.notify(72, NotificationCompat.Builder(application, "focus_complete").setSmallIcon(R.drawable.ic_dailyflow).setContentTitle(if (finished.mode == "work") "Focus session complete" else "Break complete").setContentText("Take a breath. Your next step is ready.").setContentIntent(open).setAutoCancel(true).build()) }
        val cycle = if (finished.mode == "work") finished.cycle + 1 else finished.cycle
        val nextMode = if (finished.mode == "work") if (cycle % settings.optInt("longBreakInterval", 4).coerceAtLeast(1) == 0) "longBreak" else "shortBreak" else "work"
        val nextMinutes = when(nextMode) { "shortBreak" -> settings.optLong("shortBreakDuration", 5); "longBreak" -> settings.optLong("longBreakDuration", 15); else -> settings.optLong("workDuration", 25) }
        val auto = if (nextMode == "work") settings.optBoolean("autoStartWork") else settings.optBoolean("autoStartBreaks")
        DeviceTimer.configure(finished.profileId, finished.taskId, finished.taskDate, "pomodoro", nextMode, nextMinutes * 60, if (nextMode == "work") "Focus time" else "Take a break", finished.owner)
        DeviceTimer.setCycle(cycle)
        if (auto) runCatching { DeviceTimer.start() }.onFailure { repository.error = "Android paused the automatic next session. Open Focus and tap Start to continue." }
    }
}
