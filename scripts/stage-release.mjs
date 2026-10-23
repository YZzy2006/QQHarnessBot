// 使用明确清单暂存。扫描失败时不会执行 git add。
import fs from 'node:fs';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {checkRelease} from './release-check.mjs';
const root=fileURLToPath(new URL('..',import.meta.url));
const result=checkRelease(root);
if(result.findings.length){console.error(JSON.stringify(result,null,2));process.exit(1);}
const {files}=JSON.parse(fs.readFileSync(new URL('../release-files.json',import.meta.url),'utf8'));
const staged=spawnSync('git',['add','--pathspec-from-file=-','--pathspec-file-nul'],{cwd:root,input:files.join('\0')+'\0',encoding:'utf8',stdio:['pipe','inherit','inherit'],windowsHide:true});
if(staged.status!==0)process.exit(staged.status||1);
const checked=checkRelease(root,'staged');
console.log(JSON.stringify(checked,null,2));process.exitCode=checked.findings.length?1:0;
