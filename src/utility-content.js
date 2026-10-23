export function checkedQuote(ctx,msg) {
  if(!msg||!Array.isArray(msg.message))throw Error('无法读取被引用的消息');
  const [kind,id]=ctx.sourceKey.split(':');
  if(kind==='group') {if(String(msg.group_id)!==id)throw Error('引用不属于当前会话');}
  else {
    const sender=String(msg.sender?.user_id??msg.user_id??'');
    const peer=String(msg.target_id??msg.peer_id??'');
    if(msg.group_id||!(sender===id||(peer===id&&sender===String(ctx.selfId||''))))throw Error('引用不属于当前会话');
  }
  return msg;
}
export function weekStart(at=Date.now()) {
  const shifted=new Date(at+8*3600000);
  return Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate())-8*3600000-((shifted.getUTCDay()+6)%7)*86400000;
}
export function compareDocuments(oldText,newText) {
  const a=String(oldText).replace(/\r\n?/g,'\n').slice(0,20000).split('\n').slice(0,600);
  const b=String(newText).replace(/\r\n?/g,'\n').slice(0,20000).split('\n').slice(0,600);
  const truncated=[oldText,newText].some(v=>String(v).length>20000||String(v).split('\n').length>600);
  const dp=Array.from({length:a.length+1},()=>new Uint16Array(b.length+1));
  for(let i=a.length-1;i>=0;i--)for(let j=b.length-1;j>=0;j--)dp[i][j]=a[i]===b[j]?1+dp[i+1][j+1]:Math.max(dp[i+1][j],dp[i][j+1]);
  const edits=[];let i=0,j=0,added=0,removed=0;
  while(i<a.length||j<b.length) {
    if(i<a.length&&j<b.length&&a[i]===b[j]){i++;j++;}
    else if(j<b.length&&(i===a.length||dp[i][j+1]>=dp[i+1][j])){added++;if(edits.length<40)edits.push('新增（新版第'+(j+1)+'行）：'+b[j].slice(0,180));j++;}
    else {removed++;if(edits.length<40)edits.push('删除（旧版第'+(i+1)+'行）：'+a[i].slice(0,180));i++;}
  }
  return ['【文件对比】本次纳入旧版'+a.length+'行、新版'+b.length+'行；每份最多20000字符/600行。',
    truncated?'覆盖范围已截断，不能据此断言全文相同。':'本次输入在上述范围内完整纳入。',
    added||removed?'新增'+added+'行，删除'+removed+'行（逐行内容比较，不代表版式比较）':'纳入范围内没有发现文本变化。',
    ...edits,...(added+removed>40?['差异较多，仅展示前40项。']:[])].join('\n');
}
export function parseTaskPreview(raw) {
  const cleaned=String(raw).trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/g,'');
  let data;try{data=JSON.parse(cleaned);}catch{throw Error('截图未返回可核验的待办格式，请换清晰图片重试');}
  if(!Array.isArray(data.tasks)||!data.tasks.length||data.tasks.length>10)throw Error('截图待办须为1~10项');
  return data.tasks.map(t=>{if(typeof t.text!=='string'||!t.text.trim()||t.text.length>500||t.dueText!=null&&typeof t.dueText!=='string')throw Error('截图待办内容不完整');return {text:t.text.trim(),dueText:String(t.dueText||'').trim().slice(0,80)};});
}
export function safePublicLink(raw) {
  const u=new URL(raw);
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||/^(localhost|127\.|0\.|10\.|192\.168\.|\[|169\.254\.)/i.test(u.hostname)||u.hostname.endsWith('.local'))throw Error('请提供公开网页链接');
  return u.href;
}
export function rankRecords(rows,query,fields=['title','text']) {
  const q=String(query||'').trim().toLowerCase();
  const terms=q.split(/[\s,，]+/).filter(Boolean);
  return rows.map(item=>({item,score:fields.reduce((n,k)=>{const t=String(item[k]||'').toLowerCase();return n+(q&&t.includes(q)?10:0)+terms.filter(v=>t.includes(v)).length;},0)}))
    .filter(v=>!q||v.score>0).sort((a,b)=>b.score-a.score||(b.item.createdAt||0)-(a.item.createdAt||0)).slice(0,10).map(v=>v.item);
}
