import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const SCRIPT = fileURLToPath(new URL('../scripts/disk-maintenance.py', import.meta.url));
const MODES = new Set(['status', 'preview', 'apply']);
export const DISK_HELP = '[磁盘状态] 查看占用和上次清理\n[清理预览] 仅预览过期快照\n[清理磁盘] / [清理日志] 执行安全清理\n仅管理员本人私聊可用；每15分钟检查85%阈值，每天04:10例行清理。保留博客访问日志、配置、任务、人物卡、记忆、QQ登录、备份与运行依赖。';
export function runDiskMaintenance(mode, {expectedPlan} = {}) {
  if (!MODES.has(mode)) return Promise.reject(new Error('不支持的磁盘操作'));
  const args=[SCRIPT,mode];
  if(expectedPlan!==undefined){if(mode!=='apply'||!Array.isArray(expectedPlan)||expectedPlan.length>500||JSON.stringify(expectedPlan).length>100000)return Promise.reject(Error('清理预览清单无效'));args.push('--expected-plan',JSON.stringify(expectedPlan));}
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/python3', args, { timeout: 120000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
      let result;
      try { result = JSON.parse(stdout); } catch { reject(new Error('磁盘维护不可用，未执行额外清理')); return; }
      if (result.busy) { reject(new Error('已有清理进行中，请稍后查看磁盘状态')); return; }
      if (!result.before || !result.after) { reject(new Error('磁盘维护失败，请检查服务器维护记录')); return; }
      if (error || result.errors?.length) result.partialFailure = true;
      resolve(result);
    });
  });
}
const bytes = (n) => `${(Math.max(0, Number(n) || 0) / 1024 ** 3).toFixed(2)} GiB`;
export function formatDiskMaintenance(r) {
  const label = r.mode === 'status' ? '磁盘状态' : r.dryRun ? '清理预览（未删除）' : r.partialFailure ? '清理部分失败' : '安全清理完成';
  const lines = [`${label}：${r.before.usedPercent}% → ${r.after.usedPercent}%`, `可用 ${bytes(r.after.availableBytes)} / 总计 ${bytes(r.after.totalBytes)}`];
  if (r.dryRun) lines.push(`可清孤儿快照 ${r.scratch?.eligibleDirs || 0} 个，约 ${bytes(r.scratch?.eligibleBytes)}`);
  else if (r.mode !== 'status') lines.push(`本次释放 ${bytes(r.freedBytes)}；过期快照 ${r.scratch?.removedDirs || 0} 个。`);
  if (r.scratch?.skippedReason) lines.push('无法确认DSH进程身份，已保留全部快照。');
  if (r.mode === 'status' && r.lastRun) lines.push(`上次清理：${new Date(r.lastRun.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}，释放 ${bytes(r.lastRun.freedBytes)}`);
  if (r.partialFailure) lines.push('部分维护步骤失败，不能视为全部清理成功；已保留记录。');
  if (r.after.usedPercent >= 85) lines.push('仍达到85%，安全范围不足以解除告警；请进一步检查，未扩大删除范围。');
  lines.push('博客访问日志、配置、任务、人物卡、记忆、QQ登录与备份均保留。');
  return lines.join('\n');
}
