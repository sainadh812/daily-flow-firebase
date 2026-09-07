'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../shared/sync-core');
const clone = x => JSON.parse(JSON.stringify(x));
const date = '2026-09-07';
const task = (id = 'a', extra = {}) => ({ id, content: 'Write report', done: false, rolledTo: null, subtasks: [], comments: [], ...extra });
const profile = (tasks = [task()]) => core.normalizeProfile({ entries: { [date]: tasks } });
const entry = d => d.entries[date][0];
const run = (base, ops) => ops.reduce((d, op) => core.applyOperation(d, op), base);
const expectConflict = (fn, code) => assert.throws(fn, e => e instanceof core.ConflictError && (!code || e.code === code));

test('browser UMD and CommonJS expose the same contract', () => {
  const context = vm.createContext({ TextEncoder });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../shared/sync-core.js'), 'utf8'), context);
  assert.equal(typeof context.DailyFlowSyncCore.diffProfile, 'function');
  assert.equal(core.normalizeProfile({}).schemaVersion, 3);
});

test('carry rejects a concurrent legacy dismissal array or boolean without changing history', () => {
  const base = profile(), desired = clone(base);
  entry(desired).rolledTo = '2026-09-08';
  desired.entries['2026-09-08'] = [task('temporary', {rolledFrom: date})];
  const carry = core.diffProfile(base, desired).find(op => op.type === 'carry');
  for (const kind of ['array', 'boolean', 'archived']) {
    const remote = clone(base);
    if (kind === 'array') remote.settings.ghostDismissed = ['a', 'other'];
    else entry(remote)[kind === 'boolean' ? 'ghostDismissed' : 'archived'] = true;
    const before = clone(remote);
    expectConflict(() => core.applyOperation(remote, carry), 'lifecycle');
    assert.deepEqual(remote, before);
  }
  const unrelated = clone(base); unrelated.settings.ghostDismissed = ['other'];
  assert.equal(core.applyOperation(unrelated, carry).entries['2026-09-08'].length, 1);
});

test('normalization preserves unknown data and missing/null while dropping local meta selection', () => {
  const original = { entries: { [date]: [task('a', { custom: { x: 1 }, notes: null })] }, future: { x: 2 }, revision: 7 };
  const d = core.normalizeProfile(original);
  assert.deepEqual(d.future, { x: 2 }); assert.equal(d.revision, 7);
  assert.equal(entry(d).notes, null); assert.equal('priority' in entry(d), false);
  assert.equal('schemaVersion' in original, false);
  const meta = core.normalizeMeta({ profiles: [{ id: 'p', name: 'Personal' }], activeProfile: 'p', activeProfileId: 'p' });
  assert.equal('activeProfile' in meta, false); assert.equal('activeProfileId' in meta, false);
  assert.throws(() => core.normalizeProfile({ entries: { [date]: [task(), task()] } }), /unique/);
});

test('independent task fields and independent settings merge without whole-document overwrite', () => {
  const base = profile(), local = clone(base), remote = clone(base);
  entry(local).content = 'Local title'; local.settings.dark = true;
  entry(remote).notes = 'Remote notes'; remote.settings.timeFormat24 = true;
  const merged = run(remote, core.diffProfile(base, local));
  assert.equal(entry(merged).content, 'Local title'); assert.equal(entry(merged).notes, 'Remote notes');
  assert.equal(merged.settings.dark, true); assert.equal(merged.settings.timeFormat24, true);
  assert.equal(merged.revision, 0);
});

test('same-field conflicts are atomic even in multi-field patches', () => {
  const base = profile(), local = clone(base), remote = clone(base);
  entry(local).content = 'Local'; entry(local).priority = 'high'; entry(remote).content = 'Remote';
  const snapshot = clone(remote);
  expectConflict(() => run(remote, core.diffProfile(base, local)), 'field');
  assert.deepEqual(remote, snapshot);
});

