#!/usr/bin/env node
// 千问 VL 识图兜底：请求组装、URL/base64 选择、错误与截断。纯 mock，不访问网络。
import assert from 'node:assert/strict';
import { describeImage, QWEN_VL_DEFAULT_MODEL } from '../src/qwen-vl.js';

let passed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  });
}

function mockFetch(payload, status = 200) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts, body: JSON.parse(opts.body) });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload
    };
  };
  fn.calls = calls;
  return fn;
}

const okPayload = { choices: [{ message: { content: '  一只动漫女孩在吃饭  ' } }] };

await test('小图走 data URL，模型/提示词正确', async () => {
  const fetchImpl = mockFetch(okPayload);
  const text = await describeImage({
    buffer: Buffer.from('fake-jpeg'),
    mimeType: 'image/jpeg',
    prompt: '描述一下',
    apiKey: 'test-key',
    fetchImpl
  });
  assert.equal(text, '一只动漫女孩在吃饭');
  assert.equal(fetchImpl.calls.length, 1);
  const body = fetchImpl.calls[0].body;
  assert.equal(body.model, QWEN_VL_DEFAULT_MODEL);
  assert.equal(body.messages[0].content[1].text, '描述一下');
  assert.match(body.messages[0].content[0].image_url.url, /^data:image\/jpeg;base64,/);
  assert.equal(fetchImpl.calls[0].opts.headers.authorization, 'Bearer test-key');
});

await test('大图优先走 URL，避免 base64 膨胀', async () => {
  const fetchImpl = mockFetch(okPayload);
  await describeImage({
    url: 'https://example.com/a.gif',
    buffer: Buffer.alloc(3 * 1024 * 1024),
    mimeType: 'image/gif',
    apiKey: 'test-key',
    fetchImpl
  });
  assert.equal(fetchImpl.calls[0].body.messages[0].content[0].image_url.url, 'https://example.com/a.gif');
});

await test('只有 URL 时直接给百炼', async () => {
  const fetchImpl = mockFetch(okPayload);
  await describeImage({ url: 'https://example.com/a.jpg', apiKey: 'test-key', fetchImpl });
  assert.equal(fetchImpl.calls[0].body.messages[0].content[0].image_url.url, 'https://example.com/a.jpg');
});

await test('描述截断到 maxChars 并保留省略号', async () => {
  const fetchImpl = mockFetch({ choices: [{ message: { content: '长'.repeat(50) } }] });
  const text = await describeImage({ buffer: Buffer.from('x'), apiKey: 'test-key', fetchImpl, maxChars: 10 });
  assert.equal(text.length, 11);
  assert.ok(text.endsWith('…'));
});

await test('URL 下载失败时改用图片字节重试', async () => {
  let calls = 0;
  const seen = [];
  const fetchImpl = async (url, opts) => {
    calls += 1;
    const body = JSON.parse(opts.body);
    seen.push(body.messages[0].content[0].image_url.url);
    if (calls === 1) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: 'Failed to download multimodal content' } })
      };
    }
    return { ok: true, status: 200, json: async () => okPayload };
  };
  const text = await describeImage({
    url: 'https://example.com/expired.jpg',
    buffer: Buffer.alloc(3 * 1024 * 1024),
    mimeType: 'image/gif',
    apiKey: 'test-key',
    fetchImpl
  });
  assert.equal(calls, 2);
  assert.equal(seen[0], 'https://example.com/expired.jpg');
  assert.match(seen[1], /^data:image\/gif;base64,/);
  assert.equal(text, '一只动漫女孩在吃饭');
});

await test('HTTP 错误带出接口信息', async () => {
  const fetchImpl = mockFetch({ error: { message: 'Model not exist.', code: 'model_not_found' } }, 404);
  await assert.rejects(
    () => describeImage({ url: 'https://example.com/a.jpg', apiKey: 'test-key', fetchImpl }),
    /千问识图失败：Model not exist\./
  );
});

await test('缺少 key / 图片时明确报错', async () => {
  await assert.rejects(() => describeImage({ url: 'https://example.com/a.jpg', apiKey: ' ' }), /未配置 QWEN_API_KEY/);
  await assert.rejects(() => describeImage({ apiKey: 'x' }), /没有可用的图片 URL 或字节/);
});

console.log(`\nqwen-vl tests: ${passed} passed`);
