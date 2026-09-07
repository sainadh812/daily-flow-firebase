# DailyFlow

A private daily planner with a browser interface and a native Kotlin/Jetpack Compose Android client. Both use the existing Firebase project. Android is not a WebView wrapper.

## Safe local preview

Use Node.js 22 or newer:

```powershell
npm ci
npm run build
npm run dev
```

Open http://127.0.0.1:4173/app.html. Localhost defaults to **local-only**, with an isolated local workspace and no production Firebase calls. Sign-in is intentionally hidden in that preview. `?firebase=emulator` uses only the demo Firebase project with local Auth and Firestore emulators. Public hosted URLs use the existing production project. Do not use `?firebase=production` for automated tests.

## Verification

```powershell
npm test
npm run test:browser
npx -y firebase-tools@latest emulators:exec --only firestore --project demo-dailyflow "node --test tests/rules.test.mjs"
```

Browser tests use installed Microsoft Edge on Windows, or `PLAYWRIGHT_CHANNEL`. Ordinary browser suites block external requests. `npm test` runs the Node unit suites; the dedicated emulator command executes rule tests. Java 21 must be on PATH for Firebase emulators. `node scripts/verify-build.cjs` checks the final hosting allowlist. `node scripts/transfer-fixtures.cjs` generates web backups for native tests and verifies native-generated backups in the browser reader.

## Android

Open `android/` in Android Studio. The app ID is `com.sainadh.dailyflow`, minimum Android 8.0 (API 26). Java 21 and an Android SDK are needed for the build. The repository uses Firebase main modules, not the discontinued separate KTX modules.

Place the Android Firebase client configuration at `android/app/google-services.json`. It is intentionally gitignored. Android and web must use the **same** Firebase project for account and profile synchronization. Google sign-in additionally needs the certificate fingerprint of the installed APK registered with Firebase and a refreshed client configuration. Never commit keystores or signing passwords.

The debug APK is generated at `android/app/build/outputs/apk/debug/app-debug.apk`. A debug-signed build is installable for personal testing; it is not a production release. Review the release checklist before enabling real-data use.

## Data and offline behavior

- Account-scoped local caches and durable semantic-operation queues; never a stale whole-profile cloud overwrite.
- Shared schema-3 protocol and cross-platform fixtures under `shared/`.
- Tasks, settings and saved focus progress synchronize. A currently running timer stays on its device; there is no live timer handoff.
- Pauses save actual elapsed segments. Immutable segment IDs and ordered receipts prevent reconnect retries from counting twice.
- Legacy Pomodoro counts are retained. Exact historical durations that were never recorded cannot be reconstructed; the new focus-time totals use recorded segments rather than multiplying old counts by today's duration setting.
- Conflict review retains pending local changes. Deliberate metric imports use expected-value checks, not a silent counter overwrite.
- JSON, CSV, Markdown and XLSX backups include an embedded full-profile payload in exports made by this version. Import previews merge records, with explicit choices for existing values and totals.
- Legacy unscoped browser storage is retained and only recovered into the isolated local preview. It is never silently attached to a signed-in account.

See [implementation status](docs/implementation-status.md), [sync contract](shared/contract.md), [security review](docs/security-review.md), and [release checklist](docs/release-checklist.md). The legacy one-document-per-profile layout still has Firestore's document-size limit; this implementation does not migrate production records to a new schema automatically.

## Hosting boundary

Only the explicit static-asset allowlist is copied to `dist/`. Hosting no longer serves the repository root. Android source/builds, signing files, tests, local recovery files and Firebase configuration files are excluded. Production hosting and security-rule deployment are separate release actions; neither is performed by the build.
