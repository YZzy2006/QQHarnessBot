import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createBilibiliTransport} from '../src/bilibili-transport.js';
import {createBilibiliAuth} from '../src/bilibili-auth.js';
const dns=async()=>[{address:'8.8.8.8',family:4}];
test('写接口、非GET、未知域名、私网DNS在发请求前拒绝',async()=>{
 let n=0;const t=createBilibiliTransport({lookup:dns,minGapMs:0,requestImpl:async()=>{n++;return new Response('{}');}});
 for(const u of ['https://api.bilibili.com/x/v2/reply/add','https://api.bilibili.com/x/web-interface/share/add','https://evil.example/nav'])
  await assert.rejects(t.fetch(u),/拒绝/);
 await assert.rejects(t.fetch('https://api.bilibili.com/x/web-interface/nav',{method:'POST'}),/拒绝/);
 const p=createBilibiliTransport({minGapMs:0,lookup:async()=>[{address:'127.0.0.1',family:4}],requestImpl:async()=>{n++;}});
 await assert.rejects(p.fetch('https://api.bilibili.com/x/web-interface/nav'),/公开|私网/);assert.equal(n,0);
});
test('Cookie仅到认证/API域名；跳转、过大响应和撤权拒绝',async()=>{
 const calls=[];let allowed=true;
 const t=createBilibiliTransport({lookup:dns,minGapMs:0,authorize:()=>allowed,requestImpl:async q=>{calls.push(q);return new Response('{"code":0}');}});
 await t.fetch('https://api.bilibili.com/x/web-interface/nav',{headers:{cookie:'SESSDATA=secret'}});
 await t.fetch('https://aisubtitle.hdslb.com/bfs/subtitle/a.json',{headers:{cookie:'SESSDATA=secret'}});
 assert.equal(calls[0].headers.cookie,'SESSDATA=secret');assert.equal(calls[1].headers.cookie,undefined);
 allowed=false;await assert.rejects(t.fetch('https://api.bilibili.com/x/web-interface/nav'),/关闭|权限|取消/);
 for(const reply of [new Response('',{status:302,headers:{location:'http://127.0.0.1'}}),new Response('a'.repeat(150000))]){
  const x=createBilibiliTransport({lookup:dns,minGapMs:0,requestImpl:async()=>reply});
  await assert.rejects(x.fetch('https://api.bilibili.com/x/web-interface/nav'),/跳转|过大/);
 }
});
test('扫码失败不覆盖旧凭据；成功仅脱敏状态且文件0600',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bili-auth-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const credentials={sessdata:'a'.repeat(30),bili_jct:'b'.repeat(32),buvid3:''};
 let good=true;const transport={fetch:async url=>{
  if(String(url).includes('/nav'))return Response.json({code:0,data:{isLogin:good,mid:123,uname:'test'}});
  throw Error('not expected');
 }};
 const auth=createBilibiliAuth({stateDir:dir,transport});
 await auth.save(credentials);assert.equal(auth.read().sessdata,credentials.sessdata);
 assert.equal(fs.statSync(auth.file).mode&0o777,0o600);
 assert.equal(JSON.stringify(auth.status()).includes(credentials.sessdata),false);
 good=false;await assert.rejects(auth.save({...credentials,sessdata:'c'.repeat(30)}),/登录|验证/);
 assert.equal(auth.read().sessdata,credentials.sessdata);
});
test('扫码生成、过期、取消不暴露key或Cookie',async()=>{
 let at=1000;const transport={fetch:async()=>Response.json({code:0,data:{url:'https://passport.bilibili.com/h5-app/passport/login/scan?key=x',qrcode_key:'fixturekey'}})};
 const a=createBilibiliAuth({stateDir:'/unused-fixture',transport,now:()=>at,renderQr:async()=> 'data:image/png;base64,fixture'});
 const challenge=await a.start();assert.equal(challenge.status,'waiting');assert.equal(JSON.stringify(challenge).includes('fixturekey'),false);
 at+=180001;assert.equal((await a.poll(challenge.id)).status,'expired');assert.equal(a.cancel(challenge.id).status,'expired');
});
