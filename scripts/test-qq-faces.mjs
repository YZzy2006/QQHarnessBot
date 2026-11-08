#!/usr/bin/env node
// QQ 原生表情：映射、标记拆分、自动表情规则。纯函数，无网络/无状态。
import assert from 'node:assert/strict';
import {
  QQ_FACE_MAP,
  QQ_FACE_NAMES,
  AUTO_RULES,
  faceNameOf,
  buildFaceSegments,
  hasFaceMarker,
  pickAutoFace,
  appendAutoFace
} from '../src/qq-faces.js';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

test('映射：全量目录已加载，核心 id 与实测一致', () => {
  assert.ok(Object.keys(QQ_FACE_MAP).length >= 250, '映射表应覆盖大部分 QQ 表情');
  assert.equal(QQ_FACE_MAP['狗头'].id, '277');
  assert.equal(QQ_FACE_MAP.doge.id, '277');
  assert.equal(QQ_FACE_MAP['傲娇'].id, '179');
  assert.equal(QQ_FACE_MAP['捂脸'].id, '264');
  assert.equal(QQ_FACE_MAP['笑哭'].id, '182');
  assert.equal(QQ_FACE_MAP['吃瓜'].id, '271');
  assert.equal(QQ_FACE_MAP['赞'].id, '76');
  assert.equal(QQ_FACE_MAP['白眼'].id, '22');
  assert.equal(QQ_FACE_MAP['委屈'].id, '106');
  assert.equal(QQ_FACE_MAP['汪汪'].id, '277');
  assert.equal(QQ_FACE_MAP['ww'].id, '277');
  assert.equal(QQ_FACE_MAP['菜狗'].id, '317');
  assert.equal(QQ_FACE_MAP['菜狗'].large, true);
  assert.equal(QQ_FACE_MAP['崇拜'].id, '318');
  assert.equal(QQ_FACE_MAP['崇拜'].large, true);
  assert.equal(QQ_FACE_MAP['贴贴'].id, '350');
  assert.equal(QQ_FACE_MAP['牛'].id, '299');
  assert.equal(QQ_FACE_MAP['厉害'].id, '76');
  assert.equal(QQ_FACE_MAP['强'].id, '349');
});

test('反向映射：face id → 可读名称', () => {
  assert.equal(QQ_FACE_NAMES['179'], '傲娇');
  assert.equal(faceNameOf('179'), '傲娇');
  assert.equal(faceNameOf(277), '狗头');
  assert.equal(faceNameOf('317'), '菜狗');
  assert.equal(faceNameOf('318'), '崇拜');
  assert.equal(faceNameOf('999999'), '');
  assert.equal(faceNameOf(''), '');
});

test('标记拆分：纯文本原样，文本+表情切成段', () => {
  assert.deepEqual(buildFaceSegments('你好'), [{ type: 'text', data: { text: '你好' } }]);
  assert.deepEqual(buildFaceSegments('笑死 [狗头]'), [
    { type: 'text', data: { text: '笑死 ' } },
    { type: 'face', data: { id: '277' } }
  ]);
  assert.deepEqual(buildFaceSegments('【doge】'), [{ type: 'face', data: { id: '277' } }]);
  assert.deepEqual(buildFaceSegments('[傲娇]'), [{ type: 'face', data: { id: '179' } }]);
  // 兼容模型照抄入站格式 [表情:名称] 和 QQ 的 /名称 写法。
  assert.deepEqual(buildFaceSegments('[表情:狗头]'), [{ type: 'face', data: { id: '277' } }]);
  assert.deepEqual(buildFaceSegments('[/doge]'), [{ type: 'face', data: { id: '277' } }]);
  assert.deepEqual(buildFaceSegments('[表情:崇拜]'), [{ type: 'face', data: { id: '318', large: true } }]);
});

test('标记拆分：多个表情与中间文本', () => {
  assert.deepEqual(buildFaceSegments('嗯[捂脸]好[赞]'), [
    { type: 'text', data: { text: '嗯' } },
    { type: 'face', data: { id: '264' } },
    { type: 'text', data: { text: '好' } },
    { type: 'face', data: { id: '76' } }
  ]);
});

