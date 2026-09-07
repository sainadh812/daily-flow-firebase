const {test,expect}=require('@playwright/test');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
test.use({channel:process.env.PLAYWRIGHT_CHANNEL||(process.platform==='win32'?'msedge':'chromium'),serviceWorkers:'block'});
test.beforeEach(async({page})=>{
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),file=path.resolve(root,'.'+url.pathname);
    if(url.hostname!=='127.0.0.1'||!file.startsWith(root+path.sep))return route.abort();
    try{await route.fulfill({body:await fs.readFile(file),contentType:({'.js':'application/javascript','.html':'text/html','.css':'text/css'})[path.extname(file)]||'text/plain'});}
    catch{await route.fulfill({status:404,body:'missing'});}
  });
  await page.goto('http://127.0.0.1:4174/app.html?firebase=local');
  await page.waitForFunction(()=>window._df_appReady);
  await page.evaluate(async()=>{
    _stopCloudClients();_currentUser={uid:'alice'};
    const metadata=DailyFlowSyncCore.normalizeMeta({profiles:[{id:'p',name:'Test',emoji:'🌱',color:'#7C3AED'}]});
    window.mockCloud={online:true,docs:{'users/alice/meta/root':metadata,'users/alice/profiles/p':DailyFlowSyncCore.normalizeProfile({})},listeners:{}};
    const clone=d=>JSON.parse(JSON.stringify(d));
    const snapshot=p=>({exists:()=>!!mockCloud.docs[p],data:()=>clone(mockCloud.docs[p])});
    window._df_db={};window._df_doc=(db,p)=>p;window._df_getDoc=async p=>snapshot(p);
    window._df_onSnapshot=(p,cb)=>{mockCloud.listeners[p]=cb;cb(snapshot(p));return()=>delete mockCloud.listeners[p];};
    let serial=Promise.resolve();
    window._df_runTransaction=(db,callback)=>{
      const work=serial.catch(()=>{}).then(async()=>{
        if(!mockCloud.online)throw Object.assign(new Error('offline'),{code:'unavailable'});
        const staged={};const value=await callback({get:async p=>snapshot(p),set:(p,d)=>staged[p]=clone(d)});
        Object.assign(mockCloud.docs,staged);
        for(const p of Object.keys(staged))mockCloud.listeners[p]?.(snapshot(p));
        return value;
      });serial=work;return work;
    };
    _outbox=await DailyFlowSync.Outbox.open(indexedDB,'integration-'+crypto.randomUUID());
    await _pullFromFirestore('alice');
    await Promise.all([_metaClient,..._profileClients.values()].map(c=>c.serial));
    load();_showLoginScreen(false);state.settings.timerSound='none';state.settings.endOfDaySummary=false;
    renderDateHeader();renderLog();
  });
});
test.afterEach(async({page},info)=>{
  if(info.status!==info.expectedStatus)console.log(await page.evaluate(()=>JSON.stringify({status:[..._syncStatuses],clients:[..._profileClients].map(([id,c])=>({id,conflict:c.conflict,lastStatus:c.lastStatus})),cloud:mockCloud.docs})));
  await page.evaluate(()=>_stopCloudClients());
});

test('real form edits reach semantic transactions and preserve remote fields',async({page})=>{
  await page.locator('#entryInput').fill('Durable task');
  await page.getByRole('button',{name:'Add task',exact:true}).click();
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/profiles/p'].entries[todayStr()]?.length||0)).toBe(1);
  const data=await page.evaluate(()=>mockCloud.docs['users/alice/profiles/p']);
  expect(data.entries[Object.keys(data.entries)[0]][0].content).toBe('Durable task');
  expect(data.revision).toBeGreaterThan(0);expect(data.lastMutation.seq).toBeGreaterThan(0);
  await expect.poll(()=>page.evaluate(()=>JSON.parse(localStorage.getItem(accountKey('intentJournal'))||'[]').length)).toBe(0);
});
test('offline task edits survive client restart and synchronize on reconnect',async({page})=>{
  await page.evaluate(()=>mockCloud.online=false);
  await page.locator('#entryInput').fill('Offline durable task');
  await page.getByRole('button',{name:'Add task',exact:true}).click();
  await expect.poll(()=>page.evaluate(async()=> (await _outbox.pending('users/alice/profiles/p')).length)).toBeGreaterThan(0);
  await page.evaluate(async()=>{
    const old=_profileClients.get('p');old.stop();_profileClients.delete('p');
    const restored=await _ensureProfileClient('p');await restored.serial;
  });
  await expect(page.locator('#log')).toContainText('Offline durable task');
  await page.evaluate(async()=>{mockCloud.online=true;await _pushToFirestore();});
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/profiles/p'].entries[todayStr()]?.length||0)).toBe(1);
});
test('new profile creation is journaled before its asynchronous first snapshot',async({page})=>{
  await page.evaluate(()=>{
    state.profiles.push({id:'new-profile',name:'New',emoji:'🌱',color:'#7C3AED'});
    switchToProfile('new-profile');
    state.notes.entries[todayStr()]=[{id:'new-task',content:'First task',comments:[],subtasks:[]}];save();renderLog();
  });
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/profiles/new-profile']?.entries[todayStr()]?.[0]?.content)).toBe('First task');
});

