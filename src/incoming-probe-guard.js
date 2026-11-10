import {parseOwnerConsoleCommand} from './owner-console.js';
import {parseOwnerInspectCommand} from './owner-inspect.js';
import {parseOwnerExtraCommand} from './owner-extra.js';
// Block explicit machine probes at QQ ingress for every sender. Ordinary
// text/bracket administration, internal tools, timers and workbench are preserved.
const probeWords = '(?:sl|ping|pong|alive|health(?:check|z)?|status|stats|version|ver|v|uptime|sysinfo|systeminfo|serverinfo|botinfo|info|about|whoami|model|models|debug|runtime|cpu|ram|memory|mem|disk|server|system|test|echo|help|menu|commands?|测活|存活检测|在线检测|机器人检测|服务器(?:状态|信息)?|系统(?:状态|信息)|状态|磁盘状态|内存状态|运行状态|机器人状态|版本|帮助|菜单|指令)';
const machineProbe = new RegExp('^[#/.!]+\\s*' + probeWords + '(?![\\p{L}\\p{N}_])', 'iu');
// These are existing management/session operations, not diagnostics. Keep their
// original authorization and confirmation rules when no workbench is configured.
const managementSlash = new Set(['reset','new','reset-ctx','reset-context','role','silent','quiet','active','speak','qzone']);
function ignoredLine(value) {
  if (machineProbe.test(value)) return true;
  const slash = /^\/([A-Za-z][A-Za-z0-9_-]*)(?=$|[\s@?!。！？,:：])/.exec(value);
  return !!slash && !managementSlash.has(slash[1]);
}
function workbenchAdministration(text) {
  const slash=/^\/([A-Za-z][A-Za-z0-9_-]*)(?=$|\s)/.exec(text);
  if(slash&&managementSlash.has(slash[1]))return true;
  // These exact command families already have structured workbench counterparts.
  const consoleCommand=parseOwnerConsoleCommand(text),inspect=parseOwnerInspectCommand(text),extra=parseOwnerExtraCommand(text);
  if(consoleCommand.ok&&['status','conversations','groups','help','errors','deepseekBalance'].includes(consoleCommand.action))return true;
  if(inspect.ok&&['usage','server','help'].includes(inspect.action))return true;
  if(extra.ok&&['backupStatus','memoryList','help'].includes(extra.action))return true;
  const compact=text.replace(/[\[\]【】\s:：]/g,'');
  if(/^(?:指令|帮助|命令)(?:列表)?(?:\d{1,3}|全部|所有|完整)?$/.test(compact)||/^(?:功能|指令帮助|命令帮助|指令列表|命令列表|全部指令|所有指令|功能列表|帮助指令)$/.test(compact))return true;
  const head=text.replace(/^[\[【]\s*/,'');
  if(/^(?:指令|帮助|命令)(?:列表)?(?:[\]】][\[【]|\s+|[:：])/.test(head))return true;
  return /^(?:状态|运行状态|机器人状态|服务器状态)(?:[\]】][\[【]|\s+|[:：])/.test(head)||/^(?:磁盘状态|清理预览|清理磁盘|清理日志|磁盘帮助)\s*[\]】]?$/.test(head);
}
export function shouldIgnoreProbeMessage(message,{workbenchAvailable=false}={}) {
  const raw = Array.isArray(message) ? message.filter(seg=>seg?.type==='text').map(seg=>String(seg.data?.text ?? '')).join('') : typeof message === 'string' ? message : '';
  const normalized = raw.normalize('NFKC').replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufe00-\ufe0f\ufeff]/g,'').replace(/\[CQ:(?:at|reply),[^\]]*\]/gi,'').trim();
  if (!normalized) return false;
  return normalized.split(/[\r\n]+/).some(line=>{
    let value=line.trim();
    if (ignoredLine(value) || workbenchAvailable && workbenchAdministration(value)) return true;
    for(let depth=0;depth<3&&/^(?:\[.*\]|【.*】|`.*`)$/.test(value);depth++) {
      value=value.slice(1,-1).trim();
      if (ignoredLine(value)) return true;
    }
    return false;
  });
}
