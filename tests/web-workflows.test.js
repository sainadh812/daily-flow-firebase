'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const W = require('../web-workflows.js');
const source = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');

function harness() {
  let now = new Date('2026-09-07T12:00:00').getTime();
  const nodes = new Map();
  const document = {hidden:false, addEventListener() {}, querySelectorAll() {return [];}};
  function node(id) {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {id, value:'', textContent:'', innerHTML:'', checked:false, dataset:{},
        style:{setProperty(k,v){this[k]=v;}},
        classList:{add(...v){v.forEach(x=>classes.add(x));},remove(...v){v.forEach(x=>classes.delete(x));},
          contains(v){return classes.has(v);},toggle(v,force){const on=force??!classes.has(v);on?classes.add(v):classes.delete(v);return on;}},
        focus(){document.activeElement=this;}, select(){}, querySelectorAll(){return [];}, querySelector(s){return node(id+s);},
        contains(el){return el?.id?.startsWith('log:');}, addEventListener(){}, setAttribute(){},
      });
    }
    return nodes.get(id);
  }
  document.getElementById = node;
  document.querySelector = node;
  document.documentElement = node('root');
  class ClockDate extends Date { constructor(...args) {super(...(args.length ? args : [now]));} static now(){return now;} }
  const ctx = {console, document, Date:ClockDate, DailyFlowWorkflows:W, navigator:{},
    localStorage:{getItem(){return null;},setItem(){}}, setInterval(){return 1;},clearInterval(){},
    setTimeout(){return 1;},clearTimeout(){},requestAnimationFrame(){return 1;},cancelAnimationFrame(){},
  };
  ctx.window=ctx;
  vm.createContext(ctx);
  vm.runInContext(source.slice(source.indexOf('const CIRCUMFERENCE')),ctx);
  vm.runInContext('globalThis.s=state',ctx);
  for(const name of ['save','saveTimerState','beep','sendDesktopNotif','showToast','renderTimerAll','renderPlayBtn','renderTimeDisplay','renderRing','renderDots','renderCalendar','renderStats','renderLog','updateNavWave','updateSessionBanner','applyFocusMode','checkAchievements','applyAccentColor','applyRingStyle','updateClocks','renderGhostBanner','renderGhostDrawer']) ctx[name]=()=>{};
  const segments=[];
  const seen=new Set();
  ctx.recordTimeSegment=segment=>{
    if(seen.has(segment.id))return;
    seen.add(segment.id);segments.push(segment);
    ctx.s.focusLog[segment.date]=(ctx.s.focusLog[segment.date]||0)+segment.activeSeconds;
    if(segment.completedPomodoro)ctx.s.pomLog[segment.date]=(ctx.s.pomLog[segment.date]||0)+1;
    const entry=W.locate(ctx.s.notes.entries,segment.taskId)?.entry;
    if(entry){entry.focusSeconds=(entry.focusSeconds||0)+segment.activeSeconds;if(segment.completedPomodoro)entry.pomodoros=(entry.pomodoros||0)+1;}
  };
  ctx.s.focusLog={};ctx.s.activeProfileId='test';
  return {ctx,node,segments,advance(ms){now+=ms;},run(code){return vm.runInContext(code,ctx);}};
}

test('all-date unfinished groups exclude completed, archived, dismissed and rolled sources',()=>{
  const entries={'2026-09-01':[{id:'old'},{id:'rolled',rolledTo:'2026-09-07'},{id:'done',done:true},{id:'hidden',archived:true},{id:'legacy'}],
    '2026-09-07':[{id:'today'}],'2026-09-09':[{id:'future'}]};
  assert.deepEqual(W.unfinished(entries,'2026-09-07',false,['legacy']).map(x=>[x.entry.id,x.group]),[['old','Earlier'],['today','Today'],['future','Upcoming']]);
  assert.deepEqual(W.unfinished(entries,'2026-09-07',true,['legacy']).map(x=>x.entry.id),['hidden','legacy']);
});

