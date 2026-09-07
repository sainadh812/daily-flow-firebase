const { test, expect } = require('@playwright/test');
const fs = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pageErrors = new WeakMap();
test.use({ channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chromium'),
  serviceWorkers: 'block', viewport: { width: 1366, height: 900 } });

test.beforeEach(async ({ page }) => {
  const errors=[];
  pageErrors.set(page, errors);
  page.on('pageerror', error=>errors.push(error.message));
  // Route every request to repository files. Tests cannot connect to Firebase or external hosts.
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.hostname !== '127.0.0.1') return route.abort();
    const file = path.resolve(root, '.' + url.pathname);
    if (!file.startsWith(root + path.sep)) return route.abort();
    try {
      await route.fulfill({body: await fs.readFile(file),contentType:({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)] || 'application/octet-stream'});
    } catch { await route.fulfill({status:404,body:'Not found'}); }
  });
  await page.goto('http://127.0.0.1:4174/app.html?firebase=local');
  await page.waitForFunction(() => window._df_appReady);
  await page.evaluate(() => {
    _showLoginScreen(false);
    state.settings.endOfDaySummary = false;
    state.settings.timerSound = 'none';
    state.notes.entries = {};
    state.notes.date = todayStr();
    state.ui.taskScope = 'daily';
    state.ui.entryDateExplicit = false;
    renderDateHeader();renderLog();
  });
});

test.afterEach(async ({page}) => {
  expect(pageErrors.get(page), 'No browser runtime errors').toEqual([]);
});

test('task date, details and focus survive adding a future task', async ({page}) => {
  const future = await page.evaluate(() => offsetDate(todayStr(), 4));
  await page.locator('#entryInput').fill('Plan next sprint');
  await page.locator('#entryDate').fill(future);
  await page.locator('#entryDate').dispatchEvent('change');
  await expect(page.locator('#entryDate')).toHaveValue(future);
  await page.getByRole('button', {name:'Details (optional)',exact:true}).click();
  await page.locator('#descInput').fill('Keep this context');
  await page.getByRole('button', {name:'Add task',exact:true}).click();
  await expect(page.locator('#entryInput')).toBeFocused();
  const task = await page.evaluate(date => state.notes.entries[date][0], future);
  expect(task.content).toBe('Plan next sprint');expect(task.notes).toBe('Keep this context');
  await page.getByRole('button', {name:'Unfinished · all dates'}).click();
  await expect(page.locator('#log')).toContainText('Upcoming');
  await expect(page.locator('#log')).toContainText('Plan next sprint');
});

test('inline draft and caret survive redraw without stealing search focus', async ({page}) => {
  await page.evaluate(() => {
    state.notes.entries[todayStr()] = [{id:'draft-task',content:'Draft task',cat:'work',comments:[],subtasks:[]}];renderLog();
    toggleCommentForm('draft-task');
  });
  const draft=page.locator('#cmtInput-draft-task');
  await draft.fill('Unsent progress note');
  await draft.evaluate(el=>el.setSelectionRange(7,7));
  await page.evaluate(()=>renderLog());
  await expect(draft).toHaveValue('Unsent progress note');await expect(draft).toBeFocused();
  expect(await draft.evaluate(el=>el.selectionStart)).toBe(7);
  await page.locator('#searchInput').fill('Draft');
  await expect(page.locator('#searchInput')).toBeFocused();
  await expect(draft).toHaveValue('Unsent progress note');
});

test('Unfinished groups dates, excludes completed and carried source, and archive restores', async ({page}) => {
  await page.evaluate(() => {
    const task=(id,content,extra={})=>({id,content,cat:'work',comments:[],subtasks:[],...extra});
    state.notes.entries={
      [offsetDate(todayStr(),-8)]:[task('old','Earlier task'),task('done','Completed task',{done:true}),task('source','Carried source',{rolledTo:todayStr()})],
      [todayStr()]:[task('today','Today task')],[offsetDate(todayStr(),3)]:[task('future','Future task')]
    };setTaskScope('unfinished');
  });
  await expect(page.locator('.task-group-heading')).toHaveText(['Earlier','Today','Upcoming']);
  await expect(page.locator('#log .log-entry')).toHaveCount(3);
  await page.locator('[data-id="old"] .archive-task').click();
  await expect(page.locator('#log .log-entry')).toHaveCount(2);
  await page.getByRole('button',{name:'Archived',exact:true}).click();
  await expect(page.locator('[data-id="old"]')).toBeVisible();
  await page.locator('[data-id="old"] .archive-task').click();
  await page.getByRole('button',{name:'Unfinished · all dates'}).click();
  await expect(page.locator('[data-id="old"]')).toBeVisible();
});

