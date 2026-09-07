'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),dist=path.join(root,'dist');
const allowed=['app.html','app.js','firebase-init.js','index.html','manifest.json','shared/sync-core.js','style.css','sw.js','sync-client.js','vendor/SheetJS-LICENSE.txt','vendor/firebase-sdk.js','vendor/firebase-sdk.js.LEGAL.txt','vendor/xlsx.full.min.js','web-workflows.js'].sort();
function walk(directory,prefix='') { return fs.readdirSync(directory,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walk(path.join(directory,entry.name),prefix+entry.name+'/'):[prefix+entry.name]); }
assert.deepEqual(walk(dist).sort(),allowed,'Hosting output must contain only the exact static allowlist');
assert.equal(JSON.parse(fs.readFileSync(path.join(root,'firebase.json'),'utf8')).hosting.public,'dist');
const worker=fs.readFileSync(path.join(dist,'sw.js'),'utf8');
assert.match(worker,/const SHELL_VERSION = '[a-f0-9]{20}';/,'Built worker needs an asset-derived version');
assert.doesNotMatch(worker,/registration\.unregister\(|clients.*navigate\(|skipWaiting\(/);
console.log('PASS: 14 static assets only; no Android, signing, config, test or recovery artifacts hosted.');