test('auto-carry scans every past date, preserves completed subtasks/history, and is idempotent across devices',()=>{
  const original={'2026-08-01':[{id:'a',autoRollover:true,subtasks:[{id:'s1',done:true},{id:'s2',done:false}],comments:[{id:'c1',text:'progress'}],focusSeconds:22}],
    '2026-09-06':[{id:'b',autoRollover:true},{id:'c',autoRollover:false},{id:'d',autoRollover:true,done:true}],
    '2026-09-09':[{id:'future',autoRollover:true}]};
  const left=structuredClone(original),right=structuredClone(original);
  const rolls=W.autoCarry(left,'2026-09-07',1000),other=W.autoCarry(right,'2026-09-07',2000);
  assert.equal(rolls.length,2);
  assert.deepEqual(rolls.map(x=>x.newEntry.id),other.map(x=>x.newEntry.id));
  assert.deepEqual(rolls[0].newEntry.subtasks,[{id:'s1',done:true},{id:'s2',done:false}]);
  assert.equal(rolls[0].newEntry.comments[1].text,'progress');
  assert.equal(rolls[0].origEntry.focusSeconds,22);
  assert.equal(rolls[0].newEntry.focusSeconds,0);
  assert.equal(W.autoCarry(left,'2026-09-07',3000).length,0);
  assert.equal(left['2026-09-07'].length,2);
});

test('carry refuses invalid/backward dates and preserves source history without sharing mutable subtasks',()=>{
  const entries={'2026-09-01':[{id:'a',subtasks:[{id:'s',done:true}]}]};
  assert.equal(W.carry(entries,'2026-09-01','a','2026-02-31',0),null);
  assert.equal(W.carry(entries,'2026-09-01','a','2026-08-31',0),null);
  const {newEntry}=W.carry(entries,'2026-09-01','a','2026-09-07',0);
  newEntry.subtasks[0].done=false;
  assert.equal(entries['2026-09-01'][0].subtasks[0].done,true);
});

test('date picker selection survives synchronization and add writes details/subtasks to selected future date',()=>{
  const h=harness();h.ctx.s.ui.entryDateExplicit=true;
  h.node('entryDate').value='2026-09-15';h.ctx.syncEntryDatePicker();
  assert.equal(h.node('entryDate').value,'2026-09-15');
  h.node('entryInput').value='Future #work';h.node('descInput').value='Useful details';h.node('catSel').value='work';h.node('priSel').value='high';
  h.run("_newSubtasks=['one','  ','two']");h.ctx.addEntry();
  const task=h.ctx.s.notes.entries['2026-09-15'][0];
  assert.equal(task.notes,'Useful details');assert.equal(task.subtasks.length,2);
  assert.equal(h.node('entryInput').value,'');assert.equal(h.ctx.document.activeElement.id,'entryInput');
});

test('archive restores both new archives and legacy dismissed tasks without deleting them',()=>{
  const h=harness();h.ctx.s.notes.entries={'2026-09-01':[{id:'a'},{id:'legacy'}]};
  h.ctx.s.settings.ghostDismissed=['legacy'];
  h.ctx.archiveEntry('a');assert.equal(h.ctx.findEntry('a').archived,true);
  h.ctx.archiveEntry('a');assert.equal(h.ctx.findEntry('a').archived,false);
  h.ctx.archiveEntry('legacy');assert.equal(h.ctx.findEntry('legacy').archived,false);
  assert.equal(h.ctx.s.settings.ghostDismissed.length,0);
});

test('pause/resume saves actual seconds and excludes time spent paused',()=>{
  const h=harness();h.ctx.startTimer();h.advance(43000);h.ctx.stopTimer();
  assert.equal(h.segments[0].activeSeconds,43);assert.equal(h.ctx.s.timer.timeLeft,1457);
  h.advance(120000);h.ctx.startTimer();h.advance(17000);h.ctx.stopTimer();
  assert.equal(h.segments[1].activeSeconds,17);assert.equal(h.ctx.s.focusLog['2026-09-07'],60);
  assert.equal(h.segments[0].sessionId,h.segments[1].sessionId);
  assert.notEqual(h.segments[0].id,h.segments[1].id);
});

test('Skip before Start and repeated Skip award no completion and leave next phase stopped',()=>{
  const h=harness();h.ctx.s.settings.autoStartBreaks=true;h.ctx.s.settings.autoStartWork=true;
  h.ctx.skipTimer();h.ctx.skipTimer();assert.equal(h.segments.length,0);assert.equal(h.ctx.s.timer.running,false);
  h.ctx.startTimer();h.advance(11000);h.ctx.skipTimer();
  assert.equal(h.segments[0].activeSeconds,11);assert.equal(h.segments[0].completedPomodoro,false);assert.equal(h.ctx.s.timer.running,false);
});

