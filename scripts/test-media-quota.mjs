import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {createVideoQuota} from '../src/media-quota.js';
test('视频额度持久化且跨会话按本人累计；损坏不会清空，写失败不会放行',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-media-quota-'));let at=100000;
  try{
    const q=createVideoQuota({stateDir:dir,now:()=>at,perUser:2,global:3});q.take({userId:'123'});q.take({userId:'123'});
    assert.throws(()=>createVideoQuota({stateDir:dir,now:()=>at,perUser:2,global:3}).take({userId:'123'}),/额度/);
    q.take({userId:'234'});assert.throws(()=>q.take({userId:'345'}),/额度/);
    at+=86400001;q.take({userId:'123'});assert.equal(JSON.parse(fs.readFileSync(q.file,'utf8')).rows.length,1);
    fs.writeFileSync(q.file,'broken');assert.throws(()=>q.take({userId:'123'}),/损坏/);assert.equal(fs.readFileSync(q.file,'utf8'),'broken');
    const failure=path.join(dir,'failure');fs.mkdirSync(failure);const broken=createVideoQuota({stateDir:failure,atomicWrite:()=>{throw Error('fixture write failed');}});
    assert.throws(()=>broken.take({userId:'123'}),/write failed/);assert.equal(fs.existsSync(broken.file),false);
  }finally{assert.equal(path.dirname(dir),os.tmpdir());fs.rmSync(dir,{recursive:true,force:true});}
});
