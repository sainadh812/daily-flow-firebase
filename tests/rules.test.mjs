import { readFile } from 'node:fs/promises';
import { before, after, beforeEach, test } from 'node:test';
import { initializeTestEnvironment, assertSucceeds, assertFails } from '@firebase/rules-unit-testing';
import { doc, setDoc, getDoc, getDocs, collection, deleteDoc, writeBatch, runTransaction, onSnapshot } from 'firebase/firestore';
import sync from '../sync-client.js';
import core from '../shared/sync-core.js';

const enabled = !!process.env.FIRESTORE_EMULATOR_HOST;
let env, alice, bob, anon;
before(async () => {
  if (!enabled) return;
  env = await initializeTestEnvironment({ projectId:'demo-dailyflow', firestore:{ rules:await readFile(new URL('../firestore.rules',import.meta.url),'utf8') } });
  alice=env.authenticatedContext('alice').firestore(); bob=env.authenticatedContext('bob').firestore(); anon=env.unauthenticatedContext().firestore();
});
beforeEach(async () => { if (env) await env.clearFirestore(); });
after(async () => { if (env) await env.cleanup(); });
const check=(name,fn)=>test(name,{skip:!enabled},fn);
const path='users/alice/profiles/p';
function parent(seq=1, changes={}) { return { ...core.normalizeProfile({}), revision:seq, updatedAt:Date.now(),
  acks:{device:seq},lastMutation:{deviceId:'device',seq,segmentId:null},...changes }; }
async function write(data,db=alice,p=path) {
  const batch=writeBatch(db); batch.set(doc(db,p),data);
  batch.set(doc(db,p+'/receipts/device'),{seq:data.lastMutation.seq,updatedAt:data.updatedAt}); return batch.commit();
}
async function seed(p,data) { await env.withSecurityRulesDisabled(async c=>setDoc(doc(c.firestore(),p),data)); }
const segment=(changes={})=>({id:'session_0',sessionId:'session',profileId:'p',taskId:null,taskDate:null,date:'2026-09-07',kind:'stopwatch',
  startedAt:0,endedAt:10000,activeSeconds:10,completedPomodoro:false,reason:'pause',...changes});

check('valid owner transactions and immutable time records work through the real adapter',async()=>{
  const transport=sync.firebaseTransport({db:alice,doc,runTransaction,onSnapshot});
  const op={type:'record',target:{kind:'task',date:'2026-09-07',id:'a'},before:{exists:false},after:{exists:true,value:{id:'a',content:'Test'}}};
  await assertSucceeds(transport.commit(path,{deviceId:'device',seq:1,operation:op},false));
  await assertSucceeds(transport.commit(path,{deviceId:'device',seq:2,operation:{type:'segment',segment:segment()}},false));
  await assertSucceeds(transport.commit(path,{deviceId:'device',seq:2,operation:{type:'segment',segment:segment()}},false));
  await assertSucceeds(getDocs(collection(alice,path+'/sessions')));
  await assertFails(setDoc(doc(alice,path+'/sessions/session_0'),segment({activeSeconds:9})));
  await assertFails(deleteDoc(doc(alice,path+'/sessions/session_0')));
});
check('unsigned and other-user get/list/create/update/delete are denied',async()=>{
  await write(parent());
  for (const db of [bob,anon]) {
    await assertFails(getDoc(doc(db,path))); await assertFails(getDocs(collection(db,'users/alice/profiles')));
    await assertFails(write(parent(2),db)); await assertFails(deleteDoc(doc(db,path)));
    await assertFails(getDocs(collection(db,path+'/sessions')));
    await assertFails(getDoc(doc(db,path+'/receipts/device')));
  }
});
check('parent/receipt cannot be written independently or replayed',async()=>{
  await assertFails(setDoc(doc(alice,path),parent()));
  await assertFails(setDoc(doc(alice,path+'/receipts/device'),{seq:1,updatedAt:Date.now()}));
  await write(parent()); await assertFails(write(parent()));
  await assertFails(write(parent(3))); await assertFails(deleteDoc(doc(alice,path+'/receipts/device')));
});
check('required fields and top-level types validate on create and update',async()=>{
  for (const make of [d=>{delete d.schemaVersion;return d;},d=>({...d,entries:'bad'}),d=>({...d,quickNotes:{}}),d=>({...d,settings:[]}),
    d=>({...d,revision:-1}),d=>({...d,schemaVersion:2}),d=>({...d,ownerId:'bob'}),d=>({...d,evil:'x'}),d=>({...d,lastDate:4}),d=>({...d,updatedAt:Date.now()+3600000})]) {
    await assertFails(write(make(parent())));
  }
  await write(parent());
  for (const changes of [{entries:null},{schemaVersion:1},{acks:{device:2,other:100}},{quickNotes:Array(1001).fill({id:'x'})},{isAdmin:true}])
    await assertFails(write(parent(2,changes)));
});
check('legacy upgrade retains unknown data but cannot change it; future schemas cannot be downgraded',async()=>{
  await seed(path,{entries:{},legacyExtra:'keep'});
  await assertSucceeds(write(parent(1,{legacyExtra:'keep'})));
  await assertFails(write(parent(2,{legacyExtra:'change'})));
  await env.clearFirestore(); await seed(path,{...parent(),schemaVersion:4});
  await assertFails(write(parent(2)));
});
check('metadata uses the same owner and checkpoint protections; unused paths denied',async()=>{
  const meta={...parent(),profiles:[]}; ['entries','pomLog','focusLog','settings','achievements','quickNotes','customCats'].forEach(k=>delete meta[k]);
  await assertSucceeds(write(meta,alice,'users/alice/meta/root'));
  await assertFails(write({...meta,revision:2,lastMutation:{deviceId:'device',seq:2,segmentId:null},activeProfileId:'p'},alice,'users/alice/meta/root'));
  await assertFails(setDoc(doc(alice,'users/alice'),{role:'admin'}));
  await assertFails(setDoc(doc(alice,'users/alice/meta/other'),meta));
});
check('orphan, forged, wrong-profile, negative, oversized and invalid-kind segments denied',async()=>{
  await assertFails(setDoc(doc(alice,path+'/sessions/session_0'),segment()));
  for (const bad of [{profileId:'other'},{activeSeconds:-1},{activeSeconds:200},{activeSeconds:1000000},
    {completedPomodoro:true},{taskId:'t',taskDate:null},{reason:'x'.repeat(81)},{id:'other'}, {extra:1}]) {
    const batch=writeBatch(alice), data=parent(1,{lastMutation:{deviceId:'device',seq:1,segmentId:'session_0'}});
    batch.set(doc(alice,path),data);batch.set(doc(alice,path+'/receipts/device'),{seq:1,updatedAt:data.updatedAt});
    batch.set(doc(alice,path+'/sessions/session_0'),segment(bad)); await assertFails(batch.commit());
  }
  await write(parent()); await assertFails(setDoc(doc(alice,path+'/sessions/session_0'),segment()));
});