test('countdown uses deadline under throttling, caps overtime, and completes exactly once',()=>{
  const h=harness();h.ctx.startTimer();h.advance(1600000);h.ctx.tick();h.ctx.tick();h.ctx.timerDone();
  assert.equal(h.segments.length,1);assert.equal(h.segments[0].activeSeconds,1500);assert.equal(h.segments[0].completedPomodoro,true);
  assert.equal(h.ctx.s.pomLog['2026-09-07'],1);assert.equal(h.ctx.s.timer.mode,'shortBreak');
});

test('linked task survives viewed-date navigation and stopwatch completion does not create Pomodoros',()=>{
  const h=harness();h.ctx.s.notes.entries={'2026-09-01':[{id:'a'}],'2026-09-07':[{id:'b'}]};
  h.ctx.trackEntry('a');h.ctx.setMode('stopwatch');h.ctx.startTimer();h.ctx.s.notes.date='2026-09-09';
  h.advance(78000);h.ctx.finishTimer();
  assert.equal(h.segments[0].taskId,'a');assert.equal(h.segments[0].taskDate,'2026-09-01');assert.equal(h.segments[0].kind,'stopwatch');
  assert.equal(h.ctx.findEntry('a').focusSeconds,78);assert.equal(Object.keys(h.ctx.s.pomLog).length,0);
});

test('refresh keeps session identity and exact remaining time, then resolves an expired deadline',()=>{
  const h=harness();h.ctx.startTimer();h.advance(70000);const snapshot=JSON.parse(JSON.stringify(h.ctx.getTimerSnapshot()));
  h.advance(30000);h.ctx.restoreTimerSnapshot(snapshot);h.ctx.startTimer();
  assert.equal(h.ctx.s.timer.timeLeft,1400);assert.equal(h.ctx.s.timer.sessionId,snapshot.sessionId);
  h.advance(1500000);h.ctx.tick();assert.equal(h.segments.length,1);assert.equal(h.segments[0].activeSeconds,1500);
});

test('changing settings preserves a paused countdown',()=>{
  const h=harness();h.ctx.startTimer();h.advance(60000);h.ctx.stopTimer();
  h.node('s-work').value='45';h.ctx.applySettings();
  assert.equal(h.ctx.s.timer.timeLeft,1440);assert.equal(h.ctx.s.timer.remainingMs,1440000);
  h.ctx.startTimer();h.advance(1440000);h.ctx.tick();
  assert.equal(h.ctx.s.focusLog['2026-09-07'],1500);
});

test('midnight splits recorded work into actual local dates',()=>{
  const start=new Date('2026-09-07T23:59:30').getTime();
  const parts=W.splitSegment(start,start+90000);
  assert.deepEqual(parts.map(x=>[x.date,x.activeSeconds]),[['2026-09-07',30],['2026-09-08',60]]);
});

test('legacy paused timers also retain remaining time after changing settings',()=>{
  const h=harness();h.ctx.restoreTimerSnapshot({mode:'work',timeLeft:600,running:false});
  h.run('delete state.timer._restored');h.node('s-work').value='45';h.ctx.applySettings();
  assert.equal(h.ctx.s.timer.timeLeft,600);h.ctx.startTimer();h.advance(600000);h.ctx.tick();
  assert.equal(h.ctx.s.focusLog['2026-09-07'],600);
});

test('a stopped snapshot retains pending segments before credit and replays exactly once',()=>{
  const h=harness(),snapshots=[];
  h.ctx.saveTimerState=()=>snapshots.push(JSON.parse(JSON.stringify(h.ctx.getTimerSnapshot())));
  const record=h.ctx.recordTimeSegment;
  h.ctx.startTimer();h.advance(43000);
  h.ctx.recordTimeSegment=()=>{throw new Error('simulated interrupted credit');};
  h.ctx.console={...console,error(){}};
  h.ctx.stopTimer();
  const stopped=snapshots.at(-1);
  assert.equal(stopped.running,false);assert.equal(stopped.segmentStartedAt,null);assert.equal(stopped.pendingSegments.length,1);
  h.ctx.recordTimeSegment=record;h.ctx.restoreTimerSnapshot(stopped);
  assert.equal(h.segments.length,1);assert.equal(h.ctx.s.focusLog['2026-09-07'],43);
  h.ctx.restoreTimerSnapshot(stopped);assert.equal(h.ctx.s.focusLog['2026-09-07'],43);
});
