// The password is read from stdin, never argv, source, config or stdout.
import {setWorkbenchAccount} from '../src/workbench-auth.js';
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) throw Error('输入过长');
}
const {stateDir, username, password} = JSON.parse(input);
await setWorkbenchAccount(stateDir, username, password);
console.log('工作台账号已初始化；只保存加盐密码哈希。');