test('missing and null differ and deletion of one property is explicit', () => {
  const base = profile(), local = clone(base), remote = clone(base);
  entry(local).notes = 'local'; entry(remote).notes = null;
  const ops = core.diffProfile(base, local);
  assert.deepEqual(ops[0].changes.notes.before, { exists: false });
  expectConflict(() => run(remote, ops), 'field');
  const desired = clone(remote); delete entry(desired).notes;
  assert.equal('notes' in entry(run(remote, core.diffProfile(remote, desired))), false);
});

test('children merge by id, and child edits precede completion lifecycle patch', () => {
  const base = profile([task('a', { subtasks: [{ id: 's1', text: 'One', done: false }, { id: 's2', text: 'Two', done: false }] })]);
  const local = clone(base), remote = clone(base);
  entry(local).subtasks[0].done = true; entry(local).done = true;
  entry(remote).subtasks[1].text = 'Remote two';
  const merged = run(remote, core.diffProfile(base, local));
  assert.equal(entry(merged).subtasks[0].done, true); assert.equal(entry(merged).subtasks[1].text, 'Remote two'); assert.equal(entry(merged).done, true);
});

test('same child record changes conflict and parent carry blocks stale child edits', () => {
  const base = profile([task('a', { comments: [{ id: 'c', text: 'Old' }] })]), local = clone(base), remote = clone(base);
  entry(local).comments[0].text = 'Local'; entry(remote).comments[0].text = 'Remote';
  expectConflict(() => run(remote, core.diffProfile(base, local)), 'record');
  entry(remote).comments[0].text = 'Old'; entry(remote).rolledTo = '2026-09-08';
  expectConflict(() => run(remote, core.diffProfile(base, local)), 'lifecycle');
});

test('task deletion preserves concurrent metrics but conflicts with content edits and leaves tombstone', () => {
  const base = profile(), gone = profile([]), remote = clone(base); entry(remote).pomodoros = 4;
  const ops = core.diffProfile(base, gone), result = run(remote, ops);
  assert.equal(result.entries[date].length, 0);
  assert.equal(result.tombstones[core.tombstoneKey({ kind: 'task', date, id: 'a' })], true);
  expectConflict(() => run(result, core.diffProfile(profile([]), base)), 'deleted');
  entry(remote).content = 'changed'; expectConflict(() => run(remote, ops), 'record');
});

test('record tombstones prevent quick-note and child resurrection', () => {
  const base = profile([task('a', { comments: [{ id: 'c', text: 'Old' }] })]); base.quickNotes = [{ id: 'q', text: 'Note' }];
  const removed = clone(base); removed.quickNotes = []; entry(removed).comments = [];
  const deleted = run(base, core.diffProfile(base, removed));
  assert.equal(Object.keys(deleted.tombstones).length, 2);
  expectConflict(() => run(deleted, core.diffProfile(removed, base)), 'deleted');
});

test('concurrent record additions survive a local reorder; deletions stay deleted', () => {
  const base = profile([task('a'), task('b'), task('c')]), local = clone(base), remote = clone(base);
  local.entries[date] = [entry(local), local.entries[date][2], local.entries[date][1]];
  remote.entries[date].splice(1, 0, task('remote')); remote.entries[date] = remote.entries[date].filter(x => x.id !== 'b');
  assert.deepEqual(run(remote, core.diffProfile(base, local)).entries[date].map(x => x.id), ['a', 'remote', 'c']);
});

test('competing reorder conflicts rather than silently reverting remote order', () => {
  const base = profile([task('a'), task('b'), task('c')]), local = clone(base), remote = clone(base);
  local.entries[date].reverse(); remote.entries[date] = [remote.entries[date][1], remote.entries[date][0], remote.entries[date][2]];
  expectConflict(() => run(remote, core.diffProfile(base, local)), 'order');
});

