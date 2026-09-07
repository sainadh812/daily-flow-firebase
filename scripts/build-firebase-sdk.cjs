'use strict';
const path = require('node:path');
const esbuild = require('esbuild');
const root = path.resolve(__dirname, '..');
esbuild.buildSync({
  absWorkingDir: root,
  entryPoints: ['scripts/firebase-sdk-entry.mjs'],
  outfile: 'vendor/firebase-sdk.js',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2020'],
  minify: true,
  legalComments: 'external',
  sourcemap: false,
  logLevel: 'info',
});
