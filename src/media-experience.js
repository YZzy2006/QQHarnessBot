import path from 'node:path';
import {normalizeBilibiliInput} from './bilibili-client.js';
import {VIDEO_RESULT_TTL} from './bilibili-results.js';
import {extractVideoSource,resolveVideoSource} from './media-sources.js';
import {withVideoEvidence,VIDEO_MAX_BYTES} from './video-reader.js';
import {MEDIA_LIMITS,assertMediaResources} from './media-resources.js';

export const MEDIA_COMMANDS=['看视频','重新看视频','视频追问','改图','上一版','回到原图','当前图片','清除媒体上下文','停止媒体处理'];
export const MEDIA_HELP='引用或直接发送视频/三平台分享后说“看看这段视频”；[看视频][链接][问题]，可接着问时间点；[重新看视频][链接]会明确重新分析并占用现有额度。引用图片说“改图：修改要求”，可继续修改、说“用上一版”“回到原图”。[清除媒体上下文]仅清除本人本会话缓存；[停止媒体处理]停止本次结果投递。';
export function createMediaExperience(d){
  const now=d.now||Date.now,cache=new Map(),operations=new Map(),rates=new Map(),cleared=new Set();let active=0;
  const actor=ctx=>JSON.stringify([ctx.sourceKey,String(ctx.userId)]);
  const modelText=value=>d.redact(String(value||'').replace(/https?:\/\/[^\s<>"']+/g,raw=>{try{const url=new URL(raw);url.search='';url.hash='';return url.href;}catch{return '[链接]';}}));
  const allowed=ctx=>d.isEnabled?.()!==false&&d.isAllowed(ctx.sourceKey);
  const weight=row=>(row.video?.buffer?.length||0)+(row.image?.versions||[]).reduce((n,v)=>n+v.buffer.length,0)+Buffer.byteLength(row.videoObservation?.summary||'')+Buffer.byteLength(row.videoObservation?.question||'');
  function prune(){for(const row of cache.values())if(row.videoObservation?.evidenceExpiresAt<=now()){delete row.videoObservation;if(row.video)row.video={platform:row.video.platform,bvid:row.video.bvid,page:row.video.page,displayUrl:row.video.displayUrl};}for(const [key,row] of cache)if(now()-row.at>900000&&!operations.has(key))cache.delete(key);for(const [key,at] of rates)if(now()-at>3600000)rates.delete(key);}
  function get(ctx){prune();return cache.get(actor(ctx));}
  function put(ctx,row){
    prune();const key=actor(ctx);row.at=now();
    while(cache.size>=32&&!cache.has(key)||[...cache].filter(([k])=>k!==key).reduce((n,[,v])=>n+weight(v),0)+weight(row)>MEDIA_LIMITS.cacheBytes){
      const old=[...cache].filter(([k])=>k!==key&&!operations.has(k)).sort((a,b)=>a[1].at-b[1].at)[0];
      if(!old)throw Error('媒体缓存繁忙，请稍后重试');cache.delete(old[0]);
    }
    cache.set(key,row);
  }
  function cancel(ctx){const key=actor(ctx),op=operations.get(key);if(op)op.cancelled=true;return !!op;}
  function context(ctx){const row=get(ctx),recall=!cleared.has(actor(ctx));return {hasVideo:!!row?.video||recall&&!!d.bilibili?.chatContext?.(ctx.sourceKey),hasArchivedVideo:recall&&!!d.bilibili?.recentVideoResult?.(ctx),hasImage:!!row?.image};}
  function chatContext(ctx){
    if(!allowed(ctx)||d.isMediaAllowed?.('video')===false)return null;
    const op=operations.get(actor(ctx));
    if(op?.kind==='video'&&!op.ready){
      if(op.cancelled)return null;
      if(op.roleVersion&&op.roleVersion!==d.bilibili?.roleVersion?.())return null;
      return {status:'processing',source:'video-processing',interimReplyAllowed:op.interimReplyAllowed,interimReplyMaxMessages:1,summary:'视频正在读取，内容还没有确认。这是内部状态，不是要发给用户的话；默认先等看完再接原问题。不要拿标题猜内容，也不要让用户先解释视频。',coverage:'尚无画面结论',at:op.startedAt,messageId:op.messageId,roleVersion:op.roleVersion};
    }
    const observation=get(ctx)?.videoObservation;
    if(!observation||now()-observation.at>900000)return null;
    if(observation.roleVersion&&observation.roleVersion!==d.bilibili?.roleVersion())return null;
    return {...observation,status:observation.status||'ready'};
  }
  async function sourceMessage(ctx){
    if(ctx.quotedId)return d.quote(ctx);
    if(Array.isArray(ctx.message)&&ctx.message.length)return {message:ctx.message};
    return {message:[]};
  }
  async function expensive(ctx,kind,fn){
    const key=actor(ctx);if(!allowed(ctx))throw Error('当前媒体功能或会话权限已关闭');
    if(operations.has(key)||active>=MEDIA_LIMITS.active)throw Error('媒体任务正在处理，请稍后再试');
    (d.checkMediaResources||assertMediaResources)();
    const rateKey=key+kind;if(rates.has(rateKey)&&now()-rates.get(rateKey)<15000)throw Error('媒体请求过于频繁，请15秒后再试');
    if(rates.size>=400&&!rates.has(rateKey))throw Error('媒体请求繁忙，请稍后重试');
    const op={cancelled:false,kind,startedAt:now(),messageId:String(ctx.messageId||ctx.quotedId||''),roleVersion:kind==='video'?d.bilibili?.roleVersion?.():null,interimReplyAllowed:kind==='video'&&(d.random||Math.random)()<0.15};operations.set(key,op);rates.set(rateKey,now());active++;
    const authorize=()=>allowed(ctx)&&d.isMediaAllowed?.(kind)!==false&&operations.get(key)===op&&!op.cancelled;
    if(!authorize()){operations.delete(key);active--;throw Error('当前媒体识别或图片编辑权限未启用');}
    try{return await fn(authorize);}catch(e){if(kind==='video'&&e.code==='VIDEO_SOURCE_MISSING')rates.delete(rateKey);throw e;}finally{if(operations.get(key)===op)operations.delete(key);active--;prune();}
  }
  async function reuseBilibili(ctx,ref,options={},innerAuthorize){
    if(options.forceReload||!ref?.bvid||!d.bilibili?.results)return null;
    const cached=d.bilibili.results.lookup(ctx,ref)||(ref.analyzed===false?{summary:ref.summary,coverage:ref.coverage}:null);if(!cached)return null;
    const authorize=()=>allowed(ctx)&&d.isMediaAllowed?.('video')!==false&&options.authorize?.()!==false&&(!innerAuthorize||innerAuthorize());
    if(!authorize())throw Error('视频结果复用权限已变化');
    const summary=cached.summary||'这个视频之前已分析过；当前没有可复用的采样资料，本次不重新下载或调用视频分析，也不猜测未覆盖的细节；如确实要重看，可明确发[重新看视频][链接]，会占用分析额度。';
    if(options.publish===false)return {summary,reused:true};
    const previous=get(ctx)||{},observation={summary,question:modelText(options.reuseQuestion||'').slice(0,500),coverage:cached.coverage,at:now(),messageId:String(ctx.messageId||ctx.quotedId||''),roleVersion:d.bilibili.roleVersion(),reused:true,source:'bilibili-reused-observation'};
    observation.status=cached.summary?(/采样画面/.test(cached.coverage||'')||cached.summary.startsWith('【视频理解】')?'ready':'metadata'):'receipt';
    if(cached.summary){observation.evidenceExpiresAt=(cached.analyzedAt??cached.at??now())+VIDEO_RESULT_TTL;if(cached.publicEvidence)d.bilibili.results.save(ctx,ref,{...cached,analyzedAt:cached.analyzedAt??cached.at});}
    put(ctx,{...previous,video:{platform:'bilibili',bvid:ref.bvid,page:ref.page||1,displayUrl:'https://www.bilibili.com/video/'+ref.bvid+(ref.page>1?'?p='+ref.page:'')},videoObservation:observation});
    const op=operations.get(actor(ctx));if(op)op.ready=true;
    d.rememberResult?.(ctx,summary);
    if(typeof d.onVideoResult==='function')await d.onVideoResult(ctx,{...observation,authorize,replyRequested:true});
    else await d.say(ctx,summary,{plain:true});
    return {summary,reused:true};
  }
  async function video(ctx,args,followup,options={}){
    if(args.length>2)throw Error('[看视频][链接][问题]，或引用视频后[看视频][问题]');
    if(!allowed(ctx)||d.isMediaAllowed?.('video')===false)throw Error('当前视频功能或会话权限已关闭');
    options={...options,reuseQuestion:normalizeBilibiliInput(args[0])?args[1]||'':args.at(-1)||''};
    const incoming=extractVideoSource(args[0]||'')||extractVideoSource(ctx.message||[]);
    let archived=null;
    const liveVideo=get(ctx)?.video;
    if(options.reuseOnly&&!ctx.quotedId&&!incoming&&(!liveVideo||liveVideo.platform==='bilibili')&&(/(?:昨天|前天|之前|前面|上次|那条|那段).*视频|视频.*(?:昨天|前天|之前|上次)/.test(options.reuseQuestion)||!liveVideo&&/视频/.test(options.reuseQuestion))&&d.bilibili?.results?.find)archived=d.bilibili.results.find(ctx,options.reuseQuestion);
    const attached=ctx.message?.some(v=>v.type==='video'||v.type==='file'&&/\.(mp4|mov|m4v|webm|mkv|avi|flv)$/i.test(v.data?.name||''));
    const known=options.resolved||archived||((!ctx.quotedId||followup||options.reuseOnly)&&!incoming&&!attached&&!cleared.has(actor(ctx))?(get(ctx)?.video||d.bilibili?.chatContext?.(ctx.sourceKey)||d.bilibili?.recentVideoResult?.(ctx)):null);
    let direct=normalizeBilibiliInput(incoming?.url||args[0]);
    if(!ctx.quotedId&&direct?.short&&d.bilibili?.reference)direct=await d.bilibili.reference(direct.url);
    if(incoming)cleared.delete(actor(ctx));
    let prefetchedMessage,selected=known;
    if(ctx.quotedId&&known&&!incoming&&!attached&&(followup||options.reuseOnly)){
      // Validate quote ownership even when it is ordinary chat; a real different video wins.
      prefetchedMessage=await sourceMessage(ctx);
      const quoted=extractVideoSource(prefetchedMessage.message||[])||d.bilibili?.quotedCardReference?.(ctx),segment=prefetchedMessage.message?.some(v=>v.type==='video'||v.type==='file'&&/\.(mp4|mov|m4v|webm|mkv|avi|flv)$/i.test(v.data?.name||''));
      if(quoted||segment){selected=null;direct=normalizeBilibiliInput(quoted?.url);followup=false;}
    }
    if((!ctx.quotedId||incoming||prefetchedMessage)&&direct?.short&&d.bilibili?.reference)direct=await d.bilibili.reference(direct.url);
    if(!ctx.quotedId||incoming||prefetchedMessage){const reused=await reuseBilibili(ctx,direct?.bvid?direct:selected,options);if(reused)return reused;}
    if(options.reuseOnly&&selected&&!selected.bvid){
      const previous=get(ctx),old=previous?.videoObservation;
      if(!old?.summary||old.roleVersion&&old.roleVersion!==d.bilibili?.roleVersion?.())throw Error('当前视频没有可复用的采样资料，本次未重新分析，请明确提供要看的原视频');
      const authorize=()=>allowed(ctx)&&d.isMediaAllowed?.('video')!==false&&options.authorize?.()!==false&&(!old.roleVersion||old.roleVersion===d.bilibili?.roleVersion?.());
      if(!authorize())throw Error('视频结果复用权限已变化');
      const observation={...old,at:now(),question:modelText(options.reuseQuestion).slice(0,500),messageId:String(ctx.messageId||''),reused:true,source:'video-reused-observation'};
      put(ctx,{...previous,videoObservation:observation});d.rememberResult?.(ctx,old.summary);
      if(typeof d.onVideoResult==='function')await d.onVideoResult(ctx,{...observation,authorize,replyRequested:true});else await d.say(ctx,old.summary,{plain:true});
      return {summary:old.summary,reused:true};
    }

    return await expensive(ctx,'video',async innerAuthorize=>{
      let initialRole=d.bilibili?.roleVersion&&incoming?.platform==='bilibili'?d.bilibili.roleVersion():null;
      const authorize=()=>innerAuthorize()&&(options.authorize?.()!==false)&&(!initialRole||d.bilibili.roleVersion()===initialRole);
      if(typeof d.analyzeVideo!=='function')throw Error('当前未配置视频理解适配器');
      let info,reserved=false,biliRef=null,question=String(args.at(-1)||'概括视频内容');
      const first=args[0]&&extractVideoSource(args[0],{allowPage:true}),row=get(ctx)||{};
      if(options.resolved){
        if(!authorize())throw Error('B站视频已取消');
        biliRef=options.resolved.bvid?{bvid:options.resolved.bvid,page:options.resolved.page||1}:null;
        if(biliRef&&d.bilibili?.roleVersion)initialRole??=d.bilibili.roleVersion();
        const reused=await reuseBilibili(ctx,biliRef,options,authorize);if(reused)return reused;
        if(options.quotaSource!=='browse'){if(biliRef&&d.bilibili?.reserveReply)await d.bilibili.reserveReply(ctx);else await d.reserveVideo?.(ctx);}reserved=true;
        const value=await d.downloadVideo(options.resolved.mediaUrl,VIDEO_MAX_BYTES,{referer:'https://www.bilibili.com/'});
        info={...options.resolved,buffer:value.buffer};delete info.mediaUrl;
      }else if(followup){info=row.video;if(!info)throw Object.assign(Error('没有你在本会话的有效视频上下文，请重新发送或引用视频'),{code:'VIDEO_SOURCE_MISSING'});}
      else{
        const msg=first?null:prefetchedMessage||await sourceMessage(ctx),segment=msg?.message?.find(v=>v.type==='video'||v.type==='file'&&/\.(mp4|mov|m4v|webm|mkv|avi|flv)$/i.test(v.data?.name||''));
        const shared=first||(ctx.quotedId?d.bilibili?.quotedCardReference?.(ctx):null)||extractVideoSource(msg?.message||[],{allowPage:args.length>0});
        if(first)question=String(args[1]||'概括视频内容');
        if(!authorize())throw Error('读取期间媒体请求已取消或权限变化');
        if(shared?.platform==='bilibili'&&d.bilibili?.reference){
          biliRef=direct?.bvid?direct:await d.bilibili.reference(shared.url);initialRole??=d.bilibili.roleVersion();
          const reused=await reuseBilibili(ctx,biliRef,options,authorize);if(reused)return reused;
        }
        if(!segment&&!shared&&!(row.video&&!ctx.quotedId))throw Object.assign(Error('请发送/引用原视频，或提供B站、抖音、小红书分享链接；本次没有读取到视频'),{code:'VIDEO_SOURCE_MISSING'});
        if(biliRef&&d.bilibili?.reserveReply)await d.bilibili.reserveReply(ctx);else await d.reserveVideo?.(ctx);reserved=true;
        if(segment){
          const value=await d.readVideoSegment?.(segment.data||{});if(!value?.buffer)throw Error('无法取得QQ视频字节，请重新发送原视频或公开下载链接');
          info={buffer:value.buffer,title:'QQ视频附件',description:'',displayUrl:'QQ原消息',platform:'attachment'};
        }else if(shared){
          const resolved=await resolveVideoSource(shared,{fetchPage:d.fetchPublic,resolveBilibili:d.resolveBilibili});
          const referer={bilibili:'https://www.bilibili.com/',douyin:'https://www.douyin.com/',xiaohongshu:'https://www.xiaohongshu.com/'}[resolved.platform]||'';
          const value=await d.downloadVideo(resolved.mediaUrl,VIDEO_MAX_BYTES,{referer});
          info={...resolved,buffer:value.buffer};delete info.url;delete info.mediaUrl;
        }else if(row.video&&!ctx.quotedId){info=row.video;}
        else throw Error('请发送/引用原视频，或提供B站、抖音、小红书分享链接；本次没有读取到视频');
      }
      if(!Buffer.isBuffer(info.buffer)||info.buffer.length>VIDEO_MAX_BYTES)throw Error('视频超过'+VIDEO_MAX_BYTES/1024/1024+'MiB，未提交模型，请先裁剪');
      if(!authorize())throw Error('视频请求已取消或权限变化');
      if(!reserved)await d.reserveVideo?.(ctx);
      const process=d.withVideoEvidence||withVideoEvidence;
      const result=await process(info.buffer,{tempRoot:path.join(d.stateDir,'media-tmp'),question,authorize},async evidence=>{
        let transcript=Array.isArray(info.subtitles)?info.subtitles.map(v=>'['+v.from+'-'+v.to+'] '+v.text).join('\n').slice(0,18000):'',audioStatus='无音轨转写，仅分析采样画面';
        if(transcript)audioStatus='含B站字幕轨文字，字幕不代表画面逐帧观看';
        if(!transcript&&evidence.audio&&d.transcribeVideo){
          try{
            transcript=modelText(await d.transcribeVideo(evidence.audio.buffer,ctx));
            audioStatus=transcript?'音轨转写范围：'+Math.floor(evidence.audio.start)+'~'+Math.ceil(evidence.audio.end)+'秒':'本段音轨未识别出可用文字，仅分析采样画面';
          }catch(error){
            const empty=error?.code==='ASR_EMPTY_TRANSCRIPT'||error?.message==='ASR 返回空文本';
            audioStatus=empty?'本段音轨未识别出可用文字，仅分析采样画面':'音轨转写不可用，仅分析采样画面';
            d.audit?.('[video-asr] '+(empty?'empty-transcript':'unavailable'));
          }
        }
        if(!authorize())throw Error('视频请求已取消或权限变化');
        const answer=await d.analyzeVideo(evidence,{question:modelText(question),title:modelText(info.title),description:modelText(info.description),transcript,sourceKey:ctx.sourceKey});
        return '【视频理解】'+d.redact(info.title||'视频')+'\n'+d.redact(String(answer))+'\n\n来源：'+(info.displayUrl||'QQ原消息')+'\n覆盖范围：'+evidence.coverage+'；'+audioStatus+'。';
      });
      if(!authorize())throw Error('视频请求已取消或权限变化');
      const analyzedAt=now();
      const publicEvidence=!!biliRef&&question==='概括视频内容'&&await d.bilibili?.publicEvidenceAllowed?.(biliRef)===true;
      if(!authorize())throw Error('视频请求已取消或权限变化');
      const videoObservation={status:'ready',analyzedAt,evidenceExpiresAt:analyzedAt+VIDEO_RESULT_TTL,summary:modelText(result).slice(0,3500),question:(first?args[1]:args.at(-1))?modelText(question).slice(0,500):'',at:now(),messageId:String((followup?row.videoObservation?.messageId:ctx.quotedId)||ctx.messageId||'')};
      if(biliRef&&d.bilibili?.results){
        info.bvid=biliRef.bvid;info.page=biliRef.page||1;
        videoObservation.roleVersion=d.bilibili.roleVersion();
        d.bilibili.results.save(ctx,biliRef,{summary:videoObservation.summary,analyzedAt,publicEvidence,title:info.title||info.candidate?.title,cover:info.cover||info.candidate?.cover,coverage:'仅已分析的受限采样画面/字幕，未覆盖处不得猜测'});
      }
      if(options.publish===false)return {summary:result,analyzedAt,publicEvidence};
      put(ctx,{...row,video:info,videoObservation});operations.get(actor(ctx)).ready=true;
      d.rememberResult?.(ctx,result);
      if(typeof d.onVideoResult==='function'){
        if(authorize())await d.onVideoResult(ctx,{...videoObservation,authorize,replyRequested:true});
      }else await d.say(ctx,result,{plain:true});
    });
  }
  async function edit(ctx,args){
    if(args.length!==1||!String(args[0]).trim()||args[0].length>800)throw Error('[改图][明确修改要求]，请先发送或引用原图');
    await expensive(ctx,'image',async authorize=>{
      const row=get(ctx)||{};let session=row.image;
      const selectedQuote=session&&ctx.quotedId?session.versions.findIndex(v=>v.messageId!=null&&String(v.messageId)===String(ctx.quotedId)):-1;
      if(ctx.message?.some(v=>v.type==='image')||ctx.quotedId&&!(selectedQuote>=0)||!session){
        const msg=await sourceMessage(ctx),image=await d.readImageMessage?.(msg);
        if(!image?.buffer||image.buffer.length>6*1024*1024)throw Error('没有读取到6MiB以内的原图，请发送或引用图片后重试');
        session={versions:[{buffer:image.buffer,mimeType:image.mimeType,messageId:ctx.quotedId||ctx.messageId}],selected:0};
      }else if(selectedQuote>=0)session.selected=selectedQuote;
      if(!authorize())throw Error('图片读取期间请求已取消或权限变化');
      put(ctx,{...row,image:session});
      const references=session.selected===0?[session.versions[0]]:[session.versions[0],session.versions[session.selected]];
      const result=await d.editImage({references,prompt:d.redact(args[0]),ctx,authorize});
      if(!authorize())throw Error('图片编辑已完成但本次投递已取消或权限变化，不会自动再次生成');
      if(!Buffer.isBuffer(result?.buffer)||result.buffer.length>6*1024*1024)throw Error('图片编辑结果超过缓存或发送预算，不自动重做');
      const next={...session,versions:[...session.versions,result]};
      while(next.versions.length>3)next.versions.splice(1,1);next.selected=next.versions.length-1;
      put(ctx,{...get(ctx),image:next});
      try{
        const sent=await d.sendImage(ctx.sourceKey,result.buffer,authorize);if(sent===false)throw Error('unknown');
        next.versions[next.selected].messageId=sent?.messageId;
      }catch{throw Error('图片已编辑，发送回执不明；不自动重发或重新生成。可明确请求上一版或重新查看结果。');}
      await d.say(ctx,'已按本次要求修改图片。可继续说修改要求，或说“用上一版”“回到原图”；本会话本人缓存15分钟，不写入聊天记忆。');
    });
  }
  async function handle(ctx,cmd){
    if(!MEDIA_COMMANDS.includes(cmd?.command))return false;
    if(!allowed(ctx))throw Error('媒体功能或会话权限已关闭');
    const a=cmd.args||[],key=actor(ctx);
    if(cmd.command==='停止媒体处理'){cancel(ctx);await d.say(ctx,'已停止本次媒体结果投递；已提交的模型请求可能仍产生费用，不自动重试。');}
    else if(cmd.command==='清除媒体上下文'){cancel(ctx);cache.delete(key);cleared.add(key);if(cleared.size>400)cleared.delete(cleared.values().next().value);await d.say(ctx,'已清除你在当前会话的短期媒体上下文，不影响原任务和聊天记忆。');}
    else if(['看视频','重新看视频','视频追问'].includes(cmd.command))await video(ctx,a,cmd.command==='视频追问',{reuseOnly:cmd.reuseOnly===true,forceReload:cmd.command==='重新看视频'});
    else if(cmd.command==='改图')await edit(ctx,a);
    else{
      if(a.length)throw Error('版本选择无需参数');
      const row=get(ctx),session=row?.image;if(!session)throw Error('没有你在本会话的有效图片版本');
      const index=cmd.command==='回到原图'?0:cmd.command==='当前图片'?session.selected:Math.max(0,session.selected-1);session.selected=index;row.at=now();
      const sent=await d.sendImage(ctx.sourceKey,session.versions[index].buffer,()=>allowed(ctx)&&get(ctx)?.image===session);
      if(sent===false)throw Error('图片版本未确认送达，不自动重发');
      await d.say(ctx,index===0?'已选回原图，后续修改以原图为基础。':'已选回上一版，后续修改以此版本为基础。');
    }
    return true;
  }
  return {handle,context,chatContext,canRecallVideo:ctx=>!cleared.has(actor(ctx)),cancel,observeResolved:(ctx,info,opts={})=>video(ctx,[],false,{resolved:info,publish:false,...opts}),recentVideoUrl:ctx=>get(ctx)?.video?.displayUrl,recentVideoSource:ctx=>{const v=get(ctx);return v?.video?{url:v.video.displayUrl,at:v.videoObservation?.at||v.at}:null;},isBusy:ctx=>operations.has(actor(ctx)),tick:prune,stats:()=>({entries:cache.size,bytes:[...cache.values()].reduce((n,v)=>n+weight(v),0),active})};
}
