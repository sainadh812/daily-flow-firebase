# DailyFlow for Android

DailyFlow is a native Kotlin / Jetpack Compose application. It does not embed the website or a WebView. The app supports Android 8.0 (API 26) and later.

## Build

Use JDK 17 or 21 and an Android SDK with platform 35 and build tools 35.0.0. Open this directory in Android Studio, or run:

```powershell
$env:JAVA_HOME = 'C:\Program Files\Android\Android Studio\jbr'
$env:ANDROID_HOME = 'C:\Users\91812\AppData\Local\Android\Sdk'
.\gradlew.bat :app:assembleDebug :app:testDebugUnitTest
```

The debug APK is `app/build/outputs/apk/debug/app-debug.apk`.

Place the existing project's Android `google-services.json` in `app/` to enable accounts and sync. It is intentionally ignored by Git. The Firebase Android application is `com.sainadh.dailyflow`; configure the signing certificate for the build being installed. Without the configuration file the app builds with a local guest workspace and no account connection. Google sign-in additionally needs the web OAuth client included in the downloaded Android configuration. Email and SMS availability follows the project's enabled authentication providers.

## Native features

- Email/password, account creation, password reset, Google Credential Manager and SMS phone sign-in.
- Separate workspaces, workspace naming and icons, date navigation, text/tag search, category/priority/completion/archive filters.
- Activity creation/editing, notes, hashtags, time-spent notes, subtasks, comments, completion, archive/restore, ordering and carrying activities forward. Automatic carry preserves completed subtasks and uses deterministic task IDs.
- All-date Unfinished views group earlier, today's and upcoming work by their original dates. The cross-date archive includes older dismissed activities and restores them without changing their identity or history.
- Quick notes with editing and conversion to activities.
- Pomodoro focus/short/long breaks and task stopwatches. Ongoing notifications provide pause/stop controls. Completion sounds and ambient rain, brown noise and waves are generated on-device.
- Focus totals, completion counts, logging streaks, date-range charts, category totals and 22 achievements.
- An optional next-day recap summarizes the previous visited day once per day, scoped to the device, account and workspace. It appears on app use and does not schedule a background notification.
- Duration/goal preferences, automatic starts, category management, dark mode, accent colors, text size, time display and calendar preferences.
- JSON, CSV, Markdown and XLSX exports and imports through the Android document picker. Imports show a preview, bind it to the account/workspace snapshot and merge records by ID. Android and the website share a structured backup format in all four containers; readers also accept earlier native exports. Nested task fields, settings, notes, categories and metrics survive a round trip.

## Storage and sync

`LocalDatabase.kt` holds account-separated Room snapshots, durable server baselines, per-document sequence counters and the pending operation queue. `SyncProtocol.kt` is the Kotlin implementation of the shared schema-3 reducer, verified against the same JSON fixtures used by the website. Record operations and guarded field patches avoid whole-profile overwrites. Conflicting changes stay in the local queue for review.

Firestore transactions read the latest document and a per-device receipt. They enforce sequential application, update revision/checkpoint data, and create immutable focus session records. Profile selection and running clock state are device-local. The server's `acks` map prevents a received snapshot from applying a pending operation twice before the local receipt is processed. These clients require the schema-3 Firestore rules and web adapter supplied in the repository; do not deploy a mixture of old whole-document clients and the new protocol.

`TimerService.kt` uses a monotonic clock and a foreground service. A preferences transaction records a paused/completed snapshot together with a pending segment journal before Room receives the event. Room acknowledges the journal only after the shadow and outbox are durable. Segments include their account/workspace identity, split at local midnight and use stable IDs. On reboot the timer pauses at its last saved checkpoint (at most 15 seconds of recent uncheckpointed time); on ordinary process restart it recovers elapsed time. AlarmManager supplies a wake-up fallback: exact when the user has granted precise-alarm access, inexact otherwise. Android's force-stop/battery restrictions can still delay a notification until the app runs again.

`SyncWorker.kt` schedules account-scoped WorkManager jobs with network constraints and exponential retry after durable local writes. A worker drains the same Room queue as the foreground app. Conflicted streams remain saved for review. WorkManager supplies background retries, not an exact timer or a bypass for Android force-stop restrictions. Ambient audio requests audio focus and stops on focus loss.

## Verification

```powershell
.\gradlew.bat :app:testDebugUnitTest
# Generate the website's cross-platform backup fixtures from the repository root first:
node ..\scripts\transfer-fixtures.cjs
.\gradlew.bat :app:assembleDebugAndroidTest
# With a running Android emulator or attached test device:
.\gradlew.bat :app:connectedDebugAndroidTest
```

JVM tests cover shared sync fixtures, lifecycle conflicts, imports, all-date task grouping, midnight/daylight-saving splitting and monotonic time accounting. Instrumentation tests verify the native guest task/subtask/stopwatch workflow, all-date editing/focus/archive restoration, durable timer-journal replay, and full-fidelity native and website backups through all four transfer formats. Instrumentation tests assert that the app is in the guest account before changing data.

Live Google/SMS sign-in and cross-device verification require a real user session. No test creates or modifies production user records. Release signing material belongs outside the repository; keep the keystore backed up to preserve the ability to install future updates.

## Deliberate differences and remaining checks

The guest workspace stays on the device when an account is connected; use export/import to explicitly move those activities to an account. Account caches never merge automatically. The native app preserves the website's remaining preferences, but does not duplicate its earlier-task banner/drawer or per-comment expansion preference: grouped Unfinished/Archived views provide the earlier-work and dismissal workflow, and the native detail sheet always exposes subtasks and comments. Real Google/email/SMS authentication, production Firestore synchronization and physical-device battery behavior remain integration checks; emulator and unit tests do not establish those results.