test('new record insertion is represented as add then reorder and reproduces desired placement', () => {
  const base = profile([task('a'), task('b')]), local = clone(base); local.entries[date].unshift(task('new'));
  const ops = core.diffProfile(base, local);
  assert.deepEqual(ops.map(o => o.type), ['record', 'order']);
  assert.deepEqual(run(base, ops).entries[date].map(x => x.id), ['new', 'a', 'b']);
});

function carryScenario(targetDate = '2026-09-08') {
  const base = profile([task('a', { pomodoros: 2, focusSeconds: 3000, subtasks: [{ id: 's', text: 'Done already', done: true }], comments: [{ id: 'c', text: 'History' }] })]);
  const after = clone(base); entry(after).rolledTo = targetDate; entry(after).timeSpent = '50 min';
  after.entries[targetDate] = [task('legacy-random-id', { rolledFrom: date, subtasks: [{ id: 's', text: 'Done already', done: false }], comments: [{ id: 'roll', text: 'Rolled', system: true }, { id: 'c', text: 'History' }] })];
  return { base, after, targetDate };
}

test('carry is atomic, canonical, preserves history and completed subtasks, and resets target metrics', () => {
  const { base, after, targetDate } = carryScenario(), ops = core.diffProfile(base, after);
  assert.equal(ops.filter(o => o.type === 'carry').length, 1);
  assert.equal(ops.filter(o => o.type === 'record').length, 0);
  const moved = run(base, ops), target = moved.entries[targetDate][0];
  assert.equal(entry(moved).rolledTo, targetDate); assert.equal(entry(moved).pomodoros, 2);
  assert.equal(target.id, core.carryId(date, 'a', targetDate)); assert.equal(target.rolledFromTaskId, 'a');
  assert.equal(target.subtasks[0].done, true); assert.equal(target.comments.length, 2); assert.equal(target.pomodoros, 0);
  assert.equal(after.entries[targetDate][0].id, 'legacy-random-id');
});

test('duplicate carry to same day is idempotent; another destination conflicts', () => {
  const { base, after } = carryScenario(), ops = core.diffProfile(base, after), moved = run(base, ops);
  assert.deepEqual(run(moved, ops), moved);
  const other = carryScenario('2026-09-09');
  expectConflict(() => run(moved, core.diffProfile(other.base, other.after)), 'lifecycle');
});

test('carry rejects a concurrently completed, archived, changed or deleted source', () => {
  const { base, after } = carryScenario(), ops = core.diffProfile(base, after);
  for (const field of ['done', 'archived']) { const remote = clone(base); entry(remote)[field] = true; expectConflict(() => run(remote, ops), 'lifecycle'); }
  const edited = clone(base); entry(edited).content = 'New'; expectConflict(() => run(edited, ops), 'record');
  expectConflict(() => run(profile([]), ops), 'deleted');
});

test('stale ordinary lifecycle changes conflict with a concurrent carry', () => {
  const { base, after } = carryScenario(), local = clone(base); entry(local).done = true;
  const moved = run(base, core.diffProfile(base, after));
  expectConflict(() => run(moved, core.diffProfile(base, local)), 'lifecycle');
});

const segment = extra => ({ id: 'seg1', sessionId: 'timer1', profileId: 'p1', taskId: 'a', taskDate: date, date, kind: 'pomodoro', startedAt: 1000, endedAt: 61000, activeSeconds: 60, completedPomodoro: true, reason: 'complete', ...extra });

test('ordinary diff cannot overwrite task metrics or aggregate counters', () => {
  const base = profile(), local = clone(base); entry(local).pomodoros = 99; entry(local).focusSeconds = 999; local.pomLog[date] = 99; local.focusLog[date] = 999;
  assert.deepEqual(core.diffProfile(base, local), []);
});

test('segments add time and completed counts to explicit day and source task', () => {
  const { base, after } = carryScenario(), moved = run(base, core.diffProfile(base, after));
  const result = core.applySegment(moved, segment());
  assert.equal(result.pomLog[date], 1); assert.equal(result.focusLog[date], 60);
  assert.equal(entry(result).pomodoros, 3); assert.equal(entry(result).focusSeconds, 3060);
  assert.equal(result.entries['2026-09-08'][0].pomodoros, 0);
  const stopwatch = core.applySegment(result, segment({ id: 'seg2', kind: 'stopwatch', completedPomodoro: false }));
  assert.equal(stopwatch.pomLog[date], 1); assert.equal(stopwatch.focusLog[date], 120);
});

