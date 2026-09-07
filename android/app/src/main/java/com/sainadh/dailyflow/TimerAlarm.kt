package com.sainadh.dailyflow

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock

object TimerAlarm {
    private fun pending(context: Context) = PendingIntent.getBroadcast(context, 76, Intent(context, TimerAlarmReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun cancel(context: Context) { context.getSystemService(AlarmManager::class.java).cancel(pending(context)) }
    fun schedule(context: Context, state: TimerState) {
        cancel(context)
        if (!state.running || state.kind != "pomodoro") return
        val trigger = SystemClock.elapsedRealtime() + state.displaySeconds().coerceAtLeast(1) * 1000
        val alarms = context.getSystemService(AlarmManager::class.java)
        try {
            if (Build.VERSION.SDK_INT < 31 || alarms.canScheduleExactAlarms()) alarms.setExactAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pending(context))
            else alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pending(context))
        } catch (_: SecurityException) {
            // Access can be revoked between canScheduleExactAlarms and setExact.
            alarms.setAndAllowWhileIdle(AlarmManager.ELAPSED_REALTIME_WAKEUP, trigger, pending(context))
        }
    }
}

class TimerAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        // Application initializes the saved device timer before this receiver. The event is
        // journaled synchronously; Room can safely catch up even if Android stops this process.
        DeviceTimer.tick()
        if (DeviceTimer.state.value.running) TimerAlarm.schedule(context, DeviceTimer.state.value)
    }
}
