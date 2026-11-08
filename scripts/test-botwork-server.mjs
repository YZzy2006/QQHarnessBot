import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createBotWorkServer} from '../deploy/botwork/server.mjs';
async function fixture(t,handler){
  const calls=[];const upstream=http.createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;calls.push({url:req.url,headers:req.headers,method:req.method,body});handler(req,res,body);});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const server=createBotWorkServer({upstreamPort:upstream.address().port,timeout:1000});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [server,upstream]){s.closeAllConnections();await new Promise(r=>s.close(r));}});
  return{base:`http://127.0.0.1:${server.address().port}`,calls};
}
test('网关保留会话Cookie、Origin、CSRF及JSON，目标固定回环',async t=>{
  const f=await fixture(t,(req,res,body)=>{res.writeHead(200,{'content-type':'application/json','set-cookie':'qq_workbench=fixture; HttpOnly; Secure'});res.end(body);});
  const r=await fetch(f.base+'/api/workbench/login',{method:'POST',headers:{origin:'https://workbench.example.com',cookie:'qq_workbench=old','x-workbench-csrf':'fixture-csrf','x-console-token':'must-not-forward','content-type':'application/json'},body:'{"test":true}'});
  assert.equal(r.status,200);assert.deepEqual(await r.json(),{test:true});assert.match(r.headers.get('set-cookie'),/HttpOnly; Secure/);
  const c=f.calls[0];assert.equal(c.headers.origin,'https://workbench.example.com');assert.equal(c.headers.cookie,'qq_workbench=old');assert.equal(c.headers['x-workbench-csrf'],'fixture-csrf');assert.equal(c.headers['x-console-token'],undefined);assert.match(c.headers.host,/^127\.0\.0\.1:/);
});
test('不转发控制台、文件、路径穿越或任意目标',async t=>{
  const f=await fixture(t,(req,res)=>res.end('must not run'));
  for(const path of ['/api/status','/src/bridge.js','/config.json','/api/workbench/../status','/api/workbench/%2e%2e/status'])assert.equal((await fetch(f.base+path)).status,404);
  const badHost=await new Promise((resolve,reject)=>{const req=http.get(f.base+'/api/workbench/session',{headers:{Host:'evil.invalid'}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);});
  assert.equal(badHost,403);assert.equal(f.calls.length,0);
});
test('智能体隔离头保留给原认证处理；未授权状态原样返回',async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(req.headers['x-agent-call']?403:401,{'content-type':'application/json'});res.end('{"ok":false}');});
  assert.equal((await fetch(f.base+'/api/workbench/session')).status,401);
  assert.equal((await fetch(f.base+'/api/workbench/session',{headers:{'x-agent-call':'1'}})).status,403);
});
test('健康检查仅探测工作台未登录状态，不泄露会话及内部资料',async t=>{
  const f=await fixture(t,(req,res)=>{res.writeHead(401);res.end('private status');});
  const r=await fetch(f.base+'/healthz',{headers:{cookie:'must-not-forward'}});assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,service:'BotWork',backend:'ready'});assert.equal(f.calls[0].headers.cookie,undefined);
});
test('超大请求及非GET/POST在到达上游前拒绝',async t=>{
  const f=await fixture(t,(req,res)=>res.end('must not run'));
  assert.equal((await fetch(f.base+'/api/workbench/action',{method:'POST',body:'x'.repeat(1000001)})).status,413);
  assert.equal((await fetch(f.base+'/api/workbench/session',{method:'DELETE'})).status,405);assert.equal(f.calls.length,0);
});
test('上游连接失败返回干净的502，不输出栈或凭据',async t=>{
  const unused=http.createServer();await new Promise(r=>unused.listen(0,'127.0.0.1',r));const port=unused.address().port;await new Promise(r=>unused.close(r));
  const gateway=createBotWorkServer({upstreamPort:port});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));t.after(async()=>{gateway.closeAllConnections();await new Promise(r=>gateway.close(r));});
  const r=await fetch(`http://127.0.0.1:${gateway.address().port}/api/workbench/session`);assert.equal(r.status,502);assert.doesNotMatch(await r.text(),/stack|ECONNREFUSED|password/);
});

test('形象上传单独允许3MB以内二进制，其他接口仍限1MB',async t=>{
 const f=await fixture(t,(req,res,body)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({bytes:body.length}));});
 const body='a'.repeat(2*1024*1024),response=await fetch(f.base+'/api/workbench/portrait/upload',{method:'POST',headers:{'content-type':'image/png','x-workbench-csrf':'fixture','x-workbench-upload-id':'fixture'},body});
 assert.equal(response.status,200);assert.equal((await response.json()).bytes,body.length);assert.equal(f.calls[0].headers['x-workbench-csrf'],'fixture');
 assert.equal((await fetch(f.base+'/api/workbench/portrait/upload',{method:'POST',body:'a'.repeat(3*1024*1024+1)})).status,413);assert.equal(f.calls.length,1);
});
