import{createBilibiliTransport}from'./bilibili-transport.js';
import{createBilibiliAuth}from'./bilibili-auth.js';
import{createBilibiliClient,normalizeBilibiliInput}from'./bilibili-client.js';
import{createBilibiliState}from'./bilibili-state.js';
import{createBilibiliRole}from'./bilibili-role.js';
import{createBilibiliExperience}from'./bilibili-experience.js';
import{createBilibiliController}from'./bilibili-controller.js';
import{createBilibiliReplyQuota}from'./bilibili-reply-quota.js';
import{createBilibiliResults}from'./bilibili-results.js';
import{extractVideoSource}from'./media-sources.js';
export async function isPublicBilibiliVideo(ref,{fetchPublic}={}){
 const n=normalizeBilibiliInput(ref?.bvid);if(!n||!Number.isInteger(ref.page||1)||ref.page<1)return false;
 try{
  const r=await fetchPublic('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(n.bvid),100000);
  if(r.statusCode!==200||r.truncated)return false;
  const value=JSON.parse(r.body);return value.code===0&&value.data?.bvid===n.bvid&&typeof value.data.title==='string'&&Array.isArray(value.data.pages)&&value.data.pages.some(p=>p.page===(ref.page||1));
 }catch{return false;}
}
export function createBilibiliBridge(d){
 const transport=d.transport||createBilibiliTransport({stateDir:d.stateDir,authorize:d.isEnabled});
 const auth=createBilibiliAuth({stateDir:d.stateDir,transport});
 const client=createBilibiliClient({transport,auth,resolveShort:async url=>(await d.fetchPublic(url,1000)).url});
 const state=createBilibiliState({stateDir:d.stateDir,atomicWrite:d.atomicWrite});
 const role=createBilibiliRole({getRole:d.getRoleSnapshot,request:d.requestRole,redact:d.redact,getPreferences:d.getPreferences});
 const roleVersion=()=>(d.getRoleSnapshot?.()?.version||'unconfigured')+':'+auth.generation();
 const results=createBilibiliResults({stateDir:d.stateDir,now:d.now,atomicWrite:d.atomicWrite,getRoleVersion:roleVersion});
 const replyQuota=createBilibiliReplyQuota({stateDir:d.stateDir,now:d.now,atomicWrite:d.atomicWrite});
 const exp=createBilibiliExperience({client,role,results,media:d.media,send:async(key,message,options)=>{const receipt=await(d.sendCard||d.send)(key,message,options);if(receipt?.sent===true&&receipt.messageId!=null)state.rememberCard({sourceKey:key,messageId:receipt.messageId,url:options.card.url});return receipt;},state,canNotify:d.canNotify,isAllowed:d.isAllowed,redact:d.redact,recordEvent:d.recordEvent});
 let timer=null,loginKey='',loginId='';
 async function show(ctx){
  if(timer){clearTimeout(timer);timer=null;}loginKey=ctx.sourceKey;
  const challenge=await auth.start(),match=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(challenge.image||'');
  if(!match)throw Error('B站二维码未生成');
  loginId=challenge.id;
  const allowed=()=>d.isEnabled()&&d.isAllowed(ctx.sourceKey)&&loginKey===ctx.sourceKey&&loginId===challenge.id;
  const receipt=await d.sendImage(ctx.sourceKey,Buffer.from(match[1],'base64'),allowed);if(receipt===false)throw Error('二维码未确认送达');
  await d.say(ctx,'请用专门给机器人的B站账号扫码并确认，二维码约3分钟有效。B站评论等写操作已禁用，自动浏览默认关闭。');
  async function poll(){
   if(!allowed()){auth.cancel(challenge.id);return;}
   try{
    const status=await auth.poll(challenge.id);
    if(status.status==='success'){await d.say(ctx,'B站登录成功，评论等写操作继续禁用。可发送[刷B站]立即浏览；自动浏览需另行开启。');return;}
    if(['expired','cancelled','error'].includes(status.status)){if(allowed())await d.say(ctx,'本次B站扫码未完成，可重新发送[B站登录]。');return;}
    timer=setTimeout(()=>{void poll();},2200);timer.unref?.();
   }catch{if(allowed())await d.say(ctx,'B站扫码检查未完成，旧登录态保留。');}
  }
  timer=setTimeout(()=>{void poll();},2200);timer.unref?.();
 }
 const control=createBilibiliController({...d,state,browse:exp.browse,share:exp.share,watch:exp.watch,sourceStatus:()=>exp.sourceStatus(),
  getAccountVersion:()=>auth.generation(),login:{status:auth.status,show},
  recentVideo:async ctx=>{
   if(ctx.quotedId){
    const msg=await d.quote(ctx);const source=extractVideoSource(msg.message||[])||state.cardReference(ctx.sourceKey,ctx.quotedId);
    if(!source||source.platform!=='bilibili')throw Error('引用中没有明确的B站链接，请带上BV号');return source.url;
   }
   const rows=[d.media()?.recentVideoSource(ctx),exp.recentVideoRef(ctx)].filter(v=>v&&normalizeBilibiliInput(v.url)).sort((a,b)=>b.at-a.at);return rows[0]?.url;
  }});
 let lastPrune=0;
 const prune=()=>{const at=(d.now||Date.now)();if(at-lastPrune>60000){results.prune();exp.prune();d.pruneEvents?.();lastPrune=at;}};
 return {...control,prune,quotedCardReference:ctx=>d.isAllowed(ctx.sourceKey)?state.cardReference(ctx.sourceKey,ctx.quotedId):null,tick:async()=>{prune();return control.tick();},auth,client,results,publicEvidenceAllowed:ref=>d.isPublicVideo?.(ref)||false,roleVersion,recentVideoResult:ctx=>results.recent(ctx),reference:input=>client.resolve(input),reserveReply:ctx=>replyQuota.take(ctx),replyQuota,chatContext:exp.chatContext,resolveBilibili:async url=>auth.read()?client.getSource(url):null};
}
