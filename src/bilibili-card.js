import {normalizeBilibiliInput} from './bilibili-client.js';
const short=(value,n)=>Array.from(String(value||'').toWellFormed().replace(/[\u0000-\u001f]/g,' ').trim()).slice(0,n).join('');

export function bilibiliCover(raw){
 try{
  const u=new URL(String(raw||'').replace(/^\/\//,'https://'));
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port||!(u.hostname==='hdslb.com'||u.hostname.endsWith('.hdslb.com')))return '';
  u.protocol='https:';u.search='';u.hash='';return u.href;
 }catch{return '';}
}

export function bilibiliShareSegments(card){
 const ref=normalizeBilibiliInput(card?.url),title=short(card?.title,180),cover=bilibiliCover(card?.image);
 if(!ref?.bvid||!title)throw Error('视频分享缺少有效的B站链接或标题');
 if(!cover)throw Error('视频封面不可用，本次未发送');
 return[
  {type:'text',data:{text:'【'+title+'】\n'}},
  {type:'image',data:{file:cover}},
  {type:'text',data:{text:'\n'+ref.url}}
 ];
}

export function verifyBilibiliShareDelivery(history,expected,{kind,targetId,selfId,messageId,notBefore}={}){
 const expectedText=expected.filter(s=>s.type==='text').map(s=>s.data.text).join('');
 for(const m of Array.isArray(history?.messages)?history.messages:[]){
  if(Number(m.message_id)!==Number(messageId)||m.message_type!==kind||Number(m.sender?.user_id??m.user_id)!==Number(selfId))continue;
  if(kind==='private'?Number(m.target_id)!==Number(targetId):Number(m.group_id)!==Number(targetId))continue;
  if(!(Number(m.time)>0)||Number(m.time)*1000<notBefore-5000)continue;
  const segments=Array.isArray(m.message)?m.message:[];
  const actualText=segments.filter(s=>s.type==='text').map(s=>String(s.data?.text||'')).join('');
  if(actualText===expectedText&&segments.filter(s=>s.type==='image').length===1&&segments.length===expected.length)return true;
 }
 throw Object.assign(Error('图文已提交，但会话历史未确认完整标题、封面与链接；未自动重发'),{code:'BILIBILI_SHARE_HISTORY_UNKNOWN'});
}
