const {test,expect}=require('@playwright/test');
const http=require('node:http');
const fs=require('node:fs/promises');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
let server,base,version='offline-test-v1';
test.use({channel:process.env.PLAYWRIGHT_CHANNEL || (process.platform==='win32'?'msedge':'chromium'),serviceWorkers:'allow'});

test.beforeAll(async()=>{
  server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/api/private-data'){res.setHeader('Content-Type','application/json');res.end('{"fixture":"private"}');return;}
    const file=path.resolve(root,'.'+pathname);
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    try{
      let body=await fs.readFile(file);
      if(pathname==='/sw.js')body=Buffer.from(body.toString().replace("'development-v3'",JSON.stringify(version)));
      res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json'})[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control','no-store');res.end(body);
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  base='http://127.0.0.1:'+server.address().port;
});
test.afterAll(async()=>{await new Promise(resolve=>server.close(resolve));});
test.beforeEach(async({context})=>{
  version='offline-test-v1';
  // Browser requests to cloud/auth/CDN domains are blocked; only this fixture server is reachable.
  await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
});
async function ready(page){await page.goto(base+'/app.html?firebase=local');await page.waitForFunction(()=>window._df_appReady);
  await page.evaluate(()=>navigator.serviceWorker.ready);await page.waitForFunction(()=>!!navigator.serviceWorker.controller);}

test('offline reload preserves saved tasks and timer; local Firebase SDK initializes without a CDN',async({page,context})=>{
  await ready(page);
  const session=await page.evaluate(()=>{
    state.settings.timerSound='none';state.notes.entries[todayStr()]=[{id:'offline-task',content:'Available offline'}];save();
    trackEntry('offline-task');setMode('stopwatch');startTimer();return state.timer.sessionId;
  });
  await context.setOffline(true);
  await page.reload();await page.waitForFunction(()=>window._df_appReady);
  await expect(page.locator('#log')).toContainText('Available offline');
  expect(await page.evaluate(()=>state.timer.sessionId)).toBe(session);
  expect(await page.evaluate(()=>state.timer.running)).toBe(true);
  await page.evaluate(()=>stopTimer());
  // Emulator mode initializes real bundled SDK modules but makes no production connection.
  await page.goto(base+'/app.html?firebase=emulator');
  await page.waitForFunction(()=>window._df_firebaseReady);
  expect(await page.evaluate(()=>!!window._df_auth && !!window._df_db)).toBe(true);
  expect(await page.evaluate(()=>window._df_firebaseError || null)).toBeNull();
  await context.setOffline(false);
});

test('the shell never caches API responses and updates wait without losing active work',async({page,context})=>{
  await ready(page);
  const privateData=await page.evaluate(()=>fetch('/api/private-data').then(response=>response.json()));
  expect(privateData.fixture).toBe('private');
  const cached=await page.evaluate(async()=>{const keys=await caches.keys();return (await Promise.all(keys.map(async key=>(await (await caches.open(key)).keys()).map(request=>request.url)))).flat();});
  expect(cached.some(url=>url.includes('/api/'))).toBe(false);
  await page.locator('#entryInput').fill('Unsaved draft stays here');
  const session=await page.evaluate(()=>{state.settings.timerSound='none';setMode('stopwatch');startTimer();return state.timer.sessionId;});
  let navigations=0;page.on('framenavigated',frame=>{if(frame===page.mainFrame())navigations++;});
  version='offline-test-v2';
  await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration();await registration.update();});
  await page.waitForFunction(async()=>!!(await navigator.serviceWorker.getRegistration()).waiting);
  expect(navigations).toBe(0);await expect(page.locator('#entryInput')).toHaveValue('Unsaved draft stays here');
  expect(await page.evaluate(()=>state.timer.sessionId)).toBe(session);expect(await page.evaluate(()=>state.timer.running)).toBe(true);
  await context.setOffline(true);
  expect(await page.evaluate(()=>fetch('/api/private-data').then(()=>false,()=>true))).toBe(true);
  await context.setOffline(false);
});
