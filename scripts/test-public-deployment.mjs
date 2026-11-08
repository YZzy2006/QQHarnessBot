import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {readWorkbenchMysqlConfig} from '../src/workbench-mysql-auth.js';
import {readPortraitConfig,createBlogPortraitStorage} from '../src/workbench-portrait.js';
function fileFixture(t,name,value){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-public-config-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const file=path.join(dir,name);fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});return file;}
test('公开版数据库使用部署者独立库，拒绝远程地址、非法库名和宽松权限',t=>{
 const value={host:'127.0.0.1',database:'fixture_workbench',user:'fixture_user',password:'fixture-password'};
 const file=fileFixture(t,'database.json',value);
 assert.equal(readWorkbenchMysqlConfig(file).database,'fixture_workbench');
 for(const bad of [{...value,host:'203.0.113.1'},{...value,database:'name; DROP DATABASE x'},{...value,port:0}]){fs.writeFileSync(file,JSON.stringify(bad));assert.throws(()=>readWorkbenchMysqlConfig(file));}
 fs.writeFileSync(file,JSON.stringify(value));fs.chmodSync(file,0o644);assert.throws(()=>readWorkbenchMysqlConfig(file));
 fs.chmodSync(file,0o600);const link=file+'.link';fs.symlinkSync(file,link);assert.throws(()=>readWorkbenchMysqlConfig(link));
});
test('独立OSS配置不读取数据库或博客；配置权限与字段受保护',async t=>{
 const file=fileFixture(t,'oss.json',{endpoint:'oss-cn-hangzhou.aliyuncs.com',bucket:'fixture-bucket',accessKeyId:'fixture-id',accessKeySecret:'fixture-secret',unrelated:'not forwarded'});
 assert.deepEqual(Object.keys(readPortraitConfig(file)).sort(),['accessKeyId','accessKeySecret','bucket','endpoint']);
 let calls=0;
 const storage=createBlogPortraitStorage({configFile:file,dbFile:'/must-not-read-private-database',fetchImpl:async()=>{calls++;return new Response(null,{status:200});}});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOHsAAAAASUVORK5CYII=','base64');
 const result=await storage.upload(png);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(result),/fixture-secret|fixture-id|password|encryptionKey/);
 fs.chmodSync(file,0o644);assert.throws(()=>readPortraitConfig(file));
});
test('公开版头像存储不查询其他应用的数据库',()=>{
 const text=fs.readFileSync(new URL('../src/workbench-portrait.js',import.meta.url),'utf8');
 assert.doesNotMatch(text,/site_setting|pool\.execute|QQ_WORKBENCH_DB_FILE/);
});
