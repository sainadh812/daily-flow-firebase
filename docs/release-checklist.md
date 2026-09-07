# Release checklist

## Before any real-data rollout

- Back up the existing account/profile documents and verify a roundtrip import on disposable data. Keep the original unscoped browser storage until recovery is verified.
- Run all Node, browser, Firestore emulator, Kotlin unit and Android instrumentation tests on the final build. Verify the actual signed APK on the intended phone, including background/screen-off timers, force-close recovery, notification permission denial and battery restrictions.
- Test web and Android against disposable emulator accounts with two devices: independent edits, same-field conflict review, offline reconnect, duplicate carry, lost transaction response, import while remote time arrives, account switch and profile removal.
- Review prototype rules and their documented legacy-data validation limits. They deliberately reject old whole-document clients once schema-3 receipt enforcement is enabled.
- Verify Google/email/phone sign-in with the intended Firebase providers and installed signing certificate. Real Google account and SMS authentication cannot be certified by mocked UI or protocol tests.

## Coordinated production activation — requires explicit release approval

1. Close old website tabs/clients and retain backups.
2. Deploy reviewed rules and the new web build together in a controlled maintenance window. Rules-first rejects stale clients rather than allowing them to overwrite schema-3 data; during the interval the new client safely queues changes.
3. Reload the website, then install the matching Android APK. Keep a stable private signing key outside the repository for future APK updates. Debug and release signatures cannot update each other in place.
4. Verify a small disposable profile first, then existing profiles. Check both devices agree on tasks, saved segments and totals. Never import a stale full account dump as a sync-conflict workaround.
5. Monitor permission failures and queued conflicts. Do not loosen ownership checks to make an error disappear. Reverting the website to its old whole-profile writer is not a safe rollback after schema-3 activation; disable writes and use backups/recovery first.

No production hosting/rules deployment or real task-record mutation is part of local build/test commands. Registering the Android Firebase client and its debug certificate fingerprints is configuration only; it does not activate the new rules or test real-user sign-in.