test('authenticated startup resumes the saved session after loading its account namespace',async({page})=>{
  const session=await page.evaluate(async()=>{
    setMode('stopwatch');startTimer();saveTimerState();const session=state.timer.sessionId;
    clearInterval(state.timer.iv);state.timer.running=false;
    _stopCloudClients();_currentUser=null;load();
    window._df_onAuthStateChanged=callback=>window.mockAuthChange=callback;
    _initFirebaseAuth();await mockAuthChange({uid:'alice'});return session;
  });
  expect(await page.evaluate(()=>state.activeProfileId)).toBe('p');
  expect(await page.evaluate(()=>state.timer.sessionId)).toBe(session);
  expect(await page.evaluate(()=>state.timer.running)).toBe(true);
  expect(await page.evaluate(()=>!!state.timer.iv)).toBe(true);
});

test('remote removal switches profile, stops its timer and preserves the removed profile cache',async({page})=>{
  await page.evaluate(async()=>{
    const meta=mockCloud.docs['users/alice/meta/root'];
    meta.profiles.push({id:'other',name:'Other',emoji:'🌱',color:'#123456'});meta.revision++;
    mockCloud.listeners['users/alice/meta/root']({exists:()=>true,data:()=>structuredClone(meta)});await _metaClient.serial;
    await _ensureProfileClient('other');
    state.notes.entries[todayStr()]=[{id:'removed-task',content:'Retain recovery copy'}];save();
    await _profileClients.get('p').serial;
    setMode('stopwatch');startTimer();state.timer.segmentStartedAt-=5000;saveTimerState();
    mockCloud.online=false;meta.profiles=meta.profiles.filter(p=>p.id!=='p');meta.revision++;
    mockCloud.listeners['users/alice/meta/root']({exists:()=>true,data:()=>structuredClone(meta)});await _metaClient.serial;
  });
  await expect.poll(()=>page.evaluate(()=>state.activeProfileId)).toBe('other');
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem(profileKey('p','timer'))).running)).toBe(false);
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem(profileKey('p','entries')))[todayStr()][0].content)).toBe('Retain recovery copy');
  expect(await page.evaluate(()=>_profileClients.has('p'))).toBe(false);
  expect(await page.evaluate(()=>state.profiles.map(p=>p.id))).toEqual(['other']);
});

test('removing the final cloud profile leaves an empty workspace until explicit creation',async({page})=>{
  await page.evaluate(async()=>{
    const meta=mockCloud.docs['users/alice/meta/root'];meta.profiles=[];meta.revision++;
    mockCloud.listeners['users/alice/meta/root']({exists:()=>true,data:()=>structuredClone(meta)});await _metaClient.serial;
  });
  await expect.poll(()=>page.evaluate(()=>state.activeProfileId)).toBeNull();
  await expect(page.locator('#emptyWorkspace')).toBeVisible();
  expect(await page.evaluate(()=>{load();startTimer();return {profiles:state.profiles,running:state.timer.running};})).toEqual({profiles:[],running:false});
  await page.locator('#emptyWorkspace button').click();await page.locator('#newProfileName').fill('Explicit profile');
  await page.locator('#submitCreateProfile').click();
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/meta/root'].profiles.length)).toBe(1);
  expect(await page.evaluate(()=>mockCloud.docs['users/alice/meta/root'].profiles[0].name)).toBe('Explicit profile');
  await expect(page.locator('#emptyWorkspace')).toBeHidden();
});

