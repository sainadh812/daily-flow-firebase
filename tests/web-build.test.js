const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const script=fs.readFileSync(path.join(root,'scripts/build-web.cjs'),'utf8');
const allowed=JSON.parse(JSON.stringify(vm.runInNewContext(script.match(/const files = (\[[\s\S]*?\]);/)[1])));

test('Hosting output is an explicit static-only allowlist with no source or credential paths',()=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'firebase.json'),'utf8'));
  assert.equal(config.hosting.public,'dist');
  assert.deepEqual(allowed.slice().sort(),[
    'index.html','app.html','app.js','style.css','firebase-init.js','manifest.json','sw.js',
    'sync-client.js','shared/sync-core.js','web-workflows.js','vendor/xlsx.full.min.js',
    'vendor/SheetJS-LICENSE.txt','vendor/firebase-sdk.js','vendor/firebase-sdk.js.LEGAL.txt'
  ].sort());
  for(const file of allowed){
    assert.equal(path.isAbsolute(file),false);assert.ok(!file.split('/').includes('..'));
    assert.doesNotMatch(file,/android|google-services|service.account|keystore|\.jks$|\.apk$|\.aab$|\.map$|node_modules|^tests\/|^e2e\//i);
    assert.ok(fs.statSync(path.join(root,file)).isFile());
  }
  assert.match(script,/createHash\('sha256'\)/);
  assert.match(script,/SHELL_VERSION =/);
});

test('an existing built directory contains only the allowlisted shell and licenses',t=>{
  const output=path.join(root,'dist');
  if(!fs.existsSync(output)){t.skip('Run npm run build to inspect generated output');return;}
  const files=[];
  const walk=directory=>{
    for(const item of fs.readdirSync(directory,{withFileTypes:true})){
      const full=path.join(directory,item.name);assert.equal(item.isSymbolicLink(),false);
      if(item.isDirectory())walk(full);else files.push(path.relative(output,full).replaceAll('\\','/'));
    }
  };
  walk(output);assert.deepEqual(files.sort(),allowed.slice().sort());
});