test('auto-carry is nonblocking and keeps completed subtasks visible', async ({page}) => {
  await page.evaluate(() => {
    state.settings.autoRollover=true;
    state.notes.entries[offsetDate(todayStr(),-30)]=[{id:'carry-test',content:'Carry fixture',cat:'work',autoRollover:true,
      comments:[{id:'history',text:'Earlier progress',time:'09:00'}],subtasks:[{id:'done-sub',text:'Already done',done:true},{id:'open-sub',text:'Remaining',done:false}]}];
    checkAutoRollover();
  });
  await expect(page.locator('#carrySummary')).toBeVisible();
  await expect(page.locator('#autoRollModal')).not.toHaveClass(/open/);
  await expect(page.locator('#sti-wrap-done-sub input[type=checkbox]')).toBeChecked();
  await expect(page.locator('#log')).toContainText('Carry fixture');
});

test('focus mode keeps timer controls visible and Skip leaves next phase stopped', async ({page}) => {
  await page.evaluate(() => {state.settings.focusMode=true;state.settings.autoStartBreaks=true;setMode('work');});
  await page.locator('#playBtn').click();
  await expect(page.locator('#playBtn')).toBeVisible();
  await expect(page.locator('#finishBtn')).toBeVisible();
  await expect(page.locator('#skipBtn')).toBeVisible();
  await page.locator('#skipBtn').click();
  await expect(page.locator('#playText')).toHaveText('Start');
  expect(await page.evaluate(()=>state.timer.running)).toBe(false);
  expect(await page.evaluate(()=>state.pomLog[todayStr()]||0)).toBe(0);
});

test('mobile task form stays within viewport', async ({page}, testInfo) => {
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>window.scrollTo(0,0));
  const initialInput=await page.locator('#entryInput').boundingBox();
  expect(initialInput.y).toBeLessThan(500);
  const order=await page.evaluate(()=>({content:document.querySelector('.content').getBoundingClientRect().bottom,
    sidebar:document.querySelector('#sidebar').getBoundingClientRect().top}));
  expect(order.sidebar).toBeGreaterThanOrEqual(order.content);
  await expect(page.locator('#fabBtn')).toBeHidden();
  await page.locator('#entryInput').fill('A task on mobile');
  await expect(page.getByRole('button',{name:'Add task',exact:true})).toBeVisible();
  const size=await page.evaluate(()=>({width:document.documentElement.scrollWidth,viewport:innerWidth}));
  expect(size.width).toBeLessThanOrEqual(size.viewport);
  const calendar=await page.locator('.cal-grid').evaluate(el=>({content:el.scrollWidth,box:el.clientWidth}));
  expect(calendar.content).toBeLessThanOrEqual(calendar.box);
  const titleWidth=await page.locator('#entryInput').evaluate(el=>el.getBoundingClientRect().width);
  expect(titleWidth).toBeGreaterThan(250);
  await expect(page.locator('.main-nav')).toBeVisible();
  await page.locator('.add-card').screenshot({path:testInfo.outputPath('mobile-add-task.png')});
  await page.screenshot({path:testInfo.outputPath('mobile.png'),fullPage:true});
  await page.screenshot({path:path.join(root,'.local/web-mobile.png'),fullPage:true});
});

test('desktop keeps its sidebar alongside the task workspace and its compose shortcut',async({page})=>{
  const boxes=await page.evaluate(()=>({sidebar:document.querySelector('#sidebar').getBoundingClientRect().right,
    content:document.querySelector('.content').getBoundingClientRect().left}));
  expect(boxes.sidebar).toBeLessThanOrEqual(boxes.content);
  await expect(page.locator('#fabBtn')).toBeVisible();
  await page.screenshot({path:path.join(root,'.local/web-desktop.png'),fullPage:true});
});

