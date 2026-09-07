const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../app.js'),'utf8');
const keys=source.slice(source.indexOf('function accountKey('),source.indexOf('function _fsDocPath('));
const migration=source.slice(source.indexOf('function migrateToProfiles('),source.indexOf('function load()'));
function run(user,localMode){
  const records=new Map([
    ['df2_profiles',JSON.stringify([{id:'legacy',name:'Legacy'}])],
    ['df2_plegacy_entries',JSON.stringify({'2026-09-07':[{id:'legacy-task',content:'Recover only locally'}]})]
  ]);
  const context={_currentUser:user,window:{_df_localMode:localMode},state:{},
    localStorage:{getItem:key=>records.get(key)||null,setItem:(key,value)=>records.set(key,value)},
    loadProfileData(pid){this.loaded=pid;}};
  vm.createContext(context);vm.runInContext(keys+migration+'\nmigrateToProfiles();',context);
  return {context,records};
}
test('legacy df2 records migrate only into the injectively scoped local preview',()=>{
  const {context,records}=run(null,true);
  assert.equal(context.state.activeProfileId,'legacy');
  assert.equal(context.state.profiles[0].name,'Legacy');
  const target=vm.runInContext("profileKey('legacy','entries')",context);
  assert.equal(records.get(target),records.get('df2_plegacy_entries'));
  assert.ok(records.has('df2_plegacy_entries'));
});
test('legacy unscoped browser data never migrates into an authenticated UID',()=>{
  const {context,records}=run({uid:'local'},true);
  assert.equal(context.state.activeProfileId,'p_default');
  assert.equal(records.has(vm.runInContext("profileKey('legacy','entries')",context)),false);
});
