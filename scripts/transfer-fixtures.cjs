'use strict';
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const core=require('../shared/sync-core.js'), workflow=require('../web-workflows.js'),XLSX=require('../vendor/xlsx.full.min.js');
const data=require('../shared/backup-fixture.json');
const backup={format:'dailyflow-backup',version:3,exportedAt:'2026-09-07T00:00:00Z',data};
const output=path.join(root,'.local','transfer-fixtures');fs.mkdirSync(output,{recursive:true});
fs.writeFileSync(path.join(output,'web.json'),JSON.stringify(backup));
fs.writeFileSync(path.join(output,'web.csv'),workflow.backupCsv(backup));
fs.writeFileSync(path.join(output,'web.md'),workflow.backupMarkdown(backup));
const book=XLSX.utils.book_new();XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet(workflow.backupRows(backup)),'DailyFlow');
fs.writeFileSync(path.join(output,'web.xlsx'),new Uint8Array(XLSX.write(book,{type:'array',bookType:'xlsx'})));
const nativeOutput=path.join(root,'android','app','build','cross-platform-backups');
if(fs.existsSync(nativeOutput)) {
  for(const ext of ['json','csv','md','xlsx']) {
    const file=path.join(nativeOutput,'native.'+ext);
    if(!fs.existsSync(file))throw new Error('Missing native output '+file);
    const parsed=ext==='xlsx'?workflow.validateBackup(workflow.backupFromRows(XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(file),{type:'array'}).Sheets.DailyFlow,{header:1,defval:''})),core):workflow.parseBackupText(fs.readFileSync(file,'utf8'),ext,core);
    for(const field of Object.keys(data))if(!core.equal(parsed.data[field],data[field]))throw new Error('Native '+ext+' lost '+field);
    console.log('Native → Web '+ext+' full-profile fixture passed');
  }
}
console.log('Web transfer fixtures ready for Android instrumentation');
