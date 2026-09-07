# Prototype Firestore rule review

These rules are local prototypes, not a claim of perfect security. They have not been deployed to the live project.

## Verified boundaries

- Identity is Firebase Auth UID matched to the document path. No user-controlled owner or role field grants authority.
- Unauthenticated users and a second authenticated user cannot get/list/write the first user's profiles, receipts or segments.
- Both create and update validate required envelope fields and top-level profile/meta types and collection bounds. Future schema versions cannot be downgraded.
- Parent revisions, per-device sequence receipts and acknowledgements advance together. An isolated parent write, forged receipt, skipped sequence, replay, or modification to another device's acknowledgement is denied.
- Segments are create-only, ID/profile scoped, typed and duration-bounded, and linked to an atomic parent mutation. Orphan, negative-duration, oversized-duration, invalid-kind, and immutable-record rewrite tests are rejected.
- Physical deletion of parents, receipts and segments is denied. Task deletion remains a semantic tombstone operation.
- Unknown legacy parent fields can remain unchanged during migration, but arbitrary new top-level fields cannot be introduced.

The emulator suite executes these attack cases and a successful transaction through the actual browser transaction adapter. Syntax is compiled by the Firestore emulator. No production data is used.

## Residual limitations requiring release review

The approved compatibility model retains date-keyed task arrays and other nested legacy collections in a single profile document. Firestore Rules cannot iterate arbitrary-length nested lists/maps. Container limits do not constitute complete per-element validation. Both clients validate operations and imported content, but a custom client authenticated as the owner can still corrupt its own nested records or fabricate its own productivity totals. There are no shared leaderboards, privileged counters, public profiles or cross-account effects relying on those values.

Complete server-side validation would require normalized task documents or a trusted mutation service and a separately reviewed migration. The current rules must not be presented as a comprehensive enforcement of every semantic-operation precondition. Session timestamps are epoch milliseconds for compatibility; date strings are format-checked, not proof of a real calendar date. Offline timestamps may be old, but cannot be more than five minutes in the future.

Personal data is never intentionally public. App Check, quotas, account recovery/deletion, and a dedicated production signing key still require a deployment review. Rules bound receipts to 256 device identities and tombstones to 10,000 per profile; large/old profiles need a compaction design rather than silently dropping history.

## Auditor assessment

```json
{
  "score": 4,
  "summary": "Owner isolation and fixed-shape sync records are protected and emulator-tested. Legacy nested owner data is not exhaustively validated server-side.",
  "findings": [{
    "check": "Deep array validation and resource bounds",
    "severity": "minor",
    "issue": "An authenticated owner can corrupt their own nested legacy task data using a custom client; top-level container limits do not validate every nested string/element.",
    "recommendation": "Before broad release, normalize task records or introduce a trusted mutation service, then add adversarial per-field tests. Preserve legacy data through a separately approved migration."
  }, {
    "check": "Counter business-logic trust",
    "severity": "minor",
    "issue": "Owner-authenticated custom clients can fabricate their own productivity aggregates. Receipts enforce ordered transactions, not that every operation was produced by an approved UI.",
    "recommendation": "Do not use these totals for cross-user rewards, billing, or authorization. A trusted server must derive any such totals from validated events."
  }]
}
```