test('标记拆分：未知方括号保留为文本', () => {
  assert.deepEqual(buildFaceSegments('[图片] 你好'), [{ type: 'text', data: { text: '[图片] 你好' } }]);
  assert.deepEqual(buildFaceSegments('[CQ:face,id=1]'), [{ type: 'text', data: { text: '[CQ:face,id=1]' } }]);
});

test('标记拆分：文本段走转义函数，face 段不受影响', () => {
  const segments = buildFaceSegments('[CQ:x][狗头]', { escapeText: (s) => s.replace('[CQ:', '[CQ：') });
  assert.equal(segments[0].data.text, '[CQ：x]');
  assert.deepEqual(segments[1], { type: 'face', data: { id: '277' } });
});

test('hasFaceMarker：只认已映射的标记', () => {
  assert.equal(hasFaceMarker('好[狗头]'), true);
  assert.equal(hasFaceMarker('好[图片][狗头]'), true);
  assert.equal(hasFaceMarker('好[图片]'), false);
  assert.equal(hasFaceMarker('好'), false);
});

test('自动表情：命中语境且概率为 1', () => {
  assert.equal(pickAutoFace('笑死我了', { probability: 1, random: () => 0 }), '笑哭');
  assert.equal(pickAutoFace('这也太离谱了', { probability: 1, random: () => 0 }), '捂脸');
  assert.equal(pickAutoFace('开个玩笑', { probability: 1, random: () => 0 }), '狗头');
  assert.equal(pickAutoFace('有点傲娇', { probability: 1, random: () => 0 }), '傲娇');
  assert.equal(pickAutoFace('doge 一下', { probability: 1, random: () => 0 }), '狗头');
  assert.equal(pickAutoFace('谢谢啦', { probability: 1, random: () => 0 }), '抱拳');
  assert.equal(pickAutoFace('晚安', { probability: 1, random: () => 0 }), '挥手');
  assert.equal(pickAutoFace('好耶', { probability: 1, random: () => 0 }), '赞');
  assert.equal(pickAutoFace('太崇拜你了', { probability: 1, random: () => 0 }), '赞');
  assert.equal(pickAutoFace('有点害羞', { probability: 1, random: () => 0 }), '害羞');
  assert.equal(pickAutoFace('震惊了', { probability: 1, random: () => 0 }), '惊讶');
});

test('自动表情：概率 0 / 随机不中 / 已有标记 / 严肃内容 / 太长 都不加', () => {
  assert.equal(pickAutoFace('笑死', { probability: 0 }), '');
  assert.equal(pickAutoFace('笑死', { probability: 1, random: () => 1 }), '');
  assert.equal(pickAutoFace('笑死[狗头]', { probability: 1, random: () => 0 }), '');
  assert.equal(pickAutoFace('医院发来验证码，笑死', { probability: 1, random: () => 0 }), '');
  assert.equal(pickAutoFace('笑'.repeat(100), { probability: 1, random: () => 0 }), '');
});

test('自动表情：只使用经典小黄脸，不自动发超级表情', () => {
  for (const rule of AUTO_RULES) {
    const entry = QQ_FACE_MAP[rule.marker];
    assert.ok(entry, `自动规则 ${rule.marker} 必须在映射表里`);
    assert.notEqual(entry.large, true, `自动规则不应使用超级表情：${rule.marker}`);
  }
});

test('自动表情：无匹配语境时不硬塞', () => {
  assert.equal(pickAutoFace('今天下午三点开会', { probability: 1, random: () => 0 }), '');
});

test('自动表情：长句概率减半，长段落不自动加', () => {
  // 20 字以内：概率 1，random=0.4 命中有语境的表情。
  assert.equal(pickAutoFace('笑死'.repeat(10), { probability: 1, random: () => 0.4 }), '笑哭');
  // 22 字：概率减半为 0.5，random=0.6 不中。
  assert.equal(pickAutoFace('笑死'.repeat(11), { probability: 1, random: () => 0.6 }), '');
  assert.equal(pickAutoFace('笑死'.repeat(11), { probability: 1, random: () => 0.4 }), '笑哭');
});

test('appendAutoFace：只在命中时追加一个标记', () => {
  assert.equal(appendAutoFace('笑死', { probability: 1, random: () => 0 }), '笑死 [笑哭]');
  assert.equal(appendAutoFace('今天下午三点开会', { probability: 1, random: () => 0 }), '今天下午三点开会');
});

console.log(`\nqq-faces tests: ${passed} passed`);
