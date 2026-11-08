import {test} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import {bridgeHarness} from './audit-bridge-harness.mjs';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB5kAAAAASUVORK5CYII=','base64');
const fact='测试画面是一只带RGB灯和小屏幕的白色游戏手柄';
async function fixture(){
  let offset=0,seq=890000;
  class Clock extends Date {constructor(...args){super(...(args.length?args:[Date.now()+offset]));}static now(){return Date.now()+offset;}}
  const h=await bridgeHarness({config:{vision:{fallbackEnabled:true},allow:{private:['123','234'],groups:['456']},socialV2:{wait:{minMs:100,maxMs:600000,minQuietAfterNewMs:100}}},globals:{Date:Clock,
    safeFetchMedia:async()=>({buffer:Buffer.from('fixture-video')}),
    withVideoEvidence:async(buffer,options,consume)=>consume({duration:6,frames:[{at:0,buffer:png}],audio:null,coverage:'仅采样画面，不是逐帧完整审阅'}),
    analyzeVideoEvidence:async()=>fact,
    renderResultCards:()=>[{buffer:png}]
  }});
  h.setMode('reserved2');let server;
  const command=async(text='',{user=123,kind='private',video=false,quote}={})=>h.handleIncoming(kind,kind==='private'?user:456,{user_id:user,self_id:h.calls.selfUin,group_id:kind==='group'?456:undefined,sender:{user_id:user,nickname:'fixture-user'},message_id:++seq,message:[...(quote?[{type:'reply',data:{id:quote}}]:[]),...(video?[{type:'video',data:{url:'https://example.com/v.mp4'}}]:[]),{type:'text',data:{text}}]},h.cfg);
  async function request(route,{key='private:123',body}={}){
    if(!server){server=h.startConsoleServer();if(!server.listening)await new Promise(r=>server.once('listening',r));}
    const st=h.getSocialV2State(key);
    return new Promise((resolve,reject)=>{
      const req=http.request({hostname:'127.0.0.1',port:server.address().port,path:'/api/socialV2/'+route+'?key='+encodeURIComponent(key),method:body?'POST':'GET',headers:{'x-console-token':'fixture-console-token','x-agent-token':st.agentToken,'content-type':'application/json'}},res=>{let text='';res.on('data',d=>text+=d);res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(text)}));});
      req.on('error',reject);req.setTimeout(5000,()=>req.destroy(Error('fixture timeout')));req.end(body?JSON.stringify({key,...body}):undefined);
    });
  }
  return {h,command,request,advance:ms=>offset+=ms,async close(){if(server)await new Promise(r=>server.close(r));await h.close();}};
}
test('视频完成后角色唤醒能看到采样摘要，持久化聊天只保留视频到达标记',async()=>{
  const f=await fixture();try{
    await f.command('',{video:true});
    assert.match(await f.h.buildWakePromptV2('private:123','private'),/白色游戏手柄/);
    const st=f.h.getSocialV2State('private:123');assert.equal(st.unread.length,1);assert.equal(st.unread[0].kind,'video');
    assert.equal(JSON.stringify(f.h.socialV2).includes(fact),false);
    assert.equal(fs.readFileSync(f.h.temp+'/state/social-v2.json','utf8').includes(fact),false);
    assert.equal(f.h.calls.prompts.length,0,'Existing batching timer is used; no immediate extra model request');
  }finally{await f.close();}
});
test('运行中的聊天通过未读、最近和等待接口都能取得同一人的短期视频资料',async()=>{
  const f=await fixture();try{
    await f.command('',{video:true});
    for(const route of ['unread','recent']){
      const r=await f.request(route);assert.equal(r.status,200);assert.match(r.data.messages.find(m=>m.kind==='video').videoContext.summary,/白色游戏手柄/);
    }
    await f.command('这个手柄的小屏幕好看吗');
    const recent=await f.request('recent');
    assert.equal(recent.data.messages.filter(m=>m.videoContext).length,1,'Only the newest message carries the bounded observation');
    await f.command('它能显示什么');
    const r=await f.request('wait',{body:{purpose:'reply',afterSeq:0,timeoutMs:100,quietMs:100}});
    assert.equal(r.status,200);assert.match(JSON.stringify(r.data.newMessages),/白色游戏手柄/);
  }finally{await f.close();}
});
test('视频资料不串人或会话，清除与过期后停止注入；周记仍不能进入',async()=>{
  const f=await fixture();try{
    await f.command('',{video:true});
    assert.doesNotMatch(await f.h.buildWakePromptV2('private:234','private'),/白色游戏手柄/);
    assert.doesNotMatch(await f.h.buildWakePromptV2('group:456','private'),/白色游戏手柄/);
    await f.command('[清除媒体上下文]');assert.doesNotMatch(await f.h.buildWakePromptV2('private:123','private'),/白色游戏手柄/);
    f.advance(16000);await f.command('',{video:true});f.advance(900001);
    assert.doesNotMatch(await f.h.buildWakePromptV2('private:123','private'),/白色游戏手柄/);
    const r=await f.request('recent');assert.doesNotMatch(JSON.stringify(r.data),/白色游戏手柄/);
    f.h.privateReportGuard.remember('private:123','fixture-private-weekly',['99']);
    await f.command('[看视频]',{quote:'99'});
    assert.doesNotMatch(await f.h.buildWakePromptV2('private:123','private'),/fixture-private-weekly|白色游戏手柄/);
  }finally{await f.close();}
});
