import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createExperienceDialogue} from '../src/experience-dialogue.js';
const ctx={sourceKey:'group:456',userId:'123',directed:true};
test('自然语言工具不需要方括号，普通聊天/否定/转述不执行',()=>{
  const d=createExperienceDialogue();
  assert.equal(d.resolve(ctx,'帮我把这张截图整理成Excel').command,'截图转表格');
  assert.deepEqual(d.resolve(ctx,'这份文件的截止日期是什么'),{command:'文件问答',args:['截止日期是什么']});
  assert.equal(d.resolve({...ctx,quotedId:'88'},'看看这段视频讲什么').command,'看视频');
  assert.equal(d.resolve(ctx,'人物不变，把背景换成雨夜',{hasImage:true}).command,'改图');
  assert.equal(d.resolve(ctx,'人物不变，再把背景调亮',{hasImage:true}).command,'改图');
  for(const text of ['不要把截图转成表格','怎么使用截图转表格','他说“确认导出”','这个表格真好看'])assert.equal(d.resolve(ctx,text),null);
  assert.equal(d.resolve({...ctx,directed:false},'看看这个视频 https://example.com/a.mp4'),null);
  assert.equal(d.resolve(ctx,'我把环境变量改了',{hasImage:true}),null);
});
test('自然确认绑定本人本会话预览，不跨用户、不跨群、不猜歧义',()=>{
  const d=createExperienceDialogue();d.observe(ctx,'【截图表格预览】p_123456abcdef');
  assert.deepEqual(d.resolve(ctx,'确认导出'),{command:'导出表格',args:['p_123456abcdef','确认']});
  assert.equal(d.resolve({...ctx,userId:'234'},'确认导出'),null);
  assert.equal(d.resolve({...ctx,sourceKey:'group:789'},'确认导出'),null);
  d.observe(ctx,'【截图表格预览】p_abcdef123456');assert.match(d.resolve(ctx,'确认导出').reply,/多个/);
});
test('确认过期不落到新对象；取消提案不执行写操作',()=>{
  let at=100000;const d=createExperienceDialogue({now:()=>at});d.observe(ctx,'【日历导入预览】p_123456abcdef');at+=600001;
  assert.equal(d.resolve(ctx,'确认导入'),null);
  d.observe(ctx,'已导入2项；批次：b_123456abcdef');
  assert.match(d.resolve(ctx,'把刚才导入那一批删掉').reply,/确认删除/);
  assert.deepEqual(d.resolve(ctx,'确认删除'),{command:'删除日历批次',args:['b_123456abcdef','确认']});
  d.resolve(ctx,'把刚才导入那一批删掉');assert.match(d.resolve(ctx,'取消这次操作').reply,/取消/);assert.equal(d.resolve(ctx,'确认删除'),null);
});
test('卡片与原文入口和视频时间追问保持当前人的上下文',()=>{
  const d=createExperienceDialogue();
  assert.equal(d.resolve(ctx,'把刚才的结果做成卡片').command,'结果卡片');
  assert.equal(d.resolve(ctx,'给我原文').command,'结果原文');
  assert.equal(d.resolve(ctx,'第二分钟那个动作是什么',{hasVideo:true}).command,'视频追问');
  assert.equal(d.resolve(ctx,'上一版更好，用上一版',{hasImage:true}).command,'上一版');
});
test('课表和订阅接受明确的自然语言参数，缺失信息要求补充而不猜',()=>{
  const d=createExperienceDialogue();
  assert.deepEqual(d.resolve({...ctx,quotedId:'77'},'导入课表，2026-10-26开始，共16周，提前10分钟提醒'),{command:'课程表导入',args:['2026-10-26','16','10']});
  assert.match(d.resolve(ctx,'帮我导入课表').reply,/日期和总周数/);
  assert.deepEqual(d.resolve(ctx,'订阅网页 https://example.com/notice 每15分钟检查'),{command:'订阅网页',args:['https://example.com/notice','15']});
  assert.deepEqual(d.resolve(ctx,'订阅RSS更新 https://example.com/rss 每5分钟检查'),{command:'订阅更新',args:['https://example.com/rss','5']});
});


test('已有视频的总结和时间戳询问先作为资料追问，包含口语、冒号时间和怎么',()=>{
 const d=createExperienceDialogue();
 for(const text of ['总结一下那个视频给我','刚刚那个烤肉视频，你有仔细看吗，有没有时间戳，各时间点在说啥','01:23在讲什么','第2分钟怎么烤的','视频各阶段分别说了什么']){
  const cmd=d.resolve({...ctx,quotedId:'88'},text,{hasVideo:true});assert.equal(cmd?.command,'视频追问',text);assert.equal(cmd.reuseOnly,true,text);assert.deepEqual(cmd.args,[text]);
 }
 for(const text of ['不要总结那个视频','他说“总结视频”','怎么使用截图转表格'])assert.equal(d.resolve(ctx,text,{hasVideo:true}),null,text);
});

test('视频费用时长与普通评价是闲聊，有近期视频或旧档案也不强制查资料',()=>{
 const d=createExperienceDialogue();
 for(const context of [{hasVideo:true},{hasArchivedVideo:true},{hasVideo:true,hasArchivedVideo:true}])for(const text of ['现在看视频5分钟才5分钱哦，真不错','我还有5分钟才能弄完，怎么办','现在看视频真便宜','这个视频真不错','之前那个视频挺好笑的','视频里说得挺有意思','5分钟5分钱挺划算','昨天的视频分析花了五分钱','分析5分钟视频才五分钱，真不错'])assert.equal(d.resolve(ctx,text,context),null,text+JSON.stringify(context));
});
test('查旧视频需要明确请求和具体指代，时间点追问仍要求现有上下文',()=>{
 const d=createExperienceDialogue();
 assert.equal(d.resolve(ctx,'视频怎么收费',{hasArchivedVideo:true}),null);assert.equal(d.resolve({...ctx,quotedId:'88'},'这个设置怎么搞',{hasArchivedVideo:true}),null);
 assert.equal(d.resolve(ctx,'昨天那个雪球视频怎么做',{hasArchivedVideo:true})?.command,'视频追问');
 assert.equal(d.resolve(ctx,'总结一下之前那个雪球视频',{hasArchivedVideo:true})?.reuseOnly,true);
 assert.equal(d.resolve(ctx,'第2分钟那个动作是什么',{hasVideo:true})?.command,'视频追问');
 assert.equal(d.resolve({...ctx,quotedId:'88'},'看看这段视频讲什么')?.command,'看视频');
});
