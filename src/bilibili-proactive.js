import {biliDay,validTarget} from './bilibili-state.js';
export function selectBilibiliTargets({ownerQQ,privateIds=[],groupIds=[],conversations=new Map(),isAllowed,now=Date.now()}){
 const owner=String(ownerQQ),cut=now-48*3600000,ranks=[];
 for(const raw of new Set(privateIds.map(String))){
  const key='private:'+raw;if(raw===owner||!validTarget(key)||!isAllowed(key))continue;
  const st=typeof conversations.get==='function'?conversations.get(key):conversations[key],seen=new Set();let count=0,last=0;
  for(const m of [...(st?.recentMessages||[]),...(st?.unread||[])]){
   const at=Number(m?.time),id=m?.messageId??m?.seq;
   if(m?.isSelf||String(m?.userId||raw)!==raw||!Number.isFinite(at)||at<cut||at>now||id==null||seen.has(String(id)))continue;
   seen.add(String(id));count++;last=Math.max(last,at);
  }
  if(count)ranks.push({key,count,last});
 }
 ranks.sort((a,b)=>b.count-a.count||b.last-a.last||a.key.localeCompare(b.key));
 return [...new Set([...groupIds.map(id=>'group:'+id),'private:'+owner,...ranks.slice(0,2).map(x=>x.key)])].filter(k=>validTarget(k)&&isAllowed(k));
}
export function dailyBilibiliPlan(key,target,{now=Date.now(),random=Math.random,limit=3}={}){
 const r=()=>Math.min(.999999,Math.max(0,Number(random())||0));
 const draw=r(),desired=key.startsWith('group:')?(draw<.6?1:draw<.9?2:3):(draw<.5?0:1);
 const day=biliDay(now),midnight=Date.parse(day+'T00:00:00Z')-8*3600000;
 const start=midnight+target.start*3600000,end=midnight+target.end*3600000;
 const from=Math.max(start,now+60000),span=end-from;
 const count=span>0?Math.max(0,Math.min(desired,limit,Math.floor(span/3600000)+1)):0;
 const slack=count?(span-(count-1)*3600000)/count:0;
 const slots=Array.from({length:count},(_,i)=>Math.floor(from+i*(3600000+slack)+r()*slack));
 return {day,slots,cursor:0};
}
