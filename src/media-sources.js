// Public share-page compatibility adapters. Never execute page scripts or bypass login.
import {isIP} from 'node:net';
import {isPrivateIp,safeFetch} from './safe-fetch.js';

function publicUrl(raw,base){
  let u;try{u=new URL(raw,base);}catch{throw Error('媒体地址无效');}
  const h=u.hostname.replace(/^\[|\]$/g,'').toLowerCase();
  if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.port&&!['80','443'].includes(u.port)||h==='localhost'||h.endsWith('.localhost')||h.endsWith('.local')||isIP(h)&&isPrivateIp(h))throw Error('只支持公开HTTP/HTTPS媒体，拒绝内网、本机或带凭据地址');
  return u.href;
}
const hostIs=(h,base)=>h===base||h.endsWith('.'+base);
function platformFor(u){
  const h=u.hostname.toLowerCase();
  if(hostIs(h,'bilibili.com')||h==='b23.tv')return 'bilibili';
  if(hostIs(h,'douyin.com')||hostIs(h,'iesdouyin.com'))return 'douyin';
  if(hostIs(h,'xiaohongshu.com')||hostIs(h,'xhslink.com'))return 'xiaohongshu';
  return /\.(?:mp4|mov|m4v|webm|mkv|avi|flv)(?:$|\/)/i.test(u.pathname)?'direct':null;
}
export function displayMediaUrl(raw){const u=new URL(publicUrl(raw));u.search='';u.hash='';return u.href;}
function strings(input,out=[],depth=0){
  if(depth>8||out.length>=100)return out;
  if(typeof input==='string'){
    if(input.length>65536)return out;
    out.push(input);
    if(/^[\s]*[\[{]/.test(input))try{strings(JSON.parse(input),out,depth+1);}catch{}
  }else if(Array.isArray(input)){for(const x of input.slice(0,32))strings(x,out,depth+1);}
  else if(input&&typeof input==='object'){for(const value of Object.values(input).slice(0,32))strings(value,out,depth+1);}
  return out;
}
export function extractVideoSource(input,{allowPage=false}={}){
  if(typeof input==='string'&&/^BV[A-Za-z0-9]{10}$/.test(input.trim()))return {platform:'bilibili',url:'https://www.bilibili.com/video/'+input.trim(),displayUrl:'https://www.bilibili.com/video/'+input.trim()};
  for(const text of strings(input))for(const found of text.matchAll(/https?:\/\/[^\s<>"'\]\[{}]+/gi)){
    const raw=found[0].replace(/[，。；！、）)]+$/,'').replace(/&amp;/g,'&');
    let u;try{u=new URL(raw);}catch{continue;}
    const platform=platformFor(u);if(!platform&&!allowPage)continue;
    return {platform:platform||'page',url:publicUrl(u.href),displayUrl:displayMediaUrl(u.href)};
  }
  return null;
}
export function hasVideoShare(input){try{return !!extractVideoSource(input);}catch{return false;}}
// Give chat the public share metadata without leaking miniapp tokens/tracking.
// A title is never treated as video observation or as a user's tool instruction.
export function describeVideoShare(segment){
  let source;try{source=extractVideoSource(segment);}catch{return null;}
  if(!source)return null;
  let data=segment?.data?.data??segment?.data??segment;
  if(typeof data==='string'&&data.length<=65536)try{data=JSON.parse(data);}catch{data=null;}
  const detail=data?.meta?.detail_1,news=data?.meta?.news;
  const rawTitle=detail?.desc||news?.title||data?.title||data?.desc||'';
  const title=Array.from(String(rawTitle).toWellFormed().replace(/[\u0000-\u001f<>]/g,' ').replace(/https?:\/\/\S+/gi,'[链接]').trim()).slice(0,160).join('');
  const platform={bilibili:'B站',douyin:'抖音',xiaohongshu:'小红书',direct:'公开视频'}[source.platform]||'视频';
  return '['+platform+'视频分享'+(title?'：'+title:'')+']\n'+source.displayUrl+'\n[以上为分享信息，画面内容以实际读取资料为准]';
}

function renderData(html){
  const raw=/<script\b[^>]*id=["']RENDER_DATA["'][^>]*>([^<]{1,600000})<\/script>/i.exec(html)?.[1];
  if(!raw)return null;try{return JSON.parse(decodeURIComponent(raw));}catch{return null;}
}
function jsonState(html,name){
  const start=html.search(new RegExp('(?:window\\.)?'+name+'\\s*='));if(start<0)return null;
  const eq=html.indexOf('=',start);let begin=eq+1;while(/\s/.test(html[begin]||''))begin++;
  if(!['{','['].includes(html[begin]))return null;
  let depth=0,quoted=false,escaped=false,out='';
  for(let i=begin;i<html.length&&i-begin<600000;i++){
    const ch=html[i];
    if(quoted){out+=ch;if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;continue;}
    if(ch==='"'){quoted=true;out+=ch;continue;}
    if(html.startsWith('undefined',i)&&!/[\w$]/.test(html[i-1]||'')&&!/[\w$]/.test(html[i+9]||'')){out+='null';i+=8;continue;}
    if(ch==='{'||ch==='['){if(++depth>64)throw Error('分享页面嵌套过深');}
    if(ch==='}'||ch===']')depth--;
    out+=ch;if(depth===0){try{return JSON.parse(out);}catch{return null;}}
  }
  return null;
}
function findObjects(value,predicate,depth=0,out=[]){
  if(!value||typeof value!=='object'||depth>12||out.length>100)return out;
  if(predicate(value))out.push(value);
  for(const v of Object.values(value).slice(0,100))if(v&&typeof v==='object')findObjects(v,predicate,depth+1,out);
  return out;
}
function meta(html,key){
  for(const tag of html.matchAll(/<meta\b[^>]{0,4000}>/gi)){
    const attrs={};for(const m of tag[0].matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/gs))attrs[m[1].toLowerCase()]=m[3];
    if((attrs.property||attrs.name||'').toLowerCase()===key)return String(attrs.content||'').replace(/&amp;/g,'&').replace(/&quot;/g,'"');
  }
  return '';
}
export function parseVideoPage(html,platform,url){
  if(typeof html!=='string'||html.length>600000)throw Error('分享页面超过解析范围');
  let mediaUrl='',title='',description='',bvid='',cid='';
  if(platform==='bilibili'){
    const initial=jsonState(html,'__INITIAL_STATE__'),play=jsonState(html,'__playinfo__');
    const v=initial?.videoData||{};title=v.title||'';description=v.desc||'';bvid=v.bvid||'';cid=v.cid||'';
    mediaUrl=play?.data?.durl?.[0]?.url||play?.data?.dash?.video?.[0]?.baseUrl||play?.data?.dash?.video?.[0]?.base_url||'';
  }else if(platform==='douyin'){
    const state=jsonState(html,'_ROUTER_DATA')||jsonState(html,'__INITIAL_STATE__')||renderData(html);
    const rows=findObjects(state,v=>v.video&&(v.desc!=null||v.aweme_id!=null||v.awemeId!=null));
    const wanted=/\/(?:video|note)\/(\d+)/.exec(new URL(url).pathname)?.[1];
    const v=rows.find(v=>String(v.aweme_id||v.awemeId)===wanted)||(rows.length===1&&(!wanted||!(rows[0].aweme_id||rows[0].awemeId))?rows[0]:null);
    title=v?.desc||'';mediaUrl=v?.video?.play_addr?.url_list?.[0]||v?.video?.playAddr?.[0]?.src||v?.video?.playAddr?.src||v?.video?.download_addr?.url_list?.[0]||'';
  }else if(platform==='xiaohongshu'){
    const state=jsonState(html,'__INITIAL_STATE__'),notes=state?.note?.noteDetailMap||{};
    const wanted=/\/(?:explore|discovery\/item)\/([^/?]+)/.exec(new URL(url).pathname)?.[1];
    const rows=Object.values(notes).map(v=>v?.note).filter(Boolean);
    const v=notes[wanted]?.note||rows.find(v=>v.noteId===wanted)||(!wanted&&rows.length===1?rows[0]:null);
    title=v?.title||'';description=v?.desc||'';
    mediaUrl=v?.video?.media?.stream?.h264?.[0]?.masterUrl||v?.video?.media?.stream?.h265?.[0]?.masterUrl||v?.video?.consumer?.originVideoKey&&('https://sns-video-bd.xhscdn.com/'+v.video.consumer.originVideoKey)||'';
  }
  if(!mediaUrl){
    for(const tag of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){
      try{
        const rows=findObjects(JSON.parse(tag[1]),v=>v['@type']==='VideoObject');
        if(rows.length===1){mediaUrl=rows[0].contentUrl||'';title||=rows[0].name||'';description||=rows[0].description||'';}
      }catch{}
      if(mediaUrl)break;
    }
  }
  mediaUrl||=meta(html,'og:video:url')||meta(html,'og:video:secure_url')||meta(html,'og:video');
  title||=meta(html,'og:title');description||=meta(html,'og:description');
  return {platform,title:String(title).slice(0,180),description:String(description).slice(0,1200),mediaUrl:mediaUrl?publicUrl(mediaUrl,url):'',bvid,cid};
}
export async function resolveVideoSource(source,{fetchPage=safeFetch,resolveBilibili}={}){
  if(source.platform==='bilibili'&&resolveBilibili){const value=await resolveBilibili(source.url);if(value)return {...source,...value};}
  const url=publicUrl(source.url);
  if(source.platform==='direct')return {...source,mediaUrl:url,title:new URL(url).pathname.split('/').at(-1)||'视频',description:''};
  const res=await fetchPage(url,600000);
  const finalUrl=publicUrl(res.url||url),final=extractVideoSource(finalUrl,{allowPage:true});
  const htmlOk=res.statusCode>=200&&res.statusCode<300;
  const biliId=source.platform==='bilibili'&&/\/(BV[A-Za-z0-9]+)/.exec(new URL(finalUrl).pathname)?.[1];
  if(!htmlOk&&!biliId)throw Error('未取得公开视频，可能需要登录或受到平台访问限制；请发送原视频');
  if(final.platform==='direct'||String(res.contentType||'').startsWith('video/'))return {...source,mediaUrl:finalUrl,title:'视频',description:''};
  if(source.platform!=='page'&&final.platform!==source.platform)throw Error('分享短链跳转到其他平台，未继续读取');
  if(res.truncated&&!biliId)throw Error('分享页面被截断，未取得完整视频资料；请发送原视频');
  let out=htmlOk&&!res.truncated?parseVideoPage(res.body,source.platform,finalUrl):{title:'',description:'',mediaUrl:''};
  if(source.platform==='bilibili'&&!out.mediaUrl){
    const bvid=out.bvid||/\/(BV[A-Za-z0-9]+)/.exec(new URL(finalUrl).pathname)?.[1];
    if(bvid){
      const view=await fetchPage('https://api.bilibili.com/x/web-interface/view?bvid='+encodeURIComponent(bvid),100000);
      let data;try{data=JSON.parse(view.body).data;}catch{}
      if(view.statusCode===200&&!view.truncated&&data?.cid){
        const play=await fetchPage('https://api.bilibili.com/x/player/playurl?bvid='+encodeURIComponent(bvid)+'&cid='+encodeURIComponent(data.cid)+'&qn=16&fnval=0&fnver=0&fourk=0',100000);
        let p;try{p=JSON.parse(play.body);}catch{}
        if(play.statusCode===200&&!play.truncated&&p?.code===0&&p.data?.durl?.[0]?.url)out={...out,mediaUrl:publicUrl(p.data.durl[0].url),title:String(data.title||out.title).slice(0,180),description:String(data.desc||out.description).slice(0,1200)};
      }
    }
  }
  if(!out.mediaUrl)throw Error('未取得可读取的视频内容（可能需要登录、视频已删除或页面不兼容）；请发送原视频，不能仅凭标题判断内容');
  return {...source,...out,displayUrl:displayMediaUrl(finalUrl)};
}