test('stopwatch records actual time to its linked task while browsing another date', async ({page}) => {
  await page.clock.install();
  await page.evaluate(() => {
    state.notes.entries[offsetDate(todayStr(),-2)]=[{id:'timer-task',content:'Linked fixture',cat:'work',comments:[],subtasks:[]}];
    trackEntry('timer-task');setMode('stopwatch');startTimer();
    navigateToDate(offsetDate(todayStr(),3));
  });
  await page.clock.fastForward(43000);
  await page.locator('#playBtn').click();
  expect(await page.evaluate(()=>findEntry('timer-task').focusSeconds)).toBe(43);
  expect(await page.evaluate(()=>state.focusLog[todayStr()])).toBe(43);
  await expect(page.locator('#timerLinkedTask')).toContainText('Linked fixture');
  await page.clock.fastForward(20000);
  await page.locator('#playBtn').click();
  await page.clock.fastForward(17000);
  await page.locator('#finishBtn').click();
  expect(await page.evaluate(()=>findEntry('timer-task').focusSeconds)).toBe(60);
  expect(await page.evaluate(()=>state.pomLog[todayStr()]||0)).toBe(0);
});

test('refresh restores an active countdown and its linked task without resetting duration', async ({page}) => {
  await page.clock.install();
  const identity=await page.evaluate(()=>{
    state.notes.entries[todayStr()]=[{id:'restore-task',content:'Restore fixture',cat:'work',comments:[],subtasks:[]}];
    save();trackEntry('restore-task');setMode('work');startTimer();return state.timer.sessionId;
  });
  await page.clock.fastForward(70000);
  await page.reload();
  await page.waitForFunction(()=>window._df_appReady);
  expect(await page.evaluate(()=>state.timer.sessionId)).toBe(identity);
  expect(await page.evaluate(()=>state.timer.activeEntryId)).toBe('restore-task');
  expect(await page.evaluate(()=>state.timer.timeLeft)).toBeLessThanOrEqual(1430);
  expect(await page.evaluate(()=>state.timer.timeLeft)).toBeGreaterThan(1425);
  await page.locator('#playBtn').click();
  expect(await page.evaluate(()=>state.focusLog[todayStr()])).toBeGreaterThanOrEqual(70);
});

