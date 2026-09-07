const test=require('node:test');
const assert=require('node:assert/strict');
const W=require('../web-workflows.js');
const Core=require('../shared/sync-core.js');

function fixture(){return {format:'dailyflow-backup',version:3,exportedAt:'2026-09-07T12:00:00Z',profile:{id:'source-profile',name:'Work'},data:{
  entries:{'2026-09-01':[{id:'task1',content:'=Example, "quoted"\nSecond line',notes:'Details',archived:true,done:false,pomodoros:2,focusSeconds:310,
    subtasks:[{id:'st1',text:'Completed child',done:true}],comments:[{id:'c1',text:'History',system:true}]}]},
  pomLog:{'2026-09-01':2},focusLog:{'2026-09-01':310},settings:{dark:true,workDuration:40},
  achievements:{unlocked:['first_entry']},quickNotes:[{id:'note1',text:'Remember'}],customCats:[{id:'custom1',label:'Project',color:'#123456',emoji:'★'}]
}};}

test('JSON, CSV, Markdown and workbook rows preserve the full profile exactly',()=>{
  const backup=W.validateBackup(fixture(),Core);
  const formats=[W.parseBackupText(JSON.stringify(backup),'json',Core),W.parseBackupText(W.backupCsv(backup),'csv',Core),
    W.parseBackupText(W.backupMarkdown(backup),'md',Core),W.validateBackup(W.backupFromRows(W.backupRows(backup)),Core)];
  for(const parsed of formats)assert.deepEqual(parsed.data,backup.data);
  assert.match(W.backupCsv(backup),/"'=Example/);
});

test('large backups use lossless workbook-compatible chunks',()=>{
  const source=fixture();source.data.entries['2026-09-01'][0].notes='Large detailed note '.repeat(6000);
  const rows=W.backupRows(source);assert.ok(rows.filter(row=>row[0]==='backup-json').length>1);
  assert.deepEqual(W.backupFromRows(rows),source);
  assert.ok(rows.filter(row=>row[0]==='backup-json').every(row=>JSON.parse(row[5]).length<=16000));
});

test('backup chunks preserve surrogate pairs through independent UTF-8 cell encoding',()=>{
  const source=fixture(),task=source.data.entries['2026-09-01'][0];
  task.notes='BOUNDARY';
  const prefixLength=JSON.stringify(source).indexOf('BOUNDARY');
  task.notes='x'.repeat(15999-prefixLength)+'😀'+'y'.repeat(15997)+'🚀'+'z'.repeat(17000);
  const rows=W.backupRows(source),parts=rows.filter(row=>row[0]==='backup-json');
  assert.ok(parts.length>3);
  parts.forEach((row,index)=>{
    assert.equal(row[2],String(index));
    const decoded=JSON.parse(row[5]);
    assert.ok(decoded.length<=16000);
    assert.doesNotMatch(decoded,/[\uD800-\uDBFF]$/);
    assert.doesNotMatch(decoded,/^[\uDC00-\uDFFF]/);
  });
  const encodedRows=rows.map(row=>row.map(cell=>Buffer.from(cell,'utf8').toString('utf8')));
  assert.deepEqual(W.backupFromRows(encodedRows),source);
  assert.deepEqual(W.parseBackupText(Buffer.from(W.backupCsv(source),'utf8').toString('utf8'),'csv',Core).data,W.validateBackup(source,Core).data);
});

test('formula-like chunk prefixes round-trip without apostrophe corruption; legacy rows still import',()=>{
  for(const character of ['-','+','=','@']) {
    const source=fixture(),task=source.data.entries['2026-09-01'][0];task.notes='BOUNDARY';
    const prefix=JSON.stringify(source).indexOf('BOUNDARY');
    task.notes='x'.repeat(16000-prefix)+character+' tail';
    assert.equal(JSON.stringify(source)[16000],character);
    assert.deepEqual(W.parseBackupText(W.backupCsv(source),'csv',Core).data,W.validateBackup(source,Core).data);
    const legacy=W.backupRows(source).map(row=>row[0]==='backup-json'?[row[0],row[1],row[2],'',row[4],JSON.parse(row[5])]:row);
    assert.deepEqual(W.backupFromRows(legacy),source);
  }
});

test('preview is non-mutating and merge preserves existing tasks and nested progress',()=>{
  const before=Core.normalizeProfile({entries:{'2026-09-01':[{id:'existing',content:'Keep me'},
    {id:'task1',content:'Current text',subtasks:[{id:'local-child',text:'Local child',done:false}],comments:[{id:'local-comment',text:'Local progress'}]}]}});
  const untouched=structuredClone(before);
  const plan=W.prepareBackupImport(before,fixture(),Core);
  assert.deepEqual(before,untouched);assert.equal(plan.data.entries['2026-09-01'].length,2);
  const task=plan.data.entries['2026-09-01'].find(t=>t.id==='task1');
  assert.equal(task.content,'Current text');assert.equal(task.subtasks.length,2);assert.equal(task.comments.length,2);
  assert.equal(plan.data.quickNotes.length,1);assert.equal(plan.data.customCats.length,1);
  assert.deepEqual(plan.data.achievements.unlocked,['first_entry']);
});

test('explicit metrics restore task and daily totals without double addition on repeated import',()=>{
  const first=W.prepareBackupImport({},fixture(),Core,{preferBackup:true});
  assert.ok(first.operations.some(op=>op.type==='import-metrics'));
  const task=first.data.entries['2026-09-01'][0];assert.equal(task.pomodoros,2);assert.equal(task.focusSeconds,310);
  assert.equal(first.data.pomLog['2026-09-01'],2);assert.equal(first.data.focusLog['2026-09-01'],310);
  const second=W.prepareBackupImport(first.data,fixture(),Core,{preferBackup:true});
  assert.deepEqual(second.data,first.data);assert.equal(second.operations.length,0);
});

test('metrics can be excluded and conflicts resolve with the chosen preference',()=>{
  const backup=fixture(),current=structuredClone(backup.data);
  current.entries['2026-09-01'][0].content='Current';current.entries['2026-09-01'][0].focusSeconds=900;
  current.focusLog['2026-09-01']=900;
  const keep=W.prepareBackupImport(current,backup,Core,{includeMetrics:false,preferBackup:true});
  assert.equal(keep.data.entries['2026-09-01'][0].focusSeconds,900);assert.equal(keep.data.focusLog['2026-09-01'],900);
  assert.equal(keep.operations.some(op=>op.type==='import-metrics'),false);
  const use=W.prepareBackupImport(current,backup,Core,{includeMetrics:true,preferBackup:true});
  assert.equal(use.data.entries['2026-09-01'][0].focusSeconds,310);assert.equal(use.data.focusLog['2026-09-01'],310);
});

test('invalid dates, unsafe IDs, future schemas and negative metrics are rejected',()=>{
  const invalidDate=fixture();invalidDate.data.entries['2026-02-31']=invalidDate.data.entries['2026-09-01'];assert.throws(()=>W.validateBackup(invalidDate,Core),/date/);
  const id=fixture();id.data.entries['2026-09-01'][0].id="x');alert(1)";assert.throws(()=>W.validateBackup(id,Core),/IDs/);
  const future=fixture();future.version=4;assert.throws(()=>W.validateBackup(future,Core),/newer/);
  const metrics=fixture();metrics.data.focusLog['2026-09-01']=-1;assert.throws(()=>W.validateBackup(metrics,Core),/metrics/);
});
