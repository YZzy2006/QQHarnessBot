import {utilityId,utilityText} from './utility-store.js';
import {rankRecords,safePublicLink} from './utility-content.js';
const COMMANDS=new Set(['群知识投稿','群知识审核','群知识待审','群知识','群知识详情','群知识过期','删除群知识','推荐歌曲','推荐电影','歌单','片单','评价推荐','删除推荐','抽一首歌','抽一部电影']);
export function createUtilityLibrary(d) {
  const now=d.now||Date.now;
  async function handle(ctx,cmd) {
    const c=cmd?.command,a=cmd?.args||[];
    if(!COMMANDS.has(c))return false;
    const owner=String(ctx.userId)===String(d.ownerQQ()),key=ctx.sourceKey;
    if(c.includes('群知识')&&!key.startsWith('group:'))throw Error('群知识请在对应白名单群里操作，不跨群读取');
    const find=(list,id)=>{const row=list.find(v=>v.id===id);if(!row)throw Error('未找到本会话的完整ID');return row;};
    if(c==='群知识投稿') {
      if(a.length!==1||!a[0])throw Error('引用同群原消息后发[群知识投稿][标题]');
      const q=await d.quote(ctx),text=utilityText(await d.readMessage(q),6000);
      if(!text)throw Error('引用消息没有可保存正文');
      const item={id:utilityId('k'),title:utilityText(a[0],80),text:d.redact(text),author:String(ctx.userId),sourceKey:key,messageId:String(ctx.quotedId),sourceAuthor:String(q.sender?.user_id||q.user_id||''),createdAt:now(),status:'pending'};
      d.store.editGroup(key,g=>{if(g.knowledge.length>=200)throw Error('本群知识已满');g.knowledge.push(item);});
      await d.say(ctx,'已投稿 '+item.id+'；管理员审核通过后才会进入公开查询。');
    } else if(c==='群知识审核'||c==='群知识过期') {
      if(!owner)throw Error('仅机器人管理员可审核或标记过期');
      if(c==='群知识审核'&&(a.length!==2||!['通过','拒绝'].includes(a[1])))throw Error('[群知识审核][k_完整ID][通过或拒绝]');
      if(c==='群知识过期'&&a.length!==1)throw Error('[群知识过期][k_完整ID]');
      d.store.editGroup(key,g=>{const k=find(g.knowledge,a[0]);k.status=c==='群知识过期'||a[1]==='拒绝'?'expired':'approved';k.reviewedAt=now();});
      await d.say(ctx,'已更新该条群知识状态，未修改引用原消息。');
    } else if(c==='群知识待审') {
      if(!owner)throw Error('仅机器人管理员可查看待审核投稿');
      const rows=d.store.group(key).knowledge.filter(k=>k.status==='pending').slice(0,10);
      await d.say(ctx,'【本群待审核】\n'+(rows.map(k=>k.id+' '+k.title+'\n'+k.text.slice(0,200)).join('\n')||'没有待审核投稿'));
    } else if(c==='群知识'||c==='群知识详情') {
      const rows=d.store.group(key).knowledge.filter(k=>k.status==='approved');
      const selected=c==='群知识详情'?[find(rows,a[0])]:rankRecords(rows,a[0],['title','text']);
      await d.say(ctx,'【本群知识】\n'+(selected.map(k=>k.id+' '+k.title+'\n'+k.text.slice(0,c==='群知识详情'?4000:600)+'\n来源：'+k.sourceKey+' 消息'+k.messageId).join('\n\n')||'没有找到已审核的知识；可引用原消息用[群知识投稿][标题]投稿。'));
    } else if(c==='删除群知识'||c==='删除推荐') {
      if(a.length!==2||a[1]!=='确认')throw Error('删除须完整ID及末尾[确认]');
      d.store.editGroup(key,g=>{const list=c==='删除群知识'?'knowledge':'media',item=find(g[list],a[0]);if(!owner&&item.author!==String(ctx.userId))throw Error('只能删除本人投稿');g[list]=g[list].filter(v=>v.id!==item.id);});
      await d.say(ctx,'已删除指定投稿，仅影响当前会话资料。');
    } else if(c==='推荐歌曲'||c==='推荐电影') {
      if(a.length<2||a.length>3)throw Error('格式：[推荐歌曲或推荐电影][标题][公开链接][推荐理由（可选）]');
      const url=safePublicLink(a[1]);await d.validateUrl(url);
      const item={id:utilityId('s'),kind:c==='推荐歌曲'?'song':'movie',title:utilityText(a[0],100),url,note:d.redact(utilityText(a[2],300)),author:String(ctx.userId),createdAt:now(),reviews:[]};
      if(!item.title)throw Error('请填写标题');
      d.store.editGroup(key,g=>{if(g.media.length>=200)throw Error('本会话歌单片单已满');g.media.push(item);});
      await d.say(ctx,'已收录 '+item.id+' '+item.title+'；标题和推荐理由来自投稿人，未核验平台评分。');
    } else if(c==='评价推荐') {
      if(a.length!==2||!a[1])throw Error('[评价推荐][s_完整ID][你的评价]');
      d.store.editGroup(key,g=>{const m=find(g.media,a[0]);const author=String(ctx.userId),text=d.redact(utilityText(a[1],300));const r=m.reviews.find(v=>v.author===author);if(r){r.text=text;r.at=now();}else {if(m.reviews.length>=50)throw Error('评价已满');m.reviews.push({author,text,at:now()});}});
      await d.say(ctx,'已保存你的评价，不会覆盖其他成员的评价。');
    } else {
      const kind=['歌单','抽一首歌'].includes(c)?'song':'movie';
      let rows=d.store.group(key).media.filter(v=>v.kind===kind);
      if(c.startsWith('抽'))rows=rows.length?[rows[Math.floor((d.random?.()??Math.random())*rows.length)]]:[];
      else rows=rankRecords(rows,a[0],['title','note']);
      await d.say(ctx,'【'+(kind==='song'?'共享歌单':'共享片单')+'】\n'+(rows.map(v=>v.id+' '+v.title+'\n'+v.url+'\n推荐理由：'+(v.note||'未填写')+'\n推荐人：'+v.author+(v.reviews.length?'\n群友评价：'+v.reviews.slice(-3).map(r=>r.text).join('；'):'')).join('\n\n')||'尚无符合条件的投稿'));
    }
    return true;
  }
  return {handle};
}
