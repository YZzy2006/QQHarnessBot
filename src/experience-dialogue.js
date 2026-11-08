import {extractVideoSource} from './media-sources.js';
const actor=ctx=>JSON.stringify([ctx.sourceKey,String(ctx.userId)]);
export function createExperienceDialogue({now=Date.now}={}){
  const states=new Map();
  function state(ctx){
    const key=actor(ctx),s=states.get(key)||{previews:[],at:now()};
    s.previews=s.previews.filter(v=>now()-v.at<=600000);
    if(s.batch&&now()-s.batch.at>900000)delete s.batch;
    if(s.watch&&now()-s.watch.at>900000)delete s.watch;
    if(s.write&&now()-s.write.at>600000)delete s.write;
    return s;
  }
  function save(ctx,s){for(const [k,v] of states)if(now()-v.at>900000)states.delete(k);if(states.size>=200&&!states.has(actor(ctx)))throw Error('对话操作上下文已满，请稍后重试');s.at=now();states.set(actor(ctx),s);}
  function observe(ctx,text){
    const s=state(ctx),id=/p_[a-f0-9]{12}/.exec(text)?.[0];
    const type=text.startsWith('【截图表格预览】')?'table':text.startsWith('【日历导入预览】')?'calendar':text.startsWith('【已结束日历清理预览】')?'cleanup':'';
    if(type&&id){s.previews=s.previews.filter(v=>v.id!==id);s.previews.push({id,type,at:now()});s.previews=s.previews.slice(-8);}
    const batch=/批次[：:]\s*(b_[a-f0-9]{12})/.exec(text)?.[1];if(batch&&/^已导入/.test(text))s.batch={id:batch,at:now()};
    const watch=/^已创建(?:更新订阅|网页订阅|异常监测)\s+(z_[a-f0-9]{12})/.exec(text)?.[1];if(watch)s.watch={id:watch,at:now()};
    if(type||batch||watch)save(ctx,s);
  }
  function consume(ctx,id){const s=state(ctx);s.previews=s.previews.filter(v=>v.id!==id);delete s.write;save(ctx,s);}
  function resolve(ctx,raw,{hasVideo=false,hasImage=false,hasArchivedVideo=false}={}){
    const text=String(raw||'').trim();if(!text||text.length>1600)return null;
    const hasLiveVideo=hasVideo;
    const videoTarget=/(?:这条|这段|这个|那条|那段|那个|昨天|前天|之前|前面|上次|刚才|刚刚)[^\n，,。！？!?]{0,35}(?:视频|录像|短片)/.test(text);
    const videoAction=/(?:^|[，,。！？!\s])(?:请|帮我|给我|麻烦你?|能不能|可以)?\s*(?:总结|概括|归纳|梳理|复盘|回顾|分析|解析|提取|列出|讲讲|说说|看看|看一下|看下|帮我看)/.test(text);
    const videoQuestion=/怎么|怎样|如何|什么|哪|谁|为何|为什么|说了啥|讲了啥|在说啥|看清|识别|有没有(?:时间戳|字幕|时间线)|(?:看|讲|说|做)(?:了)?[吗呢？?]/.test(text);
    const timePoint=/(?:^|[，,。\s])(?:第[零一二两三四五六七八九十\d]+(?:分钟?|秒)|\d{1,2}[:：][0-5]\d)|(?:在|到)[零一二两三四五六七八九十\d]+(?:分钟?|秒)(?:处|时|那里)/.test(text);
    const timeDetails=/时间戳|时间线|各时间点|各阶段|各时段/.test(text);
    const videoRequest=videoTarget&&((videoAction&&/(?:视频|录像|短片)/.test(text))||videoQuestion);
    hasVideo=hasLiveVideo||hasArchivedVideo&&videoTarget&&(videoRequest||timeDetails&&videoQuestion);
    hasImage=hasImage||ctx.message?.some(v=>v.type==='image')||!!ctx.quotedId&&/背景|人物|颜色|头发|发型|这张图|图片/.test(text);
    const s=state(ctx);
    if(ctx.sourceKey?.startsWith('group:')&&!ctx.directed&&!ctx.quotedId&&!hasVideo&&!hasImage&&!s.previews.length&&!s.write)return null;
    if(/^(?:取消这次操作|算了|先不操作)[。！! ]*$/.test(text)){delete s.write;save(ctx,s);return {reply:'已取消这次待确认操作。'};}
    const videoRecall=videoRequest||hasLiveVideo&&(timePoint&&videoQuestion||timeDetails&&(videoAction||videoQuestion||/^(?:时间戳|时间线)[？?]?$/.test(text))||/视频.*(?:讲(?:了|的)?什么|说(?:了|的)?什么|在说啥|什么内容)/.test(text));
    if(hasVideo&&(!hasImage||/视频/.test(text))&&videoRecall&&!/不要|不用|不必|(?:^|你|请|[，,。！？!\s])别(?:帮|给|把|将|再|总结|分析|看|说|发|讲|提)|教程|示例|他说|她说|例如|假如|如果|[“”「」『』]/.test(text)&&!extractVideoSource(text)&&!ctx.message?.some(v=>v.type==='video'||['json','xml','share'].includes(v.type)&&extractVideoSource(v)))return {command:'视频追问',args:[text.slice(0,500)],reuseOnly:true};
    if(/不要|不用|不必|别(?:帮|给|把|将|转|删|发)|怎么|如何|教程|示例|他说|她说|例如|假如|如果|[“”「」『』]/.test(text))return null;
    if(/^确认(?:导出|导入|清理|删除)?[。！! ]*$/.test(text)){
      if(s.write&&/删除|^确认[。！! ]*$/.test(text)){const cmd=s.write.cmd;delete s.write;save(ctx,s);return cmd;}
      const type=/导出/.test(text)?'table':/导入/.test(text)?'calendar':/清理/.test(text)?'cleanup':null;
      const rows=s.previews.filter(p=>!type||p.type===type);
      if(!rows.length)return null;
      if(rows.length!==1)return {reply:'有多个有效预览，请使用所选预览返回的完整ID确认，避免操作错误对象。'};
      const p=rows[0];return {command:{table:'导出表格',calendar:'确认日历导入',cleanup:'清理已结束日历'}[p.type],args:[p.id,'确认']};
    }
    if(/(?:删掉|删除|清除).*(?:刚才|最近).*(?:导入|那一批)|(?:刚才|最近).*导入.*(?:删掉|删除)/.test(text)&&s.batch){
      s.write={at:now(),cmd:{command:'删除日历批次',args:[s.batch.id,'确认']}};save(ctx,s);return {reply:'将删除你刚导入的独立日历批次 '+s.batch.id+'。回复“确认删除”才执行；可说“取消这次操作”。'};
    }
    if(/取消.*(?:刚才|这个|最近).*订阅/.test(text)&&s.watch){s.write={at:now(),cmd:{command:'取消订阅',args:[s.watch.id,'确认']}};save(ctx,s);return {reply:'将取消你的订阅 '+s.watch.id+'。回复“确认删除”才执行；可说“取消这次操作”。'};}
    if(/(?:清理|删除).*已结束.*(?:日历|事项)/.test(text))return {command:'清理已结束日历',args:[]};
    if(/(?:看|查|列出).*(?:我的)?日历批次/.test(text))return {command:'我的日历批次',args:[]};
    if(/(?:看|查|列出).*(?:我的)?(?:日历|日程)/.test(text))return {command:'我的日历',args:[]};
    if(/(?:看|查|列出).*我的订阅/.test(text))return {command:'我的订阅',args:[]};
    if(/(?:看看|查看|给我|查).*(?:今天|今日)的?安排/.test(text))return {command:'今日安排',args:[]};
    if(/(?:做成|转成|生成|给我).*(?:图文)?卡片/.test(text))return {command:'结果卡片',args:[]};
    if(/^(?:给我|查看|显示|发|发我)?(?:结果)?原文[。！! ]*$/.test(text))return {command:'结果原文',args:[]};
    if(/(?:把|将|帮我|请).*(?:截图|图片|这张图).*(?:表格|Excel|excel)|(?:把|将|帮我|请).*表格.*(?:Excel|excel)/.test(text))return {command:'截图转表格',args:[]};
    const file=/^(?:请|帮我)?(?:看看|看一下|问问)?这(?:份|个)(?:文件|文档)(?:里|中|的)?[：:，, ]*(.+)/.exec(text);
    if(file)return {command:'文件问答',args:[file[1]]};
    if(/(?:导入|添加).*日历/.test(text)&&ctx.quotedId)return {command:'日历导入',args:/提前\s*(\d+)\s*分钟/.test(text)?[/提前\s*(\d+)/.exec(text)[1]]:[]};
    if(/(?:导入|添加).*课(?:程)?表/.test(text)){
      const day=/\b(\d{4}-\d{2}-\d{2})\b/.exec(text)?.[1],weeks=/(?:共|总共|总周数[为是:： ]*)?\s*(\d{1,2})\s*周/.exec(text)?.[1],lead=/提前\s*(\d+)\s*分钟/.exec(text)?.[1]||'10';
      if(!day||!weeks)return {reply:'导入课表还需要学期首周周一的完整日期和总周数。例如引用课表说：“导入课表，2026-10-26开始，共16周，提前10分钟提醒”。不会猜测学校节次时间。'};
      return {command:'课程表导入',args:[day,weeks,lead]};
    }
    if(hasImage&&/回到原图|恢复原图|用原图/.test(text))return {command:'回到原图',args:[]};
    if(hasImage&&/上一版.*(?:更好|用|回)|(?:用|回到).*上一版/.test(text))return {command:'上一版',args:[]};
    if(hasImage&&/重新查看结果|(?:看看|查看|发一下).*(?:改好的图|当前版本|当前图片)/.test(text))return {command:'当前图片',args:[]};
    if(/^(?:请|帮我)?(?:改图|修图|修改图片)[：:，, ]*(.+)/.test(text))return {command:'改图',args:[text.replace(/^(?:请|帮我)?(?:改图|修图|修改图片)[：:，, ]*/,'')]};
    if(hasImage&&/图|背景|人物|颜色|头发|发型|亮|暗|风格|尺寸|画面|照片|文字|水印|裁剪|对比度|饱和度|清晰/.test(text)&&/(?:把|将|只|再|继续|保持|人物不变).*(?:改|换|调整|调亮|调暗|变亮|变暗|放大|缩小|裁剪|去掉|加上|保留|变成)/.test(text))return {command:'改图',args:[text]};
    const subscribe=/订阅.*(?:网页|页面|公告)/.test(text)?'订阅网页':/订阅.*(?:更新|RSS|Atom|rss|atom)/.test(text)?'订阅更新':/(?:异常监测|监测|监控).*(?:网站|地址|https?:)|异常监测/.test(text)?'异常监测':'';
    if(subscribe){const source=extractVideoSource(text,{allowPage:true});if(!source)return {reply:'请在请求中带上完整的公开HTTP/HTTPS地址。'};const interval=/(?:每隔?|间隔)\s*(\d+)\s*分钟/.exec(text)?.[1]||'15',keyword=/关键词[为是:： ]+([^\n]{1,50})/.exec(text)?.[1];return {command:subscribe,args:[source.url,interval,...(subscribe==='订阅网页'&&keyword?[keyword]:[])]};}
    const url=extractVideoSource(text);
    if(url&&(/看|视频|讲|解析|总结|分析|内容/.test(text)||ctx.directed))return {command:'看视频',args:[url.url,text.replace(url.url,'').trim().slice(0,500)||'概括视频内容']};
    if(hasVideo&&(!hasImage||/视频/.test(text))&&/(?:放大|看清|细看|再看).*(?:视频|画面|屏幕|字幕|细节)|(?:视频|画面|屏幕|字幕|细节).*(?:放大|看清|细看|再看)/.test(text))return {command:'视频追问',args:[text.slice(0,500)]};
    if(hasVideo&&(!hasImage||/视频/.test(text))&&/(?:屏幕|字幕|文字|型号|logo|标志|商标|按键).*(?:谁|什么|哪|写|看清|识别)|(?:识别|看清|读出).*(?:屏幕|字幕|文字|型号)/i.test(text))return {command:'视频追问',args:[text.slice(0,500)]};
    if(videoRequest&&(hasVideo||ctx.quotedId))return {command:'看视频',args:[text.slice(0,500)]};
    if(hasLiveVideo&&timePoint&&videoQuestion)return {command:'视频追问',args:[text.slice(0,500)],reuseOnly:true};
    const live=Array.isArray(ctx.message)?ctx.message:[];
    if(ctx.directed&&live.some(v=>v.type==='video'))return {command:'看视频',args:[text.slice(0,500)||'概括视频内容']};
    if(ctx.directed&&live.some(v=>['json','xml','share'].includes(v.type))&&extractVideoSource(live))return {command:'看视频',args:['概括视频内容']};
    return null;
  }
  return {observe,consume,resolve};
}
