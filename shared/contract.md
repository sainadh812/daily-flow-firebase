# DailyFlow sync contract — schema 3

The pure reference implementation is `shared/sync-core.js` (browser global
`DailyFlowSyncCore`, CommonJS export). Android must produce the same JSON
operations and run the same fixtures. No operation is a stale whole-profile
replacement. Documents and operations are JSON; epoch timestamps use milliseconds.

## Documents and transaction ownership

A profile retains legacy `entries: {YYYY-MM-DD: [task,...]}` and
`pomLog: {YYYY-MM-DD: count}`, and adds `focusLog: {YYYY-MM-DD: seconds}`.
It contains `settings`, `achievements: {unlocked: [id,...]}`, `quickNotes`,
`customCats`, `tombstones`, `schemaVersion: 3`, `revision`, and `updatedAt`.
Unknown fields are retained. Tasks retain their stable string `id`, and comments
and subtasks are stable-id lists. Missing task properties are not filled with null:
missing and explicit null are different values. A metadata document contains
`profiles: [{id,...}]` and the same schema/revision/tombstone metadata. The device's
`activeProfile` / `activeProfileId` selection is excluded from metadata sync.

The adapter chooses an authenticated user path, reads the latest document and
receipt inside one transaction, applies an operation, sets schemaVersion=3,
revision=previous+1 and updatedAt, and updates the device receipt atomically.
The core does not increment revisions, timestamps, or receipt sequences.
An envelope adds `{deviceId,seq,id}` to the semantic operation. Receipt at
`<document>/receipts/<deviceId>` has `{seq,updatedAt}`. A sequence <= receipt is
already acknowledged; anything other than receipt+1 is a gap and must not apply.
Conflicts do not advance the receipt. Explicitly discarding a conflict substitutes
`{type:"noop"}` at that same sequence; it must not silently overwrite the server.

## Exact operation formats

A slot is `{exists:false}` or `{exists:true,value:<JSON>}`. Slots preserve the
distinction between an absent property and a property containing null.

* Field patch:
  `{type:"patch",target:{kind:"task",date,id},changes:{field:{before:slot,after:slot}},guard}`.
  Settings use target `{kind:"settings"}` with no guard. The entire patch validates
  before mutation. Task `id`, `subtasks`, `comments`, `pomodoros`, and `focusSeconds`
  cannot be patched. `guard` captures `done`, `archived`, and `rolledTo` as slots.
  A changed lifecycle blocks stale edits even when their individual field differs.
* Stable record:
  `{type:"record",target:{kind,date?,taskId?,id},before:slot,after:slot,guard?}`.
  Kinds: `task`, `subtask`, `comment`, `quickNote`, `customCat`, `profile`.
  Task records only add/delete; task expected snapshots omit metrics. Other records
  replace a single matching id, not the collection. Child records use `taskId`
  plus `date` and the parent's lifecycle guard. New tasks start with zero metrics.
* Order:
  `{type:"order",target,before:[ids],after:[ids],guard?}`.
  Targets are `{kind:"tasks",date}`, `{kind:"subtasks"|"comments",date,taskId}`,
  or `{kind:"quickNotes"|"customCats"|"profiles"}`. After must be a permutation
  of before. Compare relative order of surviving known ids; conflicting reorders
  are rejected. Concurrent additions retain their positions, and concurrent
  deletions are never recreated. Diffs put record add/remove operations first.
* Carry:
  `{type:"carry",source:{date,id},targetDate,sourceBefore,sourceAfter,target}`.
  All three task snapshots omit metrics. The source snapshot must still match
  in full (ignoring metrics) and the source must not be done, archived, carried,
  or deleted. Archived includes the legacy task `ghostDismissed` boolean and any
  source id in `settings.ghostDismissed`; these are checked transactionally so
  a concurrent legacy dismissal conflicts. Source change and destination creation
  are atomic. Destination id
  is `carry:<sourceDate>:<sourceId>:<targetDate>` when that string is at most 180
  UTF-16 code units. Longer values use
  `carry-h:<sourceDate>:<lowercase SHA-256 hex of sourceId UTF-8>:<targetDate>`.
  This distinct prefix keeps repeated carries bounded and deterministic without
  overlapping the literal format. UTF-8 encoding replaces lone surrogates with
  U+FFFD on both clients. All callers use the exported `carryId` helper and treat
  the result as opaque; `rolledFromTaskId` records the full source id. New task
  metrics are zero; source metrics are retained.
  Completed subtask states are preserved, even for legacy callers resetting them.
  Same-source/same-date duplicate carries do not create another task; a different
  destination conflicts. The diff recognizes legacy copied tasks by source date
  plus source id (when supplied), otherwise by matching content. Ambiguity conflicts.
