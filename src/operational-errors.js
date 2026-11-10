import {createHash,randomUUID} from 'node:crypto';
const validKey = value => /^(?:private|group):[1-9]\d{0,11}$/.test(String(value));
export function createWorkbenchErrorReporter({append,ownerKey,redact=String,now=Date.now}) {
  const recent=new Map();let times=[];
  function record(source,key,message,level='error') {
    try {
      const owner=ownerKey(),target=validKey(owner)?owner:validKey(key)?key:'';
      if(!target)return false;
      const kind=String(source||'runtime').replace(/[\u0000-\u001f]/g,'').slice(0,40);
      const detail=String(redact(String(message?.message ?? message ?? '未知错误'))).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,'').slice(0,1600);
      const fingerprint=createHash('sha256').update(kind+'\0'+String(key)+'\0'+detail).digest('hex'),at=now();
      if(at-(recent.get(fingerprint)??-Infinity)<300000)return false;
      times=times.filter(time=>at-time<3600000);
      if(times.length>=100||times.filter(time=>at-time<60000).length>=20)return false;
      append({id:randomUUID(),key:target,source:'system',systemKind:kind,sourceKey:validKey(key)?String(key):'',level:level==='warning'?'warning':'error',time:new Date(at).toISOString(),message:'[系统报错 · '+kind+']\n'+(validKey(key)?'来源会话：'+key+'\n':'')+detail});
      if(recent.size>=256)recent.delete(recent.keys().next().value);
      recent.set(fingerprint,at);times.push(at);return true;
    } catch { return false; } // Error storage never falls back to a QQ message.
  }
  return {record};
}