test('segments preserve task deletion and adapter receipt deduplication is explicit', () => {
  const base = profile([]), one = core.applySegment(base, segment());
  assert.deepEqual(one.entries[date], []); assert.equal(one.focusLog[date], 60);
  // Pure reducer has no receipt store. Production adapter must check immutable session id.
  assert.equal(core.applySegment(one, segment()).focusLog[date], 120);
  const receipt = new Set(); let d = base;
  for (const s of [segment(), segment()]) if (!receipt.has(s.id)) { d = core.applySegment(d, s); receipt.add(s.id); }
  assert.equal(d.focusLog[date], 60);
});

test('invalid time ranges and stopwatch completions are rejected without mutation', () => {
  const base = profile(), before = clone(base);
  for (const bad of [{ activeSeconds: -1 }, { activeSeconds: 100 }, { endedAt: 0 }, { date: '2026-02-30' }, { kind: 'stopwatch' }, { taskDate: null }]) assert.throws(() => core.applySegment(base, segment(bad)), TypeError);
  assert.deepEqual(base, before);
});

test('explicit metrics imports conflict with new completed segments', () => {
  const base = profile(), op = { type: 'import-metrics', before: { pomLog: {}, focusLog: {} }, after: { pomLog: { [date]: 2 }, focusLog: { [date]: 3000 } } };
  assert.equal(core.applyOperation(base, op).pomLog[date], 2);
  expectConflict(() => core.applyOperation(core.applySegment(base, segment()), op), 'metrics');
});

test('achievement unlocks merge monotonically across clients', () => {
  const base = profile(), local = clone(base), remote = clone(base);
  local.achievements.unlocked = ['first_entry']; remote.achievements.unlocked = ['first_pom'];
  assert.deepEqual(run(remote, core.diffProfile(base, local)).achievements.unlocked, ['first_pom', 'first_entry']);
});

test('metadata records merge independent profiles and exclude active profile selection', () => {
  const base = core.normalizeMeta({ profiles: [{ id: 'p', name: 'Personal' }, { id: 'w', name: 'Work' }] }), local = clone(base), remote = clone(base);
  local.profiles[0].name = 'Home'; local.activeProfileId = 'w'; remote.profiles[1].color = '#fff';
  const merged = run(remote, core.diffMeta(base, local));
  assert.equal(merged.profiles[0].name, 'Home'); assert.equal(merged.profiles[1].color, '#fff'); assert.equal('activeProfileId' in merged, false);
  assert.equal(run({}, core.diffMeta({}, { profiles: [{ id: 'p', name: 'P' }] })).profiles.length, 1);
});

test('rebase reports conflicts and retains unrelated later edits; no-op leaves domain data unchanged', () => {
  const base = profile(), local = clone(base), remote = clone(base);
  entry(local).content = 'Local'; local.quickNotes.push({ id: 'q', text: 'Keep this' }); entry(remote).content = 'Remote';
  const result = core.rebase(remote, core.diffProfile(base, local));
  assert.equal(result.conflicts.length, 1); assert.equal(result.conflicts[0].code, 'field');
  assert.equal(entry(result.data).content, 'Remote'); assert.equal(result.data.quickNotes[0].text, 'Keep this');
  assert.deepEqual(core.applyOperation(result.data, { type: 'noop' }), result.data);
});

test('shared cross-platform fixtures match expected data and conflict codes', () => {
  const fixtures = require('../shared/fixtures.json');
  for (const fixture of fixtures.cases) {
    const result = core.rebase(fixture.base, fixture.ops);
    const expected = fixture.meta ? core.normalizeMeta(fixture.expected) : core.normalizeProfile(fixture.expected);
    assert.deepEqual(result.data, expected, fixture.name);
    assert.deepEqual(result.conflicts.map(x => x.code), fixture.conflictCodes, fixture.name);
  }
});

