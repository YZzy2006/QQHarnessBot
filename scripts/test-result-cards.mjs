import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {buildResultCards,renderResultCards,fontMatchPath} from '../src/result-cards.js';
test('卡片只使用转义文字，不能注入SVG、脚本或远程图片',()=>{
  const pages=buildResultCards('【文件问答】\n<script>x</script><image href="http://127.0.0.1/a"/> & 内容');
  assert.equal(pages.length,1);assert.ok(pages[0].svg.includes('&lt;script&gt;'));assert.ok(!pages[0].svg.includes('<image '));assert.ok(!pages[0].svg.includes('<script>'));
});
test('长内容有限分页且提醒取原文，不偷偷截成完整结果',()=>{
  const pages=buildResultCards('【今日安排】\n'+('测试中文和英文 abcdef\n'.repeat(200)));
  assert.equal(pages.length,4);assert.ok(pages.at(-1).svg.includes('结果原文'));assert.ok(pages.every(p=>p.height<=1200));
  assert.throws(()=>buildResultCards('x',{width:10000}),/尺寸/);
  assert.ok(buildResultCards('【'+'长'.repeat(30)+'】内容')[0].svg.includes('…'));
  assert.equal(fontMatchPath('en|ja|zh-cn|zh-tw\n/usr/share/fonts/cjk.ttc'),'/usr/share/fonts/cjk.ttc');
  assert.equal(fontMatchPath('en|fr\n/usr/share/fonts/latin.ttf'),'');
});
test('实际渲染含中文的PNG并保留标题/页码，无可用字体时明确回退',()=>{
  const pages=renderResultCards('【今日安排】\n上午 09:00 组会\n下午 15:30 提交课程报告\n天气：多云，22℃\n来源：本人日历与待办，时间按北京时间');
  assert.equal(pages[0].buffer.toString('hex',0,8),'89504e470d0a1a0a');assert.equal(pages[0].buffer.readUInt32BE(16),900);
  if(process.env.MEDIA_CARD_PREVIEW)fs.writeFileSync(process.env.MEDIA_CARD_PREVIEW,pages[0].buffer);
  assert.throws(()=>renderResultCards('中文',{fontPath:'Z:/fixture-only-missing.ttf'}),/字体/);
});
