(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.DailyFlowSyncCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const copy = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
  const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
  const safe = k => { if (['__proto__', 'prototype', 'constructor'].includes(k)) throw new TypeError('Unsafe field: ' + k); return k; };
  function equal(a, b) {
    if (a === b) return true;
    if (a == null || b == null || typeof a !== typeof b) return false;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => equal(v, b[i]));
    if (!object(a) || !object(b)) return false;
    const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
    return equal(ak, bk) && ak.every(k => equal(a[k], b[k]));
  }
  const slot = (o, k) => own(o, k) ? { exists: true, value: copy(o[k]) } : { exists: false };
  const present = value => ({ exists: true, value: copy(value) });
  const absent = () => ({ exists: false });
  const sameSlot = (a, b) => !!a && !!b && a.exists === b.exists && (!a.exists || equal(a.value, b.value));
  const stripMetrics = task => { const r = copy(task); delete r.pomodoros; delete r.focusSeconds; return r; };
  const lifecycle = task => Object.fromEntries(['done', 'archived', 'rolledTo'].map(k => [k, slot(task, k)]));
  const ids = list => list.map(x => x.id);
  const tombstoneKey = t => JSON.stringify([t.kind, t.date || '', t.taskId || '', t.id || '']);
  // Synchronous SHA-256 for deterministic browser/native identifiers. Compression follows
  // the standard 64-round algorithm; no platform crypto state or third-party code is used.
  function sha256(value) {
    const bytes = new TextEncoder().encode(value), size = Math.ceil((bytes.length + 9) / 64) * 64;
    const padded = new Uint8Array(size); padded.set(bytes); padded[bytes.length] = 0x80;
    const view = new DataView(padded.buffer), bits = bytes.length * 8;
    view.setUint32(size - 8, Math.floor(bits / 0x100000000)); view.setUint32(size - 4, bits >>> 0);
    const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
      0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
      0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
      0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
      0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
      0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
      0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
      0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
    const hash = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    const words = new Uint32Array(64), rotate = (x, n) => (x >>> n) | (x << (32 - n));
    for (let offset = 0; offset < size; offset += 64) {
      for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
      for (let i = 16; i < 64; i++) {
        const x = words[i - 15], y = words[i - 2];
        words[i] = (words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10))) >>> 0;
      }
      let [a,b,c,d,e,f,g,h] = hash;
      for (let i = 0; i < 64; i++) {
        const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + words[i]) >>> 0;
        const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        h=g; g=f; f=e; e=(d+t1)>>>0; d=c; c=b; b=a; a=(t1+t2)>>>0;
      }
      [a,b,c,d,e,f,g,h].forEach((x,i) => { hash[i]=(hash[i]+x)>>>0; });
    }
    return hash.map(x => x.toString(16).padStart(8, '0')).join('');
  }
  function carryId(date, id, targetDate) {
    const literal = 'carry:' + date + ':' + id + ':' + targetDate;
    return literal.length <= 180 ? literal : 'carry-h:' + date + ':' + sha256(id) + ':' + targetDate;
  }

  class ConflictError extends Error {
    constructor(code, message, details) { super(message); this.name = 'ConflictError'; this.code = code; this.details = details || {}; }
  }
  const conflict = (code, message, details) => { throw new ConflictError(code, message, details); };
  function records(value, label) {
    if (value == null) return [];
    if (!Array.isArray(value)) throw new TypeError(label + ' must be an array');
    const seen = new Set();
    return value.map(item => {
      if (!object(item) || typeof item.id !== 'string' || !item.id || seen.has(item.id)) throw new TypeError(label + ' requires unique nonempty string ids');
      seen.add(item.id); return copy(item);
    });
  }
  function base(data) {
    if (data != null && !object(data)) throw new TypeError('Document must be a JSON object');
    if (data && Number(data.schemaVersion) > 3) conflict('schema', 'This data requires a newer app version', { schemaVersion: data.schemaVersion });
    const d = copy(data || {});
    d.schemaVersion = 3;
    d.revision = Number.isSafeInteger(d.revision) && d.revision >= 0 ? d.revision : 0;
    d.tombstones = object(d.tombstones) ? d.tombstones : {};
    return d;
  }
  function normalizeProfile(data) {
    const d = base(data);
    d.entries = object(d.entries) ? d.entries : {};
    Object.keys(d.entries).forEach(date => {
      safe(date);
      d.entries[date] = records(d.entries[date], 'entries.' + date).map(task => {
        if (own(task, 'subtasks')) task.subtasks = records(task.subtasks, 'subtasks');
        if (own(task, 'comments')) task.comments = records(task.comments, 'comments');
        return task;
      });
    });
    ['pomLog', 'focusLog', 'settings'].forEach(k => { d[k] = object(d[k]) ? d[k] : {}; });
    d.achievements = object(d.achievements) ? d.achievements : {};
    d.achievements.unlocked = Array.from(new Set(Array.isArray(d.achievements.unlocked) ? d.achievements.unlocked.filter(x => typeof x === 'string') : []));
    d.quickNotes = records(d.quickNotes, 'quickNotes');
    d.customCats = records(d.customCats, 'customCats');
    return d;
  }
  function normalizeMeta(data) {
    const d = base(data); d.profiles = records(d.profiles, 'profiles');
    delete d.activeProfile; delete d.activeProfileId; return d;
  }
  const normalize = data => object(data) && own(data, 'profiles') && !own(data, 'entries') ? normalizeMeta(data) : normalizeProfile(data);
  function taskAt(d, date, id) { return (d.entries && d.entries[date] || []).find(x => x.id === id); }
  function checkGuard(task, guard, target) {
    if (!task) conflict('deleted', 'Task no longer exists', { target });
    if (guard) Object.keys(guard).forEach(k => {
      if (!sameSlot(slot(task, k), guard[k])) conflict('lifecycle', 'Task lifecycle changed', { target, field: k, expected: guard[k], actual: slot(task, k) });
    });
  }
  function listAt(d, t, create) {
    if (t.kind === 'task' || t.kind === 'tasks') {
      if (!d.entries) throw new TypeError('Task operation requires a profile');
      safe(t.date);
      if (!d.entries[t.date] && create) d.entries[t.date] = [];
      return d.entries[t.date] || [];
    }
    if (['subtask', 'subtasks', 'comment', 'comments'].includes(t.kind)) {
      const task = taskAt(d, t.date, t.taskId);
      if (!task) conflict('deleted', 'Parent task no longer exists', { target: t });
      const key = t.kind.startsWith('subtask') ? 'subtasks' : 'comments';
      if (!task[key] && create) task[key] = [];
      return task[key] || [];
    }
    const key = { quickNote: 'quickNotes', quickNotes: 'quickNotes', customCat: 'customCats', customCats: 'customCats', profile: 'profiles', profiles: 'profiles' }[t.kind];
    if (!key || !Array.isArray(d[key])) throw new TypeError('Unknown collection target: ' + t.kind);
    return d[key];
  }
  function parentGuard(d, t, guard) {
    if (['subtask', 'comment', 'subtasks', 'comments'].includes(t.kind)) checkGuard(taskAt(d, t.date, t.taskId), guard, t);
  }
  function applyPatch(d, op) {
    const t = op.target;
    const dest = t.kind === 'settings' ? d.settings : t.kind === 'task' ? taskAt(d, t.date, t.id) : null;
    if (!dest) conflict('deleted', 'Patch target no longer exists', { target: t });
    if (t.kind === 'task') checkGuard(dest, op.guard, t);
    Object.keys(op.changes).forEach(field => {
      safe(field);
      if (t.kind === 'task' && ['id', 'subtasks', 'comments', 'pomodoros', 'focusSeconds'].includes(field)) throw new TypeError('Field requires a semantic operation: ' + field);
      const change = op.changes[field], current = slot(dest, field);
      if (!sameSlot(current, change.before) && !sameSlot(current, change.after)) conflict('field', 'Field was edited on another device', { target: t, field, expected: change.before, actual: current, proposed: change.after });
    });
    Object.keys(op.changes).forEach(field => { const s = op.changes[field].after; if (s.exists) dest[field] = copy(s.value); else delete dest[field]; });
  }
  function applyRecord(d, op) {
    const t = op.target;
    parentGuard(d, t, op.guard);
    const list = listAt(d, t, true), index = list.findIndex(x => x.id === t.id), current = index < 0 ? absent() : present(t.kind === 'task' ? stripMetrics(list[index]) : list[index]);
    const key = tombstoneKey(t);
    if (op.after.exists && d.tombstones[key]) conflict('deleted', 'Deleted record cannot be recreated by a stale operation', { target: t });
    if (sameSlot(current, op.after)) { if (!op.after.exists) d.tombstones[key] = true; return; }
    if (!sameSlot(current, op.before)) conflict(index < 0 ? 'deleted' : 'record', 'Record changed on another device', { target: t, expected: op.before, actual: current, proposed: op.after });
    if (!op.after.exists) {
      if (index >= 0) list.splice(index, 1);
      d.tombstones[key] = true;
    } else {
      const item = copy(op.after.value);
      if (!object(item) || item.id !== t.id) throw new TypeError('Record id must match target');
      if (t.kind === 'task') {
        if (index >= 0) throw new TypeError('Existing tasks must use field patches');
        item.pomodoros = 0; item.focusSeconds = 0;
      }
      if (index < 0) list.push(item); else list[index] = item;
    }
  }
  function applyOrder(d, op) {
    parentGuard(d, op.target, op.guard);
    const list = listAt(d, op.target, false), current = ids(list);
    if (new Set(op.before).size !== op.before.length || new Set(op.after).size !== op.after.length || !equal([...op.before].sort(), [...op.after].sort())) throw new TypeError('Order must be a permutation of before ids');
    const known = new Set(op.before), live = new Set(current);
    const currentKnown = current.filter(id => known.has(id));
    const beforeLive = op.before.filter(id => live.has(id)), afterLive = op.after.filter(id => live.has(id));
    if (equal(currentKnown, afterLive)) return;
    if (!equal(currentKnown, beforeLive)) conflict('order', 'List was reordered on another device', { target: op.target, expected: beforeLive, actual: currentKnown, proposed: afterLive });
    const byId = new Map(list.map(item => [item.id, item])); let pos = 0;
    const reordered = list.map(item => known.has(item.id) ? byId.get(afterLive[pos++]) : item);
    list.splice(0, list.length, ...reordered);
  }
  function applyCarry(d, op) {
    const s = op.source, src = taskAt(d, s.date, s.id), id = carryId(s.date, s.id, op.targetDate);
    if (op.targetDate <= s.date) throw new TypeError('Carry date must be later than source date');
    const existing = taskAt(d, op.targetDate, id);
    if (src && src.rolledTo === op.targetDate && existing && existing.rolledFromTaskId === s.id) return;
    if (!src || d.tombstones[tombstoneKey({ kind: 'task', date: s.date, id: s.id })]) conflict('deleted', 'Carry source was deleted', { source: s });
    const legacyDismissed = Array.isArray(d.settings.ghostDismissed) && d.settings.ghostDismissed.includes(s.id);
    if (src.done || src.archived || src.ghostDismissed || legacyDismissed || src.rolledTo) conflict('lifecycle', 'Only an active uncarried task can be carried', { source: s });
    if (!equal(stripMetrics(src), op.sourceBefore)) conflict('record', 'Carry source changed on another device', { source: s, expected: op.sourceBefore, actual: stripMetrics(src) });
    if (existing || d.tombstones[tombstoneKey({ kind: 'task', date: op.targetDate, id })]) conflict('carry', 'Carry destination already exists or was deleted', { source: s, targetDate: op.targetDate });
    const next = copy(op.target);
    next.id = id; next.done = false; next.rolledFrom = s.date; next.rolledFromTaskId = s.id; next.rolledTo = null; next.pomodoros = 0; next.focusSeconds = 0;
    // A carry retains work already completed on subtasks, including legacy callers that reset checkboxes.
    const states = new Map((src.subtasks || []).map(x => [x.id, x.done]));
    next.subtasks = (next.subtasks || src.subtasks || []).map(x => {
      const child = copy(x);
      if (states.has(x.id)) { if (states.get(x.id) === undefined) delete child.done; else child.done = states.get(x.id); }
      return child;
    });
    const sourceNext = { ...copy(op.sourceAfter), id: src.id, rolledTo: op.targetDate };
    if (own(src, 'pomodoros')) sourceNext.pomodoros = src.pomodoros;
    if (own(src, 'focusSeconds')) sourceNext.focusSeconds = src.focusSeconds;
    const arr = d.entries[s.date]; arr[arr.findIndex(x => x.id === s.id)] = sourceNext;
    if (!d.entries[op.targetDate]) d.entries[op.targetDate] = [];
    d.entries[op.targetDate].push(next);
  }
  function validDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s; }
  function applySegment(latest, segment) {
    const d = normalizeProfile(latest), s = segment;
    if (!object(s) || !['pomodoro', 'stopwatch'].includes(s.kind) || !validDate(s.date) || !['id', 'sessionId', 'profileId'].every(k => typeof s[k] === 'string' && s[k]) || !Number.isFinite(s.startedAt) || !Number.isFinite(s.endedAt) || s.endedAt < s.startedAt || !Number.isFinite(s.activeSeconds) || s.activeSeconds < 0 || s.activeSeconds > (s.endedAt - s.startedAt) / 1000 + 1 || typeof s.completedPomodoro !== 'boolean' || (s.kind !== 'pomodoro' && s.completedPomodoro)) throw new TypeError('Invalid session segment');
    if (!((s.taskId == null && s.taskDate == null) || (typeof s.taskId === 'string' && s.taskId && validDate(s.taskDate)))) throw new TypeError('Task attribution requires taskId and taskDate');
    const count = s.completedPomodoro ? 1 : 0;
    d.pomLog[s.date] = (Number(d.pomLog[s.date]) || 0) + count;
    d.focusLog[s.date] = (Number(d.focusLog[s.date]) || 0) + s.activeSeconds;
    if (s.taskId) {
      const task = taskAt(d, s.taskDate, s.taskId);
      if (task) { task.pomodoros = (Number(task.pomodoros) || 0) + count; task.focusSeconds = (Number(task.focusSeconds) || 0) + s.activeSeconds; }
    }
    return d;
  }
  function applyOperation(latest, op) {
    if (!object(op) || typeof op.type !== 'string') throw new TypeError('Operation must have a type');
    if (op.type === 'segment') return applySegment(latest, op.segment);
    const metaTarget = op.target && ['profile', 'profiles'].includes(op.target.kind);
    const d = metaTarget ? normalizeMeta(latest) : normalize(latest);
    switch (op.type) {
      case 'noop': break;
      case 'patch': applyPatch(d, op); break;
      case 'record': applyRecord(d, op); break;
      case 'order': applyOrder(d, op); break;
      case 'carry': applyCarry(d, op); break;
      case 'unlock': d.achievements.unlocked = Array.from(new Set([...d.achievements.unlocked, ...op.ids])); break;
      case 'import-metrics': {
        const current = { pomLog: d.pomLog, focusLog: d.focusLog };
        if (!equal(current, op.before) && !equal(current, op.after)) conflict('metrics', 'Metrics changed since import was prepared', { expected: op.before, actual: current });
        ['pomLog', 'focusLog'].forEach(k => {
          if (!object(op.after[k]) || Object.values(op.after[k]).some(n => !Number.isFinite(n) || n < 0)) throw new TypeError('Imported metrics must be nonnegative finite numbers');
        });
        const taskMetrics = op.taskMetrics || [];
        if (!Array.isArray(taskMetrics)) throw new TypeError('taskMetrics must be an array');
        const seen = new Set();
        taskMetrics.forEach(m => {
          const target = { kind: 'task', date: m.date, id: m.id }, key = tombstoneKey(target), task = taskAt(d, m.date, m.id);
          if (seen.has(key)) throw new TypeError('Duplicate task metric import'); seen.add(key);
          if (!task || d.tombstones[key]) conflict('deleted', 'Cannot import metrics into a deleted task', { target });
          ['pomodoros', 'focusSeconds'].forEach(field => {
            const before = m.before && m.before[field], after = m.after && m.after[field];
            if (!before || !after || typeof before.exists !== 'boolean' || typeof after.exists !== 'boolean' || (after.exists && (!Number.isFinite(after.value) || after.value < 0))) throw new TypeError('Task metric imports require valid before/after slots');
            const actual = slot(task, field);
            if (!sameSlot(actual, before) && !sameSlot(actual, after)) conflict('metrics', 'Task metrics changed since import was prepared', { target, field, expected: before, actual });
          });
        });
        d.pomLog = copy(op.after.pomLog); d.focusLog = copy(op.after.focusLog);
        taskMetrics.forEach(m => {
          const task = taskAt(d, m.date, m.id);
          ['pomodoros', 'focusSeconds'].forEach(field => { if (m.after[field].exists) task[field] = m.after[field].value; else delete task[field]; });
        });
        break;
      }
      default: throw new TypeError('Unknown operation type: ' + op.type);
    }
    return d;
  }
  function fieldChanges(before, after, excluded) {
    const changes = {};
    Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort().forEach(k => {
      if (excluded && excluded.has(k)) return;
      safe(k); const a = slot(before, k), b = slot(after, k);
      if (!sameSlot(a, b)) changes[k] = { before: a, after: b };
    });
    return changes;
  }
  function diffList(before, after, kind, target, orderTarget, operations, guard) {
    const a = new Map(before.map(x => [x.id, x])), b = new Map(after.map(x => [x.id, x]));
    before.forEach(item => { if (!b.has(item.id)) operations.push({ type: 'record', target: { ...target, kind, id: item.id }, before: present(kind === 'task' ? stripMetrics(item) : item), after: absent(), ...(guard ? { guard } : {}) }); });
    after.forEach(item => {
      const old = a.get(item.id);
      if (!old || (kind !== 'task' && !equal(old, item))) operations.push({ type: 'record', target: { ...target, kind, id: item.id }, before: old ? present(old) : absent(), after: present(kind === 'task' ? stripMetrics(item) : item), ...(guard ? { guard } : {}) });
    });
    const intermediate = before.filter(x => b.has(x.id)).map(x => x.id).concat(after.filter(x => !a.has(x.id)).map(x => x.id));
    if (!equal(intermediate, ids(after))) operations.push({ type: 'order', target: orderTarget, before: intermediate, after: ids(after), ...(guard ? { guard } : {}) });
  }
  function diffProfile(before, after) {
    if (object(before) && own(before, 'profiles') && !own(before, 'entries')) return diffMeta(before, after);
    let a = normalizeProfile(before); const b = normalizeProfile(after), ops = [];
    // Convert the web's copied-task carry representation to one atomic operation before diffing other edits.
    const used = new Set();
    Object.keys(a.entries).sort().forEach(date => a.entries[date].forEach(source => {
      const changed = taskAt(b, date, source.id);
      if (!changed || source.rolledTo || !changed.rolledTo || changed.rolledTo === source.rolledTo) return;
      const targetDate = changed.rolledTo;
      const candidates = (b.entries[targetDate] || []).filter(t => !taskAt(a, targetDate, t.id) && !used.has(t.id) && t.rolledFrom === date && (t.rolledFromTaskId ? t.rolledFromTaskId === source.id : t.content === source.content));
      if (candidates.length !== 1) conflict('carry', 'Carry must identify exactly one new target task', { source: { date, id: source.id }, targetDate });
      const target = candidates[0], oldId = target.id;
      const op = { type: 'carry', source: { date, id: source.id }, targetDate, sourceBefore: stripMetrics(source), sourceAfter: stripMetrics(changed), target: stripMetrics(target) };
      ops.push(op); used.add(oldId);
      a = applyOperation(a, op);
      const canonical = taskAt(a, targetDate, carryId(date, source.id, targetDate));
      b.entries[targetDate][b.entries[targetDate].findIndex(x => x.id === oldId)] = copy(canonical);
    }));
    const settings = fieldChanges(a.settings, b.settings);
    if (Object.keys(settings).length) ops.push({ type: 'patch', target: { kind: 'settings' }, changes: settings });
    const unlocked = b.achievements.unlocked.filter(id => !a.achievements.unlocked.includes(id));
    if (unlocked.length) ops.push({ type: 'unlock', ids: unlocked });
    const dates = Array.from(new Set([...Object.keys(a.entries), ...Object.keys(b.entries)])).sort();
    dates.forEach(date => {
      const oldList = a.entries[date] || [], newList = b.entries[date] || [];
      // Child changes use the old lifecycle; the parent's lifecycle patch is emitted last.
      newList.forEach(task => {
        const old = oldList.find(x => x.id === task.id); if (!old) return;
        const guard = lifecycle(old);
        diffList(old.subtasks || [], task.subtasks || [], 'subtask', { date, taskId: task.id }, { kind: 'subtasks', date, taskId: task.id }, ops, guard);
        diffList(old.comments || [], task.comments || [], 'comment', { date, taskId: task.id }, { kind: 'comments', date, taskId: task.id }, ops, guard);
        const changes = fieldChanges(old, task, new Set(['id', 'subtasks', 'comments', 'pomodoros', 'focusSeconds']));
        if (Object.keys(changes).length) ops.push({ type: 'patch', target: { kind: 'task', date, id: task.id }, changes, guard });
      });
      diffList(oldList, newList, 'task', { date }, { kind: 'tasks', date }, ops);
    });
    diffList(a.quickNotes, b.quickNotes, 'quickNote', {}, { kind: 'quickNotes' }, ops);
    diffList(a.customCats, b.customCats, 'customCat', {}, { kind: 'customCats' }, ops);
    return ops;
  }
  function diffMeta(before, after) {
    const a = normalizeMeta(before), b = normalizeMeta(after), ops = [];
    diffList(a.profiles, b.profiles, 'profile', {}, { kind: 'profiles' }, ops); return ops;
  }
  function rebase(baseDocument, operations) {
    let data = normalize(baseDocument); const conflicts = [];
    operations.forEach((op, index) => {
      try { data = applyOperation(data, op); }
      catch (error) {
        if (!(error instanceof ConflictError)) throw error;
        conflicts.push({ index, op: copy(op), code: error.code, message: error.message, details: copy(error.details) });
      }
    });
    return { data, conflicts };
  }
  return { normalizeProfile, normalizeMeta, diffProfile, diffMeta, applyOperation, applySegment, rebase, ConflictError, equal, tombstoneKey, carryId, sha256 };
});
