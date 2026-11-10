// Incoming QQ transport policy. Internal tools, timers and the web workbench
// keep their existing authorization; there is deliberately no owner bypass here.
const diagnostic = '(?:sl|ping|pong|alive|health(?:check|z)?|status|stats|version|uptime|sysinfo|systeminfo|serverinfo|botinfo|help|menu|测活|存活检测|在线检测|机器人检测|服务器(?:状态|信息)?|系统(?:状态|信息)|状态|查询服务器状态|磁盘状态|内存状态|CPU状态|运行状态|机器人状态|版本|帮助|菜单|指令|指令列表|查看指令)';
const prefixed = new RegExp('^[#/*!！]+\\s*' + diagnostic + '(?=$|[\\s:：,，;；!?！？@\\[【])', 'i');
const explicit = new RegExp('^' + diagnostic + '$', 'i');
const plain = /^(?:sl|ping|pong|alive|healthcheck|status|uptime|sysinfo|systeminfo|serverinfo|botinfo|测活|存活检测|在线检测|机器人检测|状态|服务器|磁盘状态|内存状态|CPU状态|服务器状态|查询服务器状态|服务器信息|系统状态|系统信息|运行状态|机器人状态|机器人帮助|控制台帮助|指令列表|查看指令)$/i;
export function shouldIgnoreProbeMessage(message) {
  const raw = Array.isArray(message) ? message.filter(seg=>seg?.type==='text').map(seg=>String(seg.data?.text ?? '')).join('') : typeof message === 'string' ? message : '';
  const normalized = raw.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g,'').replace(/\[CQ:(?:at|reply),[^\]]*\]/gi,'').trim();
  if (!normalized) return false;
  return normalized.split(/[\r\n]+/).some(line=>{
    let value=line.trim();
    if(prefixed.test(value)||plain.test(value))return true;
    // Bracketed diagnostic commands are also explicit command invocations.
    for(let depth=0;depth<3&&/^(?:\[.*\]|【.*】)$/.test(value);depth++) {
      value=value.slice(1,-1).trim();
      if(prefixed.test(value)||explicit.test(value.replace(/\s+/g,'')))return true;
    }
    return false;
  });
}