test('incoming appearance settings apply without changing an active timer identity or deadline',async({page})=>{
  const before=await page.evaluate(()=>{startTimer();return {session:state.timer.sessionId,deadline:state.timer.deadlineAt};});
  await page.evaluate(async()=>{
    const data=mockCloud.docs['users/alice/profiles/p'];
    Object.assign(data.settings,{dark:true,accentColor:'#123456',fontSize:19,warmLight:65,workDuration:40});data.revision++;
    mockCloud.listeners['users/alice/profiles/p']({exists:()=>true,data:()=>structuredClone(data)});await _profileClients.get('p').serial;
  });
  await expect(page.locator('html')).toHaveAttribute('data-theme','dark');
  expect(await page.evaluate(()=>document.documentElement.style.getPropertyValue('--primary'))).toBe('#123456');
  expect(await page.evaluate(()=>document.documentElement.style.fontSize)).toBe('19px');
  await expect(page.locator('#warmSlider')).toHaveValue('65');
  expect(await page.evaluate(()=>({session:state.timer.sessionId,deadline:state.timer.deadlineAt}))).toEqual(before);
  expect(await page.evaluate(()=>state.timer.running)).toBe(true);
});

test('an account change during opening storage cancels the old pull before any document read',async({page})=>{
  const result=await page.evaluate(async()=>{
    const saved=_outbox,open=DailyFlowSync.Outbox.open,getDoc=_df_getDoc;
    _stopCloudClients();_outbox=null;let release,reads=0;
    DailyFlowSync.Outbox.open=()=>new Promise(resolve=>release=resolve);
    window._df_getDoc=async(...args)=>{reads++;return getDoc(...args);};
    const pending=_pullFromFirestore('alice');_stopCloudClients();_currentUser={uid:'bob'};
    release(saved);await pending;
    DailyFlowSync.Outbox.open=open;window._df_getDoc=getDoc;_outbox=saved;
    return {reads,profiles:[..._profileClients.keys()],meta:!!_metaClient};
  });
  expect(result).toEqual({reads:0,profiles:[],meta:false});
});

test('editing a published task still emits a patch; deferred remote fields survive draft save',async({page})=>{
  await page.locator('#entryInput').fill('Original');await page.locator('#addBtn').click();
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/profiles/p'].entries[todayStr()]?.length||0)).toBe(1);
  const id=await page.evaluate(()=>state.notes.entries[todayStr()][0].id);
  await page.evaluate(id=>startEdit(id),id);await page.locator('#ei-'+id).fill('Local edited title');
  await page.evaluate(async()=>{
    const data=mockCloud.docs['users/alice/profiles/p'];data.entries[todayStr()][0].notes='Remote details';data.revision++;
    mockCloud.listeners['users/alice/profiles/p']({exists:()=>true,data:()=>structuredClone(data)});await _profileClients.get('p').serial;
  });
  await expect(page.locator('#ei-'+id)).toHaveValue('Local edited title');
  await page.locator('#ei-'+id).press('Enter');
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/profiles/p'].entries[todayStr()][0].content)).toBe('Local edited title');
  await expect.poll(()=>page.evaluate(()=>state.notes.entries[todayStr()][0].notes)).toBe('Remote details');
  await page.evaluate(id=>archiveEntry(id),id);
  await expect.poll(()=>page.evaluate(()=>mockCloud.docs['users/alice/profiles/p'].entries[todayStr()][0].archived)).toBe(true);
});

test('identity keys do not collide across guest, crafted UID or profile separators',async({page})=>{
  const keys=await page.evaluate(()=>{
    const previous=_currentUser;const result=[];
    for(const user of [null,{uid:'local'},{uid:'a'},{uid:'a_pq'}]){
      _currentUser=user;
      for(const pid of ['q','q_timer','q_x'])result.push(profileKey(pid,'timer'));
    }
    _currentUser=previous;return result;
  });
  expect(new Set(keys).size).toBe(keys.length);
});

test('an old account failure cannot replace the current account with a login error',async({page})=>{
  const visible=await page.evaluate(async()=>{
    window._df_onAuthStateChanged=callback=>window.mockAuthChange=callback;_initFirebaseAuth();
    const original=_pullFromFirestore;let reject;
    _pullFromFirestore=()=>new Promise((resolve,no)=>reject=no);
    const pending=mockAuthChange({uid:'alice'});
    _stopCloudClients();_currentUser={uid:'bob'};_showLoginScreen(false);
    reject(new Error('Old account failed'));await pending;_pullFromFirestore=original;
    return document.getElementById('loginScreen').style.display;
  });
  expect(visible).toBe('none');
});
