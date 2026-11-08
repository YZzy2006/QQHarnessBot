import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bridgeHarness} from './audit-bridge-harness.mjs';
import {createUtilities} from '../src/utilities.js';
import {summarizeOwnerMessages} from '../src/owner-summary.js';
import {describeImage} from '../src/qwen-vl.js';

async function fixture(){
  const prompts=[];
  const h=await bridgeHarness({config:{vision:{fallbackEnabled:true},allow:{private:['123','234'],groups:['456']},sendDelayMinMs:0,sendDelayMaxMs:0},globals:{
    describeImageWithQwen:async args=>{prompts.push(args);return JSON.stringify({columns:['编号','内容'],rows:[['001','测试表格']]});},
    fileSegmentToText:async()=>({text:'--- 内容开始 ---\n截止日期\n周五下午五点\n--- 内容结束 ---',bytes:30}),
    validateFetchUrl:async()=>({}),
    safeFetch:async url=>({statusCode:200,url,body:'<rss><channel><item><guid>a</guid><title>A</title></item></channel></rss>'}),
    createUtilities:d=>createUtilities({...d,compose:async()=>JSON.stringify({answer:'周五下午五点',citations:[{start:2,end:2,quote:'周五下午五点'}]})})
  }});h.setMode('reserved2');let seq=980001;
  const command=async(text,{kind='group',user=123,quote}={})=>{
    const before=h.calls.sent.length;
    await h.handleIncoming(kind,kind==='group'?456:user,{user_id:user,group_id:kind==='group'?456:undefined,self_id:h.calls.selfUin,sender:{user_id:user,nickname:'测试用户'},message_id:seq++,message:[...(quote?[{type:'reply',data:{id:quote}}]:[]),{type:'text',data:{text}}]},h.cfg);
    return h.calls.sent.slice(before).map(v=>v.text).join('\n');
  };
  return {h,command,prompts};
}
test('真实桥接通过网关缓存上传生成的Excel，私聊群聊均正确路由且不创建模型聊天',async()=>{
  for(const kind of ['private','group']){
    const {h,command,prompts}=await fixture();
    try{
      h.calls.getMessageData['88']={...(kind==='group'?{group_id:456}:{target_id:123}),sender:{user_id:123},message:[{type:'image',data:{file:'fixture.png'}}]};
      const preview=await command('[截图转表格]',{kind,quote:'88'}),id=/p_[a-f0-9]{12}/.exec(preview)?.[0];
      assert.ok(id,preview);assert.equal(prompts[0].maxTokens,4096);assert.equal(prompts[0].requireComplete,true);
      const exportReply=await command('[导出表格]['+id+'][确认]',{kind});
      assert.equal(h.calls.generatedFiles.length,1,exportReply);assert.equal(h.calls.generatedFiles[0].url,undefined);
      assert.ok(h.calls.generatedFiles[0].base64.length>50);assert.equal(h.calls.fileUploads.length,1);
      assert.equal(h.calls.fileUploads[0].action,kind==='group'?'upload_group_file':'upload_private_file');
      assert.equal(h.calls.fileUploads[0][kind==='group'?'group_id':'user_id'],kind==='group'?456:123);
      assert.equal(h.calls.fileUploads[0].file,'/gateway/downloads/'+h.calls.generatedFiles[0].name);
      assert.equal(h.calls.prompts.length,0);assert.equal(JSON.stringify(h.socialV2).includes('测试表格'),false);
    }finally{await h.close();}
  }
});
test('上传前撤销发送权限、暂停以及失败回执均不自动重发文件',async()=>{
  for(const scenario of ['revoke','pause','receipt']){
    const {h,command}=await fixture();
    try{
      h.calls.getMessageData['88']={group_id:456,sender:{user_id:123},message:[{type:'image',data:{file:'fixture.png'}}]};
      const preview=await command('[截图转表格]',{quote:'88'}),id=/p_[a-f0-9]{12}/.exec(preview)[0];
      if(scenario==='receipt')h.calls.fileUploadFailure=true;
      else h.calls.afterFilePrepare=()=>{if(scenario==='revoke')h.cfg.socialV2.tools.sendMessage=false;else h.socialV2.paused=true;};
      await command('[导出表格]['+id+'][确认]');
      const attempts=h.calls.fileUploads.length;
      assert.equal(attempts,scenario==='receipt'?1:0);
      h.socialV2.paused=false;h.cfg.socialV2.tools.sendMessage=true;
      await command('[导出表格]['+id+'][确认]');assert.equal(h.calls.fileUploads.length,attempts);
    }finally{await h.close();}
  }
});
test('真实文件问答回复来源和原文，不进入近期聊天、未读或原任务',async()=>{
  const {h,command}=await fixture();
  try{
    h.calls.getMessageData['89']={group_id:456,sender:{user_id:123},message:[{type:'file',data:{name:'fixture.txt'}}]};
    const before=JSON.stringify([...h.getReminders()]);
    const reply=await command('[文件问答][何时截止]',{quote:'89'});
    assert.match(reply,/来源消息：89[\s\S]*第2~2行[\s\S]*周五下午五点/);
    assert.equal(JSON.stringify(h.socialV2).includes('周五下午五点'),false);
    assert.equal(JSON.stringify([...h.getReminders()]),before);assert.equal(h.calls.prompts.length,0);
    const subscribed=await command('[订阅更新][https://example.com/rss][5]');assert.equal(h.utilities.practical.store.read().watches.length,1,subscribed);
  }finally{await h.close();}
});
test('文件问答与课表提取模型只收到无工具文本请求，不自动换型',async()=>{
  for(const kind of ['fileQA','courseExtract']){
    let body;
    await summarizeOwnerMessages({text:JSON.stringify({kind,facts:{text:'不可信原文',lines:[]}}),purpose:'utility',apiKey:'fixture-only',provider:'deepseek-official',model:'deepseek-flash',effort:'high',fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{finish_reason:'stop',message:{content:'{"answer":"未知","citations":[]}'}}]});}});
    assert.equal(body.tools,undefined);assert.equal(body.model,'deepseek-flash');assert.match(body.messages[0].content,/不执行|不可执行/);assert.match(body.messages[0].content,new RegExp('kind='+kind));
  }
});
test('大表格识别允许受限扩展输出，截断结果明确拒绝',async()=>{
  let body;
  await assert.rejects(describeImage({buffer:Buffer.from('fixture-image'),apiKey:'fixture-only',maxTokens:4096,maxChars:24000,requireComplete:true,fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({choices:[{finish_reason:'length',message:{content:'{"columns":['}}]});}}),/上限/);
  assert.equal(body.max_tokens,4096);
});
test('真正出站队列重查取消令牌，而不是只在调用发送时校验',async()=>{
  const {h}=await fixture();
  try{
    await h.sendToQQ('private:123','不应该实际发送',{authorize:()=>false});
    assert.equal(h.calls.sent.length,0);
    await h.sendToQQ('private:123','正常发送',{authorize:()=>true});
    assert.equal(h.calls.sent.length,1);
  }finally{await h.close();}
});
