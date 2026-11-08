// 相关回归串行执行，保留每个子进程退出码；不需要真实QQ/DSH或生产凭据。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const files = [
  'utility-foundation', 'utility-weather-library', 'utility-owner-attachments', 'utility-news-scheduler', 'utility-bridge',
  'practical-data', 'practical-tools', 'practical-bridge',
  'media-sources', 'video-reader', 'media-resources', 'media-models', 'experience-dialogue', 'media-experience', 'result-cards', 'experience-utilities', 'media-quota', 'media-experience-bridge',
  'life-services', 'search-maps', 'manual-wake-recovery', 'companion-dates', 'companion', 'companion-bridge', 'request-continuity', 'chat-understanding',
  'owner-tools', 'owner-summary', 'owner-tools-bridge',
  'proactive-policy', 'proactive-topics', 'social-state',
  'time-parse', 'recurrence', 'target-resolve',
  'owner-actions', 'owner-actions-bridge', 'owner-inspect', 'owner-inspect-bridge',
  'owner-extra', 'owner-console', 'owner-command-guide', 'admin-actions',
  'whitelist-commands', 'group-chat', 'qzone-social-bridge', 'qwen-vl', 'role-card', 'reliability', 'hardening'
];
const childEnv = {...process.env};
delete childEnv.NODE_TEST_CONTEXT;
let passed = 0;
for (const name of files) {
  const result = spawnSync(process.execPath, [path.join(root, 'scripts', `test-${name}.mjs`)], { cwd: root, env: childEnv, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  if (result.status !== 0 || result.error) {
    console.error(`FAIL ${name} exit=${result.status}: ${result.error?.message || ''}\n${result.stdout || ''}${result.stderr || ''}`);
    process.exitCode = 1;
  } else {
    passed++;
    console.log(`PASS ${name}: ${(result.stdout || '').trim().split(/\r?\n/).at(-1)}`);
  }
}
console.log(`owner-tools suite: ${passed}/${files.length} groups passed`);