test('backup import previews without mutation, merges nested data, and restores metrics once', async ({page}) => {
  const backup={format:'dailyflow-backup',version:3,profile:{id:'foreign-profile',name:'Backup source'},data:{
    entries:{'2026-09-01':[{id:'import-task',content:'Imported task',pomodoros:2,focusSeconds:310,
      comments:[{id:'import-cmt',text:'Preserved comment'}],subtasks:[{id:'import-st',text:'Completed child',done:true}]}]},
    pomLog:{'2026-09-01':2},focusLog:{'2026-09-01':310},quickNotes:[{id:'import-note',text:'A quick note'}],
    customCats:[{id:'import-cat',label:'Project',color:'#123456',emoji:'★'}],achievements:{unlocked:['first_entry']},settings:{workDuration:40}}};
  await page.evaluate(()=>{state.notes.entries['2026-09-01']=[{id:'existing-task',content:'Keep this task'}];save();});
  const profile=await page.evaluate(()=>state.activeProfileId);
  const file={name:'backup.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(backup))};
  await page.locator('#importFile').setInputFiles(file);
  await expect(page.locator('#importPreview')).toBeVisible();
  expect(await page.evaluate(()=>findEntry('import-task'))).toBeNull();
  await page.locator('#confirmImport').click();
  expect(await page.evaluate(()=>state.activeProfileId)).toBe(profile);
  expect(await page.evaluate(()=>state.notes.entries['2026-09-01'].length)).toBe(2);
  expect(await page.evaluate(()=>findEntry('import-task').focusSeconds)).toBe(310);
  expect(await page.evaluate(()=>state.quickNotes[0].text)).toBe('A quick note');
  await page.locator('#importFile').setInputFiles(file);
  await page.locator('#confirmImport').click();
  expect(await page.evaluate(()=>state.focusLog['2026-09-01'])).toBe(310);
});

test('every full-backup export downloads a file that can be previewed for import', async ({page}) => {
  await page.evaluate(()=>{
    state.notes.entries[todayStr()]=[{id:'backup-roundtrip',content:'Backup roundtrip',notes:'Details',cat:'work',pomodoros:1,focusSeconds:42,
      subtasks:[{id:'backup-st',text:'Child',done:true}],comments:[{id:'backup-cmt',text:'Comment'}]}];
    state.focusLog[todayStr()]=42;state.pomLog[todayStr()]=1;save();switchView('analytics');
  });
  for(const id of ['exportJsonBtn','exportCsvBtn','exportBackupMdBtn','exportBackupXlsxBtn']){
    const downloadPromise=page.waitForEvent('download');await page.locator('#'+id).click();const download=await downloadPromise;
    const buffer=await fs.readFile(await download.path());
    await page.locator('#importFile').setInputFiles({name:download.suggestedFilename(),mimeType:'application/octet-stream',buffer});
    await expect(page.locator('#importPreview')).toBeVisible();
    await expect(page.locator('#importSummary')).toContainText('0 new tasks');
    await page.locator('#cancelImport').click();
  }
});

test('crash recovery applies a durable time checkpoint and pending timer segment exactly once', async ({page}) => {
  const segment=await page.evaluate(()=>{
    const date=todayStr();state.notes.entries[date]=[{id:'crash-task',content:'Crash fixture'}];save();
    const segment={id:'crash-session_0',sessionId:'crash-session',profileId:state.activeProfileId,taskId:'crash-task',taskDate:date,date,
      kind:'pomodoro',startedAt:Date.now()-43000,endedAt:Date.now(),activeSeconds:43,completedPomodoro:false,reason:'pause'};
    localStorage.setItem(profileKey(state.activeProfileId,'segmentCheckpoint'),JSON.stringify({segment,next:DailyFlowSyncCore.applySegment(_profileSnapshot(),segment)}));
    Object.assign(state.timer,{running:false,segmentStartedAt:null,deadlineAt:null,sessionId:segment.sessionId,pendingSegments:[segment]});saveTimerState();return segment;
  });
  await page.reload();await page.waitForFunction(()=>window._df_appReady);
  expect(await page.evaluate(()=>findEntry('crash-task').focusSeconds)).toBe(43);
  expect(await page.evaluate(()=>localStorage.getItem(profileKey(state.activeProfileId,'segmentCheckpoint')))).toBeNull();
  expect(await page.evaluate(()=>state.timer.pendingSegments.length)).toBe(0);
  await page.evaluate(segment=>recordTimeSegment(segment),segment);
  expect(await page.evaluate(()=>findEntry('crash-task').focusSeconds)).toBe(43);
  await page.reload();await page.waitForFunction(()=>window._df_appReady);
  expect(await page.evaluate(()=>findEntry('crash-task').focusSeconds)).toBe(43);
});

test('account-scoped caches isolate identical profile IDs and import preview refuses a scope change', async ({page}) => {
  const result=await page.evaluate(()=>{
    const pid='same-profile';_currentUser={uid:'fixture-account-A'};state.activeProfileId=pid;
    state.notes.entries={[todayStr()]:[{id:'account-a-task',content:'Private A'}]};save();
    const keyA=profileKey(pid,'entries');_currentUser={uid:'fixture-account-B'};loadProfileData(pid);
    const isolated=Object.keys(state.notes.entries).length===0,keyB=profileKey(pid,'entries');
    state.notes.entries={[todayStr()]:[{id:'account-b-task',content:'Private B'}]};save();
    _currentUser={uid:'fixture-account-A'};loadProfileData(pid);
    return {isolated,keyA,keyB,restored:!!findEntry('account-a-task'),leaked:!!findEntry('account-b-task')};
  });
  expect(result.isolated).toBe(true);expect(result.keyA).not.toBe(result.keyB);expect(result.restored).toBe(true);expect(result.leaked).toBe(false);
  await page.evaluate(()=>{
    showImportPreview({entries:{[todayStr()]:[{id:'scope-import',content:'Do not import into another account'}]}});
    _currentUser={uid:'fixture-account-B'};
  });
  await page.locator('#confirmImport').click();
  await expect(page.locator('#importError')).toContainText('account or profile changed');
  expect(await page.evaluate(()=>findEntry('scope-import'))).toBeNull();
});
