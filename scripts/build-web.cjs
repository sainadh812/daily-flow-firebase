'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('./build-firebase-sdk.cjs');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'dist');
// Explicit allowlist: Android builds, source, credentials and tests cannot be hosted.
const files = ['index.html', 'app.html', 'app.js', 'style.css', 'firebase-init.js',
  'manifest.json', 'sw.js', 'sync-client.js', 'shared/sync-core.js', 'web-workflows.js', 'vendor/xlsx.full.min.js', 'vendor/SheetJS-LICENSE.txt',
  'vendor/firebase-sdk.js', 'vendor/firebase-sdk.js.LEGAL.txt'];
// This generated directory is the only destructive target; verify it before cleanup.
if (path.dirname(output) !== root || path.basename(output) !== 'dist') throw new Error('Unsafe build output path');
if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Build output must not be a symlink');
fs.rmSync(output, { recursive:true, force:true });
fs.mkdirSync(output, { recursive: true });
for (const file of files) {
  const target = path.join(output, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, file), target);
}
const hash=crypto.createHash('sha256');
for(const file of files) hash.update(file).update(fs.readFileSync(path.join(root,file)));
const version=hash.digest('hex').slice(0,20);
const worker=path.join(output,'sw.js');
fs.writeFileSync(worker,fs.readFileSync(worker,'utf8').replace("const SHELL_VERSION = 'development-v3';", `const SHELL_VERSION = '${version}';`));
console.log(`Built ${files.length} allowlisted web assets into dist/`);
