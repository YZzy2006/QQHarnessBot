import {test} from 'node:test';
import assert from 'node:assert/strict';
import {transcribeWav} from '../src/voice-asr.js';
test('ASR成功但无文字与HTTP失败是不同状态，原文字转写仍返回字符串',async()=>{
  const ok=content=>async()=>({ok:true,text:async()=>JSON.stringify({choices:[{message:{content}}]})});
  await assert.rejects(transcribeWav(Buffer.from('fixture-wav'),{apiKey:'fixture',fetchImpl:ok('')}),error=>error.code==='ASR_EMPTY_TRANSCRIPT');
  assert.equal(await transcribeWav(Buffer.from('fixture-wav'),{apiKey:'fixture',fetchImpl:ok('测试语音')}),'测试语音');
  await assert.rejects(transcribeWav(Buffer.from('fixture-wav'),{apiKey:'fixture',fetchImpl:async()=>({ok:false,status:403,text:async()=>'fixture denied'})}),error=>error.code!=='ASR_EMPTY_TRANSCRIPT'&&/HTTP 403/.test(error.message));
});
