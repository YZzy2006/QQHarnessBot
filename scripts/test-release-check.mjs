import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {scanText,unsafePath,checkRelease} from './release-check.mjs';

test('发布检查阻止危险文件，并仅允许空值环境模板',()=>{
  for(const name of ['.env','.env.local','config.json','state/a.json','backups/x.md','login.png','secret.pem','../escape'])assert.equal(unsafePath(name),true,name);
  assert.equal(unsafePath('.env.example'),false);
});
test('所有文件都检查密钥特征，报告不回显命中内容',()=>{
  const value=['sk','-','A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4'].join('');
  for(const name of ['src/bridge.js','scripts/test-fixture.mjs','README.md']){
    const findings=scanText(name,Buffer.from('const apiKey="'+value+'";'));
    assert.ok(findings.length>0);assert.equal(JSON.stringify(findings).includes(value),false);
  }
  assert.equal(scanText('fixture.mjs',Buffer.from('const apiKey="fixture-public-test-key";')).length,0);
});
test('工作树洗白不能掩盖暂存区或历史中的密钥',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-release-check-'));
  const git=(...args)=>execFileSync('git',['-C',dir,...args],{stdio:'pipe'});
  try{
    git('init','-b','main');git('config','user.name','release-test');git('config','user.email','test@example.invalid');
    fs.writeFileSync(path.join(dir,'release-files.json'),JSON.stringify({version:1,files:['release-files.json','app.js']}));
    const value=['ghp','_','A9b8C7d6E5f4G3h2I1j0K9l8M7n6O5p4Q3r2'].join('');
    fs.writeFileSync(path.join(dir,'app.js'),'const credential="'+value+'";');git('add','--','release-files.json','app.js');
    fs.writeFileSync(path.join(dir,'app.js'),'// clean working tree\n');
    assert.equal(checkRelease(dir).findings.length,0);
    assert.ok(checkRelease(dir,'staged').findings.length>0);
    git('-c','core.hooksPath=unused-test-hooks','commit','-m','test unsafe fixture');
    assert.ok(checkRelease(dir,'history').findings.length>0);
    git('add','--','app.js');git('-c','core.hooksPath=unused-test-hooks','commit','-m','test cleaned fixture');
    assert.equal(checkRelease(dir,'staged').findings.length,0);
    assert.ok(checkRelease(dir,'history').findings.length>0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
