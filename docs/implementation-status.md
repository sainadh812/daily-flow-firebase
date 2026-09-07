# Implementation and handoff

This is a local implementation of the web refresh, shared synchronization layer and native Android client. It is not a production deployment. The original live website and its Firestore rules have not been replaced, and verification has not changed production task records.

## Implemented

- Website task creation with an explicit date, optional details and subtasks; task-linked Pomodoro and stopwatch controls; all-date Unfinished and Archived views; reversible archive and selected-task automatic carry with preserved history.
- Native Kotlin/Compose app with daily and all-date task views, workspaces, task details, comments, subtasks, priorities, categories, tags/search, quick notes, carry/restore, focus timers, ambient audio, analytics, achievements and appearance/preferences. A next-day recap follows the website's previous-visit behavior; it is not a scheduled background alarm.
- Account-separated local persistence, semantic change queues, ordered server receipts, immutable focus segments, offline retries and explicit conflict review. Saved task data, settings and recorded focus progress are shared; running timer state intentionally remains device-local.
- Actual elapsed-time accounting, durable timer journals and recovery, including duplicate-replay protection. Unrecorded legacy focus durations are not invented from old Pomodoro counts.
- Full-profile JSON, CSV, Markdown and XLSX backups in both directions, including nested subtasks/comments, settings, notes and recorded totals. Imports require preview/confirmation and protect changed account/workspace snapshots.
- Local-only web preview, a versioned offline application shell, and a strict hosting allowlist. Application updates do not force-reload a running timer or unsaved editor.
- Prototype owner-isolated Firestore rules with receipt/session constraints, emulator attack tests, and documented limitations for nested legacy data.

## Scope of Android parity

The Android client is native, not a website wrapper. It provides the main task, focus, data and reporting capabilities using phone-oriented navigation. It does not reproduce the website's configurable sidebar/banner arrangement or its exact comment expansion presentation. Earlier work is available in the all-date Unfinished view, dismissal is a reversible archive, and comments/subtasks are exposed in task details. These website preference values are retained when synchronizing or transferring data.

## Safe preview and rollout

Use the website's localhost preview and the Android guest workspace for initial testing. **Do not connect the preview APK to your real account while the old website/rules are still active.** Mixing the old whole-profile writer with the new protocol is not a supported rollout.

The Android Firebase client and its debug signing certificate fingerprints have been registered in the existing project. This configuration does not mean real Google/SMS sign-in, production cross-device synchronization or a physical phone's background/battery behavior has been verified.

The delivered preview is debug-signed, not a permanently release-signed app. A stable private signing key and its backup need to be established before long-term distribution. Debug and release signatures cannot update one another in place; export local guest data before changing signatures or uninstalling.

Production activation requires approval, real-data backups, signing/provider review and a coordinated web/rules/client rollout. The local prototype rules are not a complete server-side validator of every nested legacy task field. See the [security review](security-review.md) and [release checklist](release-checklist.md).

## Verification record

Verified on 7 September 2026:

| Check | Result |
| --- | --- |
| Node unit and protocol tests | 74 passed |
| Browser regression tests | 26 passed |
| Firestore emulator rule/transaction tests | 7 passed |
| Android JVM tests | 37 passed |
| Installed Android emulator instrumentation | 6 passed |
| Android-to-web and web-to-Android backups | JSON, CSV, Markdown and XLSX passed |
| Hosting build boundary | Exactly 14 allowlisted static assets |
| APK signature | Verified APK Signature Scheme v2; Android Debug certificate |

Browser verification includes offline reload, timer recovery, draft preservation, account changes, conflict/retry handling, import safety and mobile layout. Android device tests include actual task/subtask/stopwatch interaction, all-date editing with duplicate IDs on different dates, legacy dismissal restoration, exactly-once timer journal recovery, cross-platform backups and next-day recap persistence across activity recreation. Test data is local or emulated.

The web screenshots were visually checked at desktop and phone widths; the installed native app's Log and Focus screens were also inspected. These results do not substitute for the real-account and physical-device checks listed above.

### Local Android preview

- File: [DailyFlow-Android-preview.apk](../artifacts/DailyFlow-Android-preview.apk)
- Application ID: `com.sainadh.dailyflow`; version `1.0.0` / code `1`; Android 8.0 and later.
- Size: 28,325,555 bytes.
- SHA-256: `CC67046A8CDB0EC93D665EB4BE33D8BB68310950C4EC0F42D710AFFB5AD558E5`.
- Debug-signed personal test build. Use the guest workspace until production rollout is approved and verified.

The APK, build output, emulator artifacts and Firebase client configuration are ignored by Git and excluded from Hosting. Publishing the source to Git is separate from production activation; no production Hosting deployment or live rule deployment has been performed.
