'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { indexedDB } = require('fake-indexeddb');
const core = require('../shared/sync-core.js');
const { Outbox, Client, firebaseTransport, reviewedPatch } = require('../sync-client.js');

async function box() { return Outbox.open(indexedDB, 'test-' + crypto.randomUUID()); }
const create = id => ({ type:'record', target:{kind:'task',date:'2026-09-07',id}, before:{exists:false},
  after:{exists:true,value:{id,content:id,done:false,subtasks:[],comments:[]}} });
const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));

test('stopping during initial storage read never opens an old-account subscription',async()=>{
  let release,subscriptions=0,renders=0;
  const client=new Client({uid:'old-user',profileId:'p',outbox:{read:()=>new Promise(resolve=>release=resolve)},transport:{subscribe(){subscriptions++;}},onData:()=>renders++});
  const starting=client.start();client.stop();release({});await starting;
  assert.equal(subscriptions,0);assert.equal(renders,0);
});

test('reviewed local fields keep unrelated remote changes and still detect newer edits',()=>{
  const original=core.normalizeProfile({entries:{'2026-09-07':[{id:'a',content:'old',notes:'keep'}]}});
  const edited=structuredClone(original);edited.entries['2026-09-07'][0].content='my edit';
  const op=core.diffProfile(original,edited)[0];
  const latest=structuredClone(original);Object.assign(latest.entries['2026-09-07'][0],{content:'remote edit',notes:'new note'});
  const reviewed=reviewedPatch(latest,op);const applied=core.applyOperation(latest,reviewed);
  assert.equal(applied.entries['2026-09-07'][0].content,'my edit');assert.equal(applied.entries['2026-09-07'][0].notes,'new note');
  latest.entries['2026-09-07'][0].content='even newer';assert.throws(()=>core.applyOperation(latest,reviewed),core.ConflictError);
  assert.equal(reviewedPatch(core.normalizeProfile({}),op),null);
});

test('outbox allocations are atomic across concurrent tabs and isolated across accounts', async () => {
  const store = await box();
  await Promise.all(Array.from({length:20},(_,i)=>store.enqueue('users/A/profiles/p',[create('a'+i)])));
  const rows=await store.pending('users/A/profiles/p');
  assert.equal(rows.length,20); assert.equal(new Set(rows.map(r=>r.seq)).size,20);
  assert.equal(new Set(rows.map(r=>r.deviceId)).size,1);
  await store.enqueue('users/B/profiles/p',[create('b')]);
  assert.equal((await store.pending('users/B/profiles/p'))[0].seq,1);
  assert.equal((await store.pending('users/A/profiles/p')).length,20); store.close();
});

test('intent journal replay does not allocate duplicate operations after reload', async () => {
  const store=await box();
  await store.enqueue('A',[create('one')],'journal-1');
  await store.enqueue('A',[create('one')],'journal-1');
  assert.equal((await store.pending('A')).length,1); store.close();
});

test('acknowledgement and baseline are one durable transaction, never regressing across tabs', async()=>{
  const store=await box(); const [row]=await store.enqueue('A',[create('one')]);
  await store.acceptBaseline('A',{revision:5,value:'new'});
  const saved=await store.acceptBaseline('A',{revision:3,value:'old'},row.key);
  assert.equal(saved.value,'new'); assert.equal((await store.pending('A')).length,0);
  assert.equal((await store.read('baseline:A')).revision,5);store.close();
});

test('equal-revision snapshots cannot regress acknowledged operation frontiers',async()=>{
  const store=await box();await store.acceptBaseline('A',{revision:5,acks:{device:9}});
  const kept=await store.acceptBaseline('A',{revision:5,acks:{device:8}});
  assert.equal(kept.acks.device,9);store.close();
});

test('stale conflict choices cannot resurrect or overwrite rows already reviewed in another tab',async()=>{
  const store=await box();const [row]=await store.enqueue('A',[create('one')]);
  const replacement={...row,operation:{type:'noop'}};
  assert.equal(await store.replace(replacement,row.operation),true);
  assert.equal(await store.replace(row,row.operation),false);
  await store.remove(row.key);assert.equal(await store.replace(replacement),false);
  assert.equal((await store.pending('A')).length,0);store.close();
});

test('reviewed local choice never edits carried sources or live records with tombstones',()=>{
  const base=core.normalizeProfile({entries:{'2026-09-07':[{id:'a',content:'old'}]}});
  const next=structuredClone(base);next.entries['2026-09-07'][0].content='new';const op=core.diffProfile(base,next)[0];
  base.entries['2026-09-07'][0].rolledTo='2026-09-08';assert.equal(reviewedPatch(base,op),null);
  delete base.entries['2026-09-07'][0].rolledTo;base.tombstones[core.tombstoneKey(op.target)]=true;
  assert.equal(reviewedPatch(base,op),null);
});

