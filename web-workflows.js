(function(root, factory) {
  const shared = typeof module === 'object' && module.exports ? require('./shared/sync-core.js') : root.DailyFlowSyncCore;
  const api = factory(shared);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DailyFlowWorkflows = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(shared) {
  'use strict';
  function dateKey(value) {
    const date = new Date(value);
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
  }
  function validDate(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') && dateKey(value + 'T12:00:00') === value;
  }
  function locate(entries, id) {
    for (const [date, tasks] of Object.entries(entries)) {
      const entry = tasks.find(task => task.id === id);
      if (entry) return { date, entry };
    }
    return null;
  }
  function unfinished(entries, today, archived = false, dismissed = []) {
    const hidden = new Set(dismissed);
    return Object.keys(entries).sort().flatMap(date => entries[date]
      .filter(task => (archived || !task.done) && !task.rolledTo && (!!task.archived || hidden.has(task.id)) === archived)
      .map(entry => ({ entry, date, group: date < today ? 'Earlier' : date === today ? 'Today' : 'Upcoming' })));
  }
  function carry(entries, sourceDate, taskId, targetDate, now, note) {
    const source = (entries[sourceDate] || []).find(task => task.id === taskId);
    if (!source || source.done || source.archived || source.rolledTo || !validDate(targetDate) || targetDate <= sourceDate) return null;
    // Same source instance and destination produce the same identity on every device.
    const id = shared.carryId(sourceDate, taskId, targetDate);
    const destination = entries[targetDate] || (entries[targetDate] = []);
    let next = destination.find(task => task.id === id);
    if (!next) {
      next = {
        ...source, id, ts: now, time: new Date(now).toLocaleTimeString('en-US', {hour:'2-digit', minute:'2-digit', hour12:true}),
        done: false, archived: false, pomodoros: 0, focusSeconds: 0, timeSpent: null,
        tags: [...(source.tags || [])], subtasks: (source.subtasks || []).map(task => ({ ...task })),
        rolledFrom: sourceDate, rolledFromId: taskId, rolledTo: null,
        comments: [{id: `${id}_history`, text: note || `↩ Carried from ${sourceDate}`, ts: now,
          time: new Date(now).toLocaleTimeString('en-US', {hour:'2-digit',minute:'2-digit',hour12:true}), system: true},
          ...(source.comments || []).map(comment => ({ ...comment }))],
      };
      destination.unshift(next);
    }
    source.rolledTo = targetDate;
    source.rolledToId = id;
    return { newEntry: next, sourceDate, origEntry: source };
  }
  function autoCarry(entries, today, now, dismissed = []) {
    return unfinished(entries, today, false, dismissed)
      .filter(({entry, date}) => date < today && entry.autoRollover)
      .map(({entry, date}) => carry(entries, date, entry.id, today, now, `↩ Auto-carried from ${date}`))
      .filter(Boolean);
  }
  function clock(timer, now) {
    if (!timer.running && !timer.resumePending) return { remainingMs: timer.remainingMs, elapsedMs: timer.elapsedMs || 0 };
    const end = timer.mode === 'stopwatch' ? now : Math.min(now, timer.deadlineAt);
    return {
      remainingMs: timer.mode === 'stopwatch' ? 0 : Math.max(0, timer.deadlineAt - now),
      elapsedMs: Math.max(0, (timer.elapsedMs || 0) + end - timer.segmentStartedAt),
    };
  }
  function splitSegment(start, end) {
    const parts = [];
    let cursor = start;
    while (cursor < end) {
      const midnight = new Date(cursor);
      midnight.setHours(24, 0, 0, 0);
      const boundary = Math.min(end, midnight.getTime());
      parts.push({ date: dateKey(cursor), startedAt: cursor, endedAt: boundary,
        activeSeconds: Math.floor((boundary - cursor) / 1000) });
      cursor = boundary;
    }
    return parts;
  }
  function validateBackup(input, core) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Backup must contain an object.');
    if (Number(input.version || input.schemaVersion || 1) > 3) throw new Error('This backup needs a newer DailyFlow version.');
    const raw = input.format === 'dailyflow-backup' ? input.data : input;
    if (!raw || !raw.entries || typeof raw.entries !== 'object' || Array.isArray(raw.entries)) throw new Error('No task data found in this backup.');
    function safeTree(value) {
      if (!value || typeof value !== 'object') return;
      Object.entries(value).forEach(([key, item]) => {
        if (['__proto__','prototype','constructor'].includes(key)) throw new Error('Backup contains an unsafe field.');
        safeTree(item);
      });
    }
    safeTree(raw);
    const data = core.normalizeProfile(raw);
    const idOkay = value => typeof value === 'string' && /^[A-Za-z0-9_.:%-]+$/.test(value);
    Object.entries(data.entries).forEach(([date, tasks]) => {
      if (!validDate(date)) throw new Error('Backup contains an invalid task date.');
      tasks.forEach(task => {
        if (!idOkay(task.id) || typeof task.content !== 'string') throw new Error('Task IDs and titles must be valid.');
        for (const key of ['notes','cat','priority','time','timeSpent']) if (task[key] != null && typeof task[key] !== 'string') throw new Error('Invalid task '+key+'.');
        if(task.time!=null && /[<>]/.test(task.time))throw new Error('Invalid task time.');
        if(task.priority!=null && !['none','low','medium','high'].includes(task.priority))throw new Error('Invalid task priority.');
        if(task.tags != null && (!Array.isArray(task.tags) || task.tags.some(tag=>typeof tag!=='string'||!/^\w+$/.test(tag))))throw new Error('Task tags must contain letters, numbers or underscores.');
        for(const key of ['done','archived','autoRollover'])if(task[key]!=null && typeof task[key]!=='boolean')throw new Error('Invalid task status.');
        for(const key of ['rolledFrom','rolledTo'])if(task[key]!=null && !validDate(task[key]))throw new Error('Invalid carry date.');
        for (const key of ['pomodoros','focusSeconds']) if (task[key] != null && (!Number.isFinite(task[key]) || task[key] < 0)) throw new Error('Invalid task metrics.');
        for (const key of ['subtasks','comments']) (task[key] || []).forEach(item => {
          if (!idOkay(item.id) || typeof item.text !== 'string') throw new Error('Invalid '+key+' record.');
          if(item.time!=null && (typeof item.time!=='string'||/[<>]/.test(item.time)))throw new Error('Invalid comment time.');
          if(item.done!=null && typeof item.done!=='boolean')throw new Error('Invalid subtask status.');
        });
      });
    });
    for (const map of [data.pomLog,data.focusLog]) Object.entries(map).forEach(([date,value]) => {
      if (!validDate(date) || !Number.isFinite(value) || value < 0) throw new Error('Invalid daily metrics.');
    });
    for (const list of [data.quickNotes,data.customCats]) list.forEach(item => {
      if (!idOkay(item.id)) throw new Error('Invalid note or category ID.');
    });
    data.quickNotes.forEach(note=>{
      if(typeof note.text!=='string')throw new Error('Quick notes must contain text.');
      if(note.time!=null && (typeof note.time!=='string'||/[<>]/.test(note.time)))throw new Error('Invalid quick-note time.');
    });
    data.customCats.forEach(cat=>{
      if(typeof cat.label!=='string'||typeof cat.emoji!=='string'||/[<>]/.test(cat.label+cat.emoji)||!/^#[0-9a-f]{6}$/i.test(cat.color || ''))throw new Error('Categories need a plain-text label, icon and valid color.');
    });
    for(const key of ['workDuration','shortBreakDuration','longBreakDuration','longBreakInterval']) {
      if(data.settings[key]!=null && (!Number.isFinite(data.settings[key]) || data.settings[key]<1 || data.settings[key]>120))throw new Error('Invalid timer settings.');
    }
    return {format:'dailyflow-backup',version:3,profile:input.profile || null,exportedAt:input.exportedAt || input.exported || null,data};
  }
  function backupRows(backup) {
    const rows=[['Kind','Date','ID','Title','Details','Data']];
    Object.entries(backup.data.entries).sort().forEach(([date,tasks]) => tasks.forEach(task=>rows.push(['task',date,task.id,task.content,task.notes || '',JSON.stringify(task)])));
    const json=JSON.stringify(backup);
    for(let offset=0,part=0;offset<json.length;part++) {
      let end=Math.min(offset+16000,json.length);
      // Spreadsheet cells are encoded separately: do not split a UTF-16 pair.
      if(end<json.length && /[\uD800-\uDBFF]/.test(json[end-1]))end--;
      rows.push(['backup-json','',String(part),'json-string','',JSON.stringify(json.slice(offset,end))]);
      offset=end;
    }
    return rows;
  }
  function csvCell(value) {
    let text=String(value ?? '');
    if (/^[=+@-]/.test(text)) text="'"+text;
    return '"'+text.replace(/"/g,'""')+'"';
  }
  function backupCsv(backup) { return backupRows(backup).map(row=>row.map(csvCell).join(',')).join('\r\n'); }
  function parseCsv(text) {
    const rows=[];let row=[],cell='',quoted=false;
    for(let i=0;i<text.length;i++) {
      const c=text[i];
      if(c==='"') {if(quoted && text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
      else if(c===','&&!quoted){row.push(cell);cell='';}
      else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&text[i+1]==='\n')i++;row.push(cell);rows.push(row);row=[];cell='';}
      else cell+=c;
    }
    if(quoted)throw new Error('CSV quotes are not closed.');
    if(cell || row.length){row.push(cell);rows.push(row);}
    return rows;
  }
  function backupFromRows(rows) {
    const parts=rows.filter(row=>row[0]==='backup-json').sort((a,b)=>Number(a[2])-Number(b[2]));
    if(!parts.length || parts.some((row,i)=>Number(row[2])!==i))throw new Error('Full backup data is missing or incomplete.');
    return JSON.parse(parts.map(row=>row[3]==='json-string' ? JSON.parse(row[5]) : row[5]).join(''));
  }
  function backupMarkdown(backup) {
    const clean=text=>String(text).replace(/[\\`*_{}\[\]<>#]/g,'\\$&').replace(/\r?\n/g,' ');
    let md='# DailyFlow profile backup\n\n'+clean(backup.profile?.name || 'Profile')+' · '+backup.exportedAt+'\n\n';
    Object.entries(backup.data.entries).sort().forEach(([date,tasks])=>{
      md+='## '+date+'\n\n';
      tasks.forEach(task=>{md+='- ['+(task.done?'x':' ')+'] '+clean(task.content)+(task.archived?' (archived)':'')+'\n';});md+='\n';
    });
    return md+'<details>\n<summary>Full backup data for import</summary>\n\n```dailyflow-backup\n'+JSON.stringify(backup,null,2)+'\n```\n\n</details>\n';
  }
  function parseBackupText(text, extension, core) {
    text=text.replace(/^\uFEFF/,'');
    let value;
    if(extension==='csv')value=backupFromRows(parseCsv(text.replace(/^\uFEFF/,'')));
    else if(extension==='md') {
      const match=text.match(/```dailyflow-backup\s*\n([\s\S]*?)\n```/);
      if(!match)throw new Error('Markdown has no DailyFlow full backup data.');
      value=JSON.parse(match[1]);
    } else value=JSON.parse(text);
    return validateBackup(value,core);
  }
  function prepareBackupImport(current, backup, core, options={}) {
    const before=core.normalizeProfile(current), incoming=validateBackup(backup,core).data;
    const preferred=options.preferBackup === true;
    const clone=value=>JSON.parse(JSON.stringify(value));
    const mergeFields=(old,value)=>preferred?{...old,...clone(value)}:{...clone(value),...old};
    let added=0,changed=0;
    function mergeList(old,list,tasks=false) {
      const result=clone(old || []);
      (list || []).forEach(value=>{
        const index=result.findIndex(item=>item.id===value.id);
        if(index<0){result.push(clone(value));if(tasks)added++;return;}
        const previous=result[index];
        if(tasks && !core.equal(previous,value))changed++;
        result[index]=mergeFields(previous,value);
        if(tasks) for(const key of ['subtasks','comments'])result[index][key]=mergeList(previous[key],value[key]);
      });
      return result;
    }
    const merged=clone(before);
    Object.entries(incoming.entries).forEach(([date,tasks])=>{merged.entries[date]=mergeList(before.entries[date],tasks,true);});
    merged.quickNotes=mergeList(before.quickNotes,incoming.quickNotes);
    merged.customCats=mergeList(before.customCats,incoming.customCats);
    merged.settings=mergeFields(before.settings,incoming.settings);
    merged.achievements={...before.achievements,unlocked:[...new Set([...before.achievements.unlocked,...incoming.achievements.unlocked])]};
    const operations=core.diffProfile(before,merged);
    const domain=core.rebase(before,operations);
    if(domain.conflicts.length)throw new Error('This backup conflicts with deleted or carried tasks. Review those tasks before importing.');
    let data=domain.data;
    if(options.includeMetrics !== false) {
      const maps={pomLog:mergeFields(before.pomLog,incoming.pomLog),focusLog:mergeFields(before.focusLog,incoming.focusLog)};
      const taskMetrics=[];
      const slot=(object,key)=>Object.prototype.hasOwnProperty.call(object,key)?{exists:true,value:object[key]}:{exists:false};
      Object.entries(incoming.entries).forEach(([date,tasks])=>tasks.forEach(imported=>{
        const task=(data.entries[date]||[]).find(value=>value.id===imported.id);
        const original=(before.entries[date]||[]).find(value=>value.id===imported.id);
        if(!task)return;
        const item={date,id:task.id,before:{},after:{}};
        for(const key of ['pomodoros','focusSeconds']){
          item.before[key]=slot(task,key);
          item.after[key]=slot((!original || preferred || original[key]==null) && imported[key]!=null ? imported : task,key);
        }
        if(!core.equal(item.before,item.after))taskMetrics.push(item);
      }));
      const metrics={type:'import-metrics',before:{pomLog:clone(data.pomLog),focusLog:clone(data.focusLog)},after:maps,taskMetrics};
      if(taskMetrics.length || !core.equal(metrics.before,metrics.after)){data=core.applyOperation(data,metrics);operations.push(metrics);}
    }
    return {before,data,operations,summary:{addedTasks:added,matchingTasks:changed,quickNotes:incoming.quickNotes.length,categories:incoming.customCats.length,
      totalTasks:Object.values(incoming.entries).reduce((n,tasks)=>n+tasks.length,0),metricDays:new Set([...Object.keys(incoming.pomLog),...Object.keys(incoming.focusLog)]).size}};
  }
  return {dateKey, validDate, locate, unfinished, carry, autoCarry, clock, splitSegment,
    validateBackup,backupRows,backupCsv,parseCsv,backupFromRows,backupMarkdown,parseBackupText,prepareBackupImport};
});