* Achievements: `{type:"unlock",ids:[string,...]}` is monotonic set union.
* Explicit metrics import:
  `{type:"import-metrics",before:{pomLog,focusLog},after:{pomLog,focusLog}}`.
  Both current maps must still match before, or already match after. Ordinary
  profile diffs exclude these maps and all task metrics. Imports must not be used
  as an automatic fallback to resolve a session or metrics conflict.
  Optional top-level `taskMetrics:[{date,id,before:{pomodoros:slot,focusSeconds:slot},
  after:{pomodoros:slot,focusSeconds:slot}}]` restores per-task metrics using the
  same atomic expected-slot checks. All maps and task fields validate before any
  changes apply. Missing/deleted/tombstoned tasks are refused, and duplicate task
  targets are invalid. Imported values must be finite nonnegative numbers.
* Session wrapper: `{type:"segment",segment}` (see below).
* Skip: `{type:"noop"}` changes no domain data and acknowledges a sequence.

Deletion writes `tombstones[JSON.stringify([kind,date||"",taskId||"",id||""])]=true`.
These tombstones persist; stale adds cannot reuse the deleted id. A deliberate
new record must use a new id. Tombstones use compact JSON arrays of four strings
on both platforms, including standard JSON escaping, and are not Date objects.

## Session segments and metrics

Shape: `{id,sessionId,profileId,taskId:null|string,taskDate:null|"YYYY-MM-DD",
date:"YYYY-MM-DD",kind:"pomodoro"|"stopwatch",startedAt,endedAt,activeSeconds,
completedPomodoro:boolean,reason}`. Each immutable segment represents time not
previously uploaded. Dates are explicitly attributed by the timer client; split
at midnight when needed. `taskId` and `taskDate` are both present or both null.
Times and seconds are finite, nonnegative durations; activeSeconds cannot exceed
wall duration except a one-second rounding tolerance. Only a Pomodoro segment
may set completedPomodoro=true. Pausing does not complete a Pomodoro.

The transaction must read `sessions/<segment.id>` before applying. If it exists,
only acknowledge the operation receipt. Otherwise create the immutable segment
and update the latest profile using `applySegment` in the same transaction.
The pure function intentionally has no receipt memory: applying a segment twice
adds twice. Both clients MUST enforce deduplication through the immutable segment
document. Optimistic rebases include only pending, unacknowledged segments.

Segments add activeSeconds to profile focusLog[date] and add one to pomLog[date]
when completedPomodoro. They also update the attributed source task's
focusSeconds/pomodoros if that task still exists, including a historical task
carried to another date. Deleted tasks stay deleted while profile totals retain
the work. A document path/profileId mismatch must be rejected by the adapter.

## API and conflicts

`normalizeProfile`, `normalizeMeta`, `diffProfile`, `diffMeta`, `applyOperation`,
`applySegment`, and `rebase` do not mutate arguments. `diffProfile` returns semantic
operations without envelope ids or timestamps. The adapter must materialize
canonical carry ids by applying generated operations to its base before showing
the optimistic state; do not retain the legacy random destination id.
Documents with schemaVersion greater than 3 are rejected with code `schema`,
before normalization; an older client must never downgrade a future document.

`applyOperation` throws `ConflictError` with `code`, `message`, and JSON `details`.
`rebase(base,operations)` returns `{data,conflicts:[{index,op,code,message,details}]}`
and continues applying unrelated later operations. Invalid operations throw
TypeError rather than masquerading as conflicts. A successful individual field
patch is idempotent when its after value is already present and lifecycle guard
still matches. Receipts remain the authoritative retry mechanism.

Conflict choices should offer keeping the remote value, copying the local content
into a new record, or preparing a fresh expected-value operation from a reviewed
latest snapshot. An old snapshot must never be retried as an unconditional write.