test('out-of-order listeners cannot restore an older server revision', async()=>{
  const store=await box();let receive;
  const client=new Client({uid:'A',profileId:'p',outbox:store,transport:{subscribe(p,cb){receive=cb;return()=>{};}}});
  await client.start(); receive({revision:7,entries:{'2026-09-07':[{id:'new'}]}});await client.serial;
  receive({revision:4,entries:{}});await client.serial;
  assert.equal(client.view.revision,7);assert.equal(client.view.entries['2026-09-07'][0].id,'new');client.stop();store.close();
});

test('future schemas are rejected without writes, including a duplicate segment path', async()=>{
  let writes=0;
  const transport=firebaseTransport({db:{},doc:(db,p)=>p,runTransaction:async(db,fn)=>fn({
    get:async p=>({exists:()=>true,data:()=>p.includes('/receipts/')?{seq:1}:{schemaVersion:4}}),set:()=>writes++
  })});
  await assert.rejects(transport.commit('users/A/profiles/p',{deviceId:'d',seq:1,operation:{type:'segment',segment:{id:'s'}}},false),/Update/);
  assert.equal(writes,0);
});

test('acknowledged segments are not applied again while receipt is being dequeued', async () => {
  const store=await box(); const path='users/A/profiles/p';
  const segment={id:'s1',sessionId:'s',profileId:'p',taskId:null,taskDate:null,date:'2026-09-07',kind:'stopwatch',startedAt:0,endedAt:10000,activeSeconds:10,completedPomodoro:false,reason:'pause'};
  const [row]=await store.enqueue(path,[{type:'segment',segment}]);
  let shown;
  const client=new Client({uid:'A',profileId:'p',outbox:store,transport:{},onData:d=>shown=d});
  client.base=core.applySegment(core.normalizeProfile({}),segment);
  client.base.acks={[row.deviceId]:row.seq};
  await client.publish();
  assert.equal(shown.focusLog['2026-09-07'],10); store.close();
});

test('offline edits remain queued then flush in order after reconnect', async () => {
  const store=await box(); let receive, online=false, data=core.normalizeProfile({});
  const transport={subscribe(p,cb){receive=cb;cb(data);return()=>{};},async commit(p,row){
    if(!online) throw Object.assign(new Error('offline'),{code:'unavailable'});
    data=core.applyOperation(data,row.operation); data.acks={...(data.acks||{}),[row.deviceId]:row.seq}; return data;
  }};
  const client=new Client({uid:'A',profileId:'p',outbox:store,transport});
  await client.start(); await client.serial;
  await client.enqueue([create('first'),create('second')]); await sleep(20);
  assert.equal((await store.pending(client.scope)).length,2);
  online=true; receive(data); await client.serial; await client.flush(); await sleep(20);
  assert.equal((await store.pending(client.scope)).length,0);
  assert.deepEqual(data.entries['2026-09-07'].map(t=>t.id).sort(),['first','second']);
  client.stop(); store.close();
});

test('a conflicting change does not disappear; Keep cloud acknowledges a no-op', async () => {
  const store=await box(); let receive; const applied=[];
  const transport={subscribe(p,cb){receive=cb;return()=>{};},async commit(p,row){
    if(row.operation.type!=='noop') throw new core.ConflictError('field','Changed elsewhere',{actual:'remote'});
    applied.push(row.operation.type);return core.normalizeProfile({});
  }};
  const client=new Client({uid:'A',profileId:'p',outbox:store,transport});
  await client.start(); receive({});await client.serial;
  await client.enqueue([create('conflict')]);await sleep(20);
  assert.ok(client.conflict);assert.equal((await store.pending(client.scope)).length,1);
  await client.keepServerVersion();assert.deepEqual(applied,['noop']);
  assert.equal((await store.pending(client.scope)).length,0);client.stop();store.close();
});

test('transaction receipts prevent duplicate segments after a lost response', async () => {
  const docs=new Map();let writes=0;
  const sdk={db:{},doc:(db,p)=>p,onSnapshot(){},runTransaction:async(db,fn)=>fn({
    get:async p=>({exists:()=>docs.has(p),data:()=>structuredClone(docs.get(p))}),
    set:(p,d)=>{writes++;docs.set(p,structuredClone(d));}
  })};
  const transport=firebaseTransport(sdk);const path='users/A/profiles/p';
  const segment={id:'s1',sessionId:'s',profileId:'p',taskId:null,taskDate:null,date:'2026-09-07',kind:'pomodoro',startedAt:0,endedAt:60000,activeSeconds:60,completedPomodoro:true,reason:'finish'};
  const row={deviceId:'device',seq:1,operation:{type:'segment',segment}};
  await transport.commit(path,row,false);const once=writes;
  await transport.commit(path,row,false);assert.equal(writes,once);
  assert.equal(docs.get(path).pomLog['2026-09-07'],1);assert.equal(docs.get(path).focusLog['2026-09-07'],60);
  await assert.rejects(transport.commit(path,{...row,seq:3},false),/missing/);
});