test('future schemas are rejected before any data is normalized or downgraded', () => {
  expectConflict(() => core.normalizeProfile({ schemaVersion: 4 }), 'schema');
  expectConflict(() => core.normalizeMeta({ schemaVersion: 4, profiles: [] }), 'schema');
  expectConflict(() => core.applyOperation({ schemaVersion: 4 }, { type: 'noop' }), 'schema');
});

test('task metric restore validates every task atomically and is idempotent', () => {
  const base = profile([task('a', { pomodoros: 0, focusSeconds: 0 }), task('b', { pomodoros: 1, focusSeconds: 60 })]);
  const slot = value => ({ exists: true, value });
  const metric = (id, p, seconds) => ({ date, id, before: { pomodoros: slot(p), focusSeconds: slot(seconds) }, after: { pomodoros: slot(3), focusSeconds: slot(180) } });
  const op = { type: 'import-metrics', before: { pomLog: {}, focusLog: {} }, after: { pomLog: { [date]: 6 }, focusLog: { [date]: 360 } }, taskMetrics: [metric('a', 0, 0), metric('b', 0, 0)] };
  const snapshot = clone(base);
  expectConflict(() => core.applyOperation(base, op), 'metrics'); assert.deepEqual(base, snapshot);
  op.taskMetrics[1] = metric('b', 1, 60);
  const restored = core.applyOperation(base, op);
  assert.equal(entry(restored).pomodoros, 3); assert.equal(restored.entries[date][1].focusSeconds, 180);
  assert.deepEqual(core.applyOperation(restored, op), restored);
  op.taskMetrics[1].after.focusSeconds.value = -1;
  assert.throws(() => core.applyOperation(base, op), TypeError);
});

test('tombstone keys use canonical compact JSON escaping', () => {
  assert.equal(core.tombstoneKey({ kind: 'comment', date, taskId: '</a>', id: 'q\n"\\' }), '["comment","2026-09-07","</a>","q\\n\\"\\\\"]');
});

test('synchronous browser SHA-256 matches exact vectors and Node crypto for UTF-8 boundaries', () => {
  const crypto = require('node:crypto');
  for (const { source, hash } of require('../shared/fixtures.json').hashVectors) assert.equal(core.sha256(source), hash);
  for (const source of ['a'.repeat(55), 'a'.repeat(56), 'a'.repeat(63), 'a'.repeat(64), 'a'.repeat(65), '🙂'.repeat(60), '\ud800', 'x'.repeat(5000)]) assert.equal(core.sha256(source), crypto.createHash('sha256').update(source).digest('hex'));
});

test('repeated carries stay bounded, deterministic and distinct without reusing deleted ids', () => {
  let id = 'initial'; const seen = new Set([id]);
  for (let day = 0; day < 1000; day++) {
    const from = new Date(Date.UTC(2026, 8, 7 + day)).toISOString().slice(0, 10), to = new Date(Date.UTC(2026, 8, 8 + day)).toISOString().slice(0, 10);
    const next = core.carryId(from, id, to);
    assert.equal(next, core.carryId(from, id, to)); assert.ok(next.length <= 180); assert.equal(seen.has(next), false);
    seen.add(next); id = next;
  }
  assert.equal(core.carryId(date, 'a', '2026-09-08'), 'carry:2026-09-07:a:2026-09-08');
  const fixture = require('../shared/fixtures.json').cases.find(x => x.name === 'compact deterministic carry id');
  const moved = core.applyOperation(fixture.base, fixture.ops[0]);
  assert.equal(moved.entries['2026-09-08'][0].id, fixture.expected.entries['2026-09-08'][0].id);
  assert.deepEqual(core.applyOperation(moved, fixture.ops[0]), moved);
});
