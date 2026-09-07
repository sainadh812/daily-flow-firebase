const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../sw.js'),'utf8');

function worker(){
  const listeners={},stores=new Map(),fetched=[];
  let claimed=0;
  const caches={
    async open(name){if(!stores.has(name))stores.set(name,new Map());const store=stores.get(name);return {
      async addAll(requests){for(const request of requests)store.set(request.url,{url:request.url,body:'shell'});},
      async match(url){return store.get(typeof url==='string'?url:url.url);},
    };},
    async keys(){return [...stores.keys()];},async delete(name){return stores.delete(name);},
  };
  const self={registration:{scope:'https://app.example/'},location:{origin:'https://app.example'},
    clients:{async claim(){claimed++;}},addEventListener(type,fn){listeners[type]=fn;}};
  vm.runInNewContext(source,{self,caches,URL,Request,Map,Promise,fetch:async request=>{fetched.push(request.url);return {url:request.url};}});
  return {stores,fetched,get claimed(){return claimed;},async event(type,request){let awaited;
    listeners[type]({request,waitUntil(value){awaited=value;},respondWith(value){awaited=value;}});return await awaited;}};
}

test('worker caches only explicit same-origin shell assets including the local SDK',async()=>{
  const w=worker();await w.event('install');
  const assets=[...w.stores.values()][0];
  assert.ok(assets.has('https://app.example/vendor/firebase-sdk.js'));
  assert.ok([...assets.keys()].every(url=>url.startsWith('https://app.example/')));
  assert.equal(assets.size,11);
  const response=await w.event('fetch',new Request('https://app.example/app.html?firebase=local'));
  assert.equal(response.url,'https://app.example/app.html');assert.equal(w.fetched.length,0);
});

test('API/user-data/auth requests and writes are not intercepted or cached',async()=>{
  const w=worker();await w.event('install');
  for(const request of [new Request('https://app.example/api/private'),new Request('https://app.example/__/auth/handler'),
    new Request('https://firestore.googleapis.com/user-document'),new Request('https://app.example/app.js',{method:'POST',body:'private'})]){
    assert.equal(await w.event('fetch',request),undefined);
  }
  assert.equal([...w.stores.values()][0].size,11);
});

test('activation removes only older DailyFlow shells and never reloads clients',async()=>{
  const w=worker();await w.event('install');
  w.stores.set('dailyflow-shell-old',new Map());w.stores.set('unrelated-app',new Map());
  await w.event('activate');
  assert.equal(w.stores.has('dailyflow-shell-old'),false);assert.equal(w.stores.has('unrelated-app'),true);
  assert.equal(w.claimed,1);
  assert.doesNotMatch(source,/skipWaiting|\.navigate\(|\.unregister\(/);
});
