import {test} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createWorkbench} from '../src/workbench-http.js';
import {createWorkbenchStore} from '../src/workbench-store.js';
import {setWorkbenchAccount} from '../src/workbench-auth.js';
import {inspectPortrait,signOssRequest,decryptBlogSecret,createBlogPortraitStorage,PORTRAIT_LIMIT} from '../src/workbench-portrait.js';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOHsAAAAASUVORK5CYII=','base64');
test('图片按内容验证，拒绝SVG/伪文件/过大尺寸/过大文件',()=>{
 assert.deepEqual(inspectPortrait(png),{type:'image/png',ext:'png',width:1,height:1});
 assert.throws(()=>inspectPortrait(Buffer.from('<svg><script/></svg>')),/有效/);
 const large=Buffer.from(png);large.writeUInt32BE(99999,16);assert.throws(()=>inspectPortrait(large),/尺寸/);
 assert.throws(()=>inspectPortrait(Buffer.alloc(PORTRAIT_LIMIT+1)),/3MB/);
});
test('OSS V4规范化请求与官方示例相符，示例明文密钥由独立Python HMAC核验',()=>{
 const signed=signOssRequest({method:'PUT',bucket:'examplebucket',key:'exampleobject',region:'cn-hangzhou',accessKeyId:'example',accessKeySecret:'yourAccessKeySecret',date:new Date('2025-04-11T06:41:24Z'),headers:{'content-disposition':'attachment','content-length':'3','content-md5':'ICy5YqxZB1uWSwcVLSNLcA==','content-type':'text/plain'},additional:['content-disposition','content-length']});
 assert.equal(crypto.createHash('sha256').update(signed.canonical).digest('hex'),'c46d96390bdbc2d739ac9363293ae9d710b14e48081fcb22cd8ad54b63136eca');
 assert.equal(signed.signature,'d3694c2dfc5371ee6acd35e88c4871ac95a7ba01d3a2f476768fe61218590097');
});
test('兼容博客AES-GCM配置格式，错误密钥不能解密',()=>{
 const key=crypto.randomBytes(32),iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,iv);const encrypted=Buffer.concat([cipher.update('fixture-secret'),cipher.final()]);
 const value='ENC:'+Buffer.concat([iv,encrypted,cipher.getAuthTag()]).toString('base64');assert.equal(decryptBlogSecret(value,key),'fixture-secret');assert.throws(()=>decryptBlogSecret(value,crypto.randomBytes(32)));
});
test('上传只写工作台目录且私有，缓存可读，不泄露凭据或允许任意端点',async()=>{
 const calls=[],storage=createBlogPortraitStorage({loadConfig:async()=>({endpoint:'oss-cn-hangzhou.aliyuncs.com',bucket:'fixture-bucket',accessKeyId:'fixture-id',accessKeySecret:'fixture-secret'}),fetchImpl:async(url,options)=>{calls.push({url,options});return new Response(null,{status:200});}});
 const meta=await storage.upload(png);assert.match(meta.key,/^botwork\/portraits\//);assert.doesNotMatch(JSON.stringify(meta),/secret|accessKey/);assert.equal(calls[0].options.headers['x-oss-object-acl'],'private');assert.equal(calls[0].options.redirect,'error');
 assert.deepEqual((await storage.image(meta)).bytes,png);assert.equal(calls.length,1);
 const bad=createBlogPortraitStorage({loadConfig:async()=>({endpoint:'127.0.0.1',bucket:'fixture-bucket',accessKeyId:'x',accessKeySecret:'x'}),fetchImpl:async()=>{throw Error('must not fetch');}});await assert.rejects(bad.upload(png),/配置/);
});
test('图片上传沿用登录/Origin/CSRF，去重且保存形象，读取与移除均受保护',async t=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'workbench-portrait-')),store=createWorkbenchStore({stateDir});let uploads=0;
 await setWorkbenchAccount(stateDir,'fixture','portrait-fixture-password');
 const storage={available:()=>true,upload:async bytes=>{uploads++;inspectPortrait(bytes);return {key:'botwork/portraits/'+crypto.randomUUID()+'.png',type:'image/png',updatedAt:Date.now()};},image:async()=>({bytes:png,type:'image/png'})};
 const app=createWorkbench({root:process.cwd(),stateDir,store,portraitStorage:storage,api:async()=>({}),execute:async()=>false,facts:()=>({ownerQQ:123,scopes:[]})});
 const server=http.createServer(async(req,res)=>{if(!await app.handle(req,res,new URL(req.url,'http://localhost'))){res.writeHead(404);res.end();}});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(stateDir,{recursive:true,force:true});});
 const base='http://127.0.0.1:'+server.address().port,route='/api/workbench/portrait/upload';
 const unauth=await fetch(base+route,{method:'POST',headers:{origin:base},body:png});assert.equal(unauth.status,401);
 const login=await fetch(base+'/api/workbench/login',{method:'POST',headers:{origin:base,'content-type':'application/json'},body:JSON.stringify({username:'fixture',password:'portrait-fixture-password'})});const data=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0],id=crypto.randomUUID();
 const headers={cookie,origin:base,'x-workbench-csrf':data.csrf,'x-workbench-upload-id':id,'content-type':'image/png'};
 assert.equal((await fetch(base+route,{method:'POST',headers:{...headers,origin:'https://evil.invalid'},body:png})).status,403);
 assert.equal((await fetch(base+route,{method:'POST',headers:{...headers,'x-workbench-csrf':'bad'},body:png})).status,403);
 assert.equal((await fetch(base+route,{method:'POST',headers,body:Buffer.from('<svg/>')})).status,400);assert.equal(uploads,0);
 assert.equal((await fetch(base+route,{method:'POST',headers,body:png})).status,201);assert.equal((await fetch(base+route,{method:'POST',headers,body:png})).status,200);assert.equal(uploads,1);assert.ok(store.portrait());
 const img=await fetch(base+'/api/workbench/portrait/image',{headers:{cookie}});assert.equal(img.status,200);assert.equal(img.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await img.arrayBuffer()),png);
 assert.equal((await fetch(base+'/api/workbench/portrait/image')).status,401);
 const clearId=crypto.randomUUID();await fetch(base+'/api/workbench/action',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({action:'portrait.clear',requestId:clearId})});
 for(let n=0;n<20&&store.portrait();n++)await new Promise(resolve=>setTimeout(resolve,5));assert.equal(store.portrait(),null);assert.equal((await fetch(base+'/api/workbench/portrait/image',{headers:{cookie}})).status,404);
});
