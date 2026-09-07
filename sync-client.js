/* Durable, identity-scoped outbox. The view is server baseline + pending operations.
 * SDK access is injected so tests never need the production Firebase project. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./shared/sync-core.js') : root.DailyFlowSyncCore);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DailyFlowSync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (core) {
  'use strict';
  const clone = value => JSON.parse(JSON.stringify(value));
  const result = request => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const completed = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Local storage transaction aborted'));
  });

  class Outbox {
    constructor(db) { this.db = db; }
    static async open(indexedDB = globalThis.indexedDB, name = 'dailyflow-sync-v3') {
      if (!indexedDB) throw new Error('Durable browser storage is unavailable. Cloud saving is disabled.');
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('state', { keyPath: 'key' });
        const queue = db.createObjectStore('queue', { keyPath: 'key', autoIncrement: true });
        queue.createIndex('scope', 'scope');
      };
      return new Outbox(await result(req));
    }
    async read(key) {
      return (await result(this.db.transaction('state').objectStore('state').get(key)))?.value;
    }
    async write(key, value) {
      const tx = this.db.transaction('state', 'readwrite');
      const done = completed(tx);
      tx.objectStore('state').put({ key, value: clone(value) });
      await done;
    }
    async acceptBaseline(scope, value, acknowledgedKey) {
      const tx = this.db.transaction(['state', 'queue'], 'readwrite'), done = completed(tx);
      const state = tx.objectStore('state'), key = 'baseline:' + scope;
      const previous = (await result(state.get(key)))?.value;
      const older = previous && ((previous.revision || 0) > (value.revision || 0) ||
        ((previous.revision || 0) === (value.revision || 0) && Object.entries(previous.acks || {}).some(([device,seq]) => seq > (value.acks?.[device] || 0))));
      const next = older ? previous : value;
      state.put({key,value:clone(next)});
      if (acknowledgedKey !== undefined) tx.objectStore('queue').delete(acknowledgedKey);
      await done;
      return clone(next);
    }
    async enqueue(scope, operations, journalId) {
      if (!operations.length) return [];
      const tx = this.db.transaction(['state', 'queue'], 'readwrite');
      const done = completed(tx);
      const states = tx.objectStore('state');
      if (journalId && await result(states.get('journal:' + scope + ':' + journalId))) { await done; return []; }
      const identity = await result(states.get('device'));
      const deviceId = identity?.value || globalThis.crypto.randomUUID();
      if (!identity) states.put({ key: 'device', value: deviceId });
      const streamKey = `sequence:${scope}:${deviceId}`;
      let seq = (await result(states.get(streamKey)))?.value || 0;
      const rows = [];
      for (const operation of operations) {
        const row = { scope, deviceId, seq: ++seq, operation: clone(operation) };
        row.key = await result(tx.objectStore('queue').add(row));
        rows.push(row);
      }
      states.put({ key: streamKey, value: seq });
      if (journalId) states.put({ key:'journal:' + scope + ':' + journalId, value:true });
      await done;
      return rows;
    }
    async pending(scope) {
      const rows = await result(this.db.transaction('queue').objectStore('queue').index('scope').getAll(scope));
      return rows.sort((a, b) => a.key - b.key);
    }
    async remove(key) {
      const tx = this.db.transaction('queue', 'readwrite'); const done = completed(tx);
      tx.objectStore('queue').delete(key); await done;
    }
    async replace(row, expectedOperation) {
      const tx = this.db.transaction('queue', 'readwrite'); const done = completed(tx);
      const queue = tx.objectStore('queue'), current = await result(queue.get(row.key));
      const matches = current && current.scope === row.scope && current.deviceId === row.deviceId && current.seq === row.seq &&
        (expectedOperation === undefined || core.equal(current.operation,expectedOperation));
      if (matches) queue.put(clone(row)); await done;
      return !!matches;
    }
    close() { this.db.close(); }
  }

  class Client {
    constructor({ uid, profileId, meta = false, outbox, transport, onData = () => {}, onStatus = () => {} }) {
      if (!uid || /\//.test(uid) || (!meta && (!profileId || /\//.test(profileId)))) throw new Error('Invalid account/profile scope');
      Object.assign(this, { uid, profileId, meta, outbox, transport, onData, onStatus });
      this.path = meta ? `users/${uid}/meta/root` : `users/${uid}/profiles/${profileId}`;
      this.scope = this.path;
      this.normalize = meta ? core.normalizeMeta : core.normalizeProfile;
      this.base = this.normalize({}); this.view = clone(this.base);
      this.serial = Promise.resolve(); this.stopped = false; this.conflict = null;
      this.retryMs = 1000; this.ready = false;
      this.connectionError = null;
    }
    async start() {
      const saved = await this.outbox.read(`baseline:${this.scope}`);
      if (this.stopped) return this;
      if (saved) this.base = this.normalize(saved);
      await this.publish();
      if (this.stopped) return this;
      this.unsubscribe = this.transport.subscribe(this.path, data => {
        this.serial = this.serial.then(async () => {
          if (this.stopped) return;
          if ((data?.schemaVersion || 0) > 3) throw new Error('This account needs a newer DailyFlow version.');
          if ((data?.revision || 0) < this.base.revision) return;
          this.base = this.normalize(await this.outbox.acceptBaseline(this.scope, this.normalize(data || {})));
          this.ready = true;
          await this.publish();
        }).catch(error => { this.connectionError = error; this.status('Needs attention', error); });
        this.serial.then(() => this.flush());
      }, error => { this.connectionError = error; this.status('Needs attention', error); });
      return this;
    }
    status(label, error) { this.lastStatus = { label, error: error?.message || '', conflict: this.conflict }; this.onStatus(this.lastStatus); }
    async publish() {
      if (this.stopped) return;
      const pending = (await this.outbox.pending(this.scope)).filter(row => row.seq > (this.base.acks?.[row.deviceId] || 0));
      if (this.stopped) return;
      const rebased = core.rebase(this.base, pending.map(row => row.operation));
      this.view = rebased.data;
      this.onData(clone(this.view));
      if (this.conflict || rebased.conflicts.length) this.status('Needs attention', this.connectionError);
      else if (this.connectionError) this.status(this.connectionError.code === 'permission-denied' ? 'Needs attention' : 'Saved locally', this.connectionError);
      else this.status(pending.length ? 'Saved locally' : (this.ready ? 'Synced' : 'Saved locally'));
    }
    enqueue(operations, journalId) {
      if (this.stopped) return Promise.reject(new Error('This account is no longer active'));
      this.serial = this.serial.catch(() => {}).then(async () => {
        await this.outbox.enqueue(this.scope, operations, journalId);
        await this.publish();
      });
      this.serial.then(() => this.flush()).catch(error => this.status('Needs attention', error));
      return this.serial;
    }
    async flush() {
      if (this.flushing || this.stopped || this.conflict || !this.ready) return;
      this.flushing = true;
      try {
        while (!this.stopped) {
          const row = (await this.outbox.pending(this.scope))[0];
          if (!row) break;
          this.status('Syncing');
          try {
            const committed = await this.transport.commit(this.path, row, this.meta);
            if (this.stopped) return;
            // A receipt proves acknowledgement even if a previous response was lost.
            const next = (committed?.revision || 0) >= this.base.revision ? this.normalize(committed) : this.base;
            this.base = this.normalize(await this.outbox.acceptBaseline(this.scope, next, row.key));
            this.retryMs = 1000;
            this.connectionError = null;
          } catch (error) {
            if (error.name === 'ConflictError' || error.code === 'sync-conflict') {
              if (error.latest) this.base = this.normalize(await this.outbox.acceptBaseline(this.scope, error.latest));
              this.conflict = { row, message: error.message, details: error.details || null };
              this.status('Needs attention', error);
            } else {
              this.connectionError = error;
              this.status(error.code === 'permission-denied' ? 'Needs attention' : 'Saved locally', error);
              clearTimeout(this.retryTimer);
              this.retryTimer = setTimeout(() => this.flush(), this.retryMs);
              this.retryMs = Math.min(60000, this.retryMs * 2);
            }
            break;
          }
          await this.publish();
        }
      } finally {
        this.flushing = false;
        if (!this.stopped) await this.publish();
      }
    }
    // Discard only this pending change, not the task or remaining outbox. Still ack its sequence.
    async keepServerVersion() {
      if (!this.conflict) return;
      const previous = this.conflict.row;
      const row = {...previous,operation:{type:'noop'}};
      await this.outbox.replace(row,previous.operation);
      this.conflict = null;
      await this.publish(); await this.flush();
    }
    async retryWithOperation(operation) {
      if (!this.conflict) return;
      const previous = this.conflict.row, row = {...previous,operation};
      await this.outbox.replace(row,previous.operation); this.conflict = null;
      await this.publish(); await this.flush();
    }
    stop() { this.stopped = true; this.unsubscribe?.(); clearTimeout(this.retryTimer); }
  }

  function firebaseTransport(sdk) {
    const { db, doc, onSnapshot, runTransaction } = sdk;
    return {
      subscribe(path, update, error) {
        return onSnapshot(doc(db, path), snapshot => update(snapshot.exists() ? snapshot.data() : null), error);
      },
      commit(path, row, meta) {
        return runTransaction(db, async tx => {
          const ref = doc(db, path);
          const receiptRef = doc(db, `${path}/receipts/${row.deviceId}`);
          const snapshot = await tx.get(ref);
          const receipt = await tx.get(receiptRef);
          const normalize = meta ? core.normalizeMeta : core.normalizeProfile;
          const raw = snapshot.exists() ? snapshot.data() : {};
          if (raw.schemaVersion > 3) throw new Error('Update DailyFlow before editing this profile.');
          const latest = normalize(raw);
          const ack = receipt.exists() ? receipt.data().seq : 0;
          if (row.seq <= ack) {
            latest.acks = {...(latest.acks || {}),[row.deviceId]:Math.max(ack,latest.acks?.[row.deviceId] || 0)};
            return latest;
          }
          if (row.seq !== ack + 1) {
            const error = new Error('A pending change is missing. Export recovery data before continuing.');
            error.name = 'ConflictError'; throw error;
          }
          let next;
          let segmentRef, segmentSnapshot;
          if (row.operation.type === 'segment') {
            if (meta) throw new Error('Time cannot be recorded on account metadata');
            const segment = row.operation.segment;
            if (segment.profileId !== path.split('/').at(-1) || /\//.test(segment.id)) throw new Error('Invalid time record scope');
            segmentRef = doc(db, `${path}/sessions/${segment.id}`);
            segmentSnapshot = await tx.get(segmentRef);
            next = segmentSnapshot.exists() ? latest : core.applySegment(latest, segment);
          } else {
            try { next = core.applyOperation(latest, row.operation); }
            catch (error) { error.latest = latest; throw error; }
          }
          const now = Date.now();
          next.schemaVersion = 3;
          next.revision = (latest.revision || 0) + 1;
          next.updatedAt = now;
          next.lastMutation = { deviceId: row.deviceId, seq: row.seq, segmentId: row.operation.type === 'segment' ? row.operation.segment.id : null };
          next.acks = { ...(latest.acks || {}), [row.deviceId]: row.seq };
          tx.set(ref, next);
          tx.set(receiptRef, { seq: row.seq, updatedAt: now });
          if (segmentRef && !segmentSnapshot.exists()) tx.set(segmentRef, row.operation.segment);
          return next;
        });
      }
    };
  }
  // Only prepare this after a user reviews the cloud and local values. A second
  // remote edit still conflicts because these expected slots are transactional.
  function reviewedPatch(base, original) {
    if (original.type !== 'patch') return null;
    const op = clone(original), t = op.target;
    const current = t.kind === 'settings' ? base.settings : t.kind === 'task'
      ? base.entries?.[t.date]?.find(task => task.id === t.id) : null;
    if (!current) return null;
    if (t.kind === 'task' && (current.rolledTo || base.tombstones?.[core.tombstoneKey(t)] ||
      Object.keys(op.changes).some(key=>['rolledTo','rolledFrom','rolledFromTaskId','lineageId'].includes(key)))) return null;
    const slot = key => Object.prototype.hasOwnProperty.call(current,key) ? {exists:true,value:clone(current[key])} : {exists:false};
    for (const key of Object.keys(op.changes)) op.changes[key].before = slot(key);
    if (t.kind === 'task') op.guard = Object.fromEntries(['done','archived','rolledTo'].map(key=>[key,slot(key)]));
    core.applyOperation(base,op); // Never offer an invalid overwrite.
    return op;
  }
  return { Outbox, Client, firebaseTransport, reviewedPatch };
});
