import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {safePublicLink} from './utility-content.js';
import {createYuanbaoSearch} from './yuanbao-search.js';
export function normalizeNews(items,now=Date.now()) {
  const seen=new Set(),out=[];
  for(const r of items||[]) {
    let url;try{url=safePublicLink(r.url);}catch{continue;}
    if(seen.has(url))continue;seen.add(url);
    const rawDate=String(r.date||r.datePublished||'');
    const date=Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(rawDate)?rawDate+'T00:00:00+08:00':rawDate);
    if(Number.isFinite(date)&&(date>now||date<now-7*86400000))continue;
    out.push({title:String(r.title||r.name||'未命名资料').slice(0,180),url,snippet:String(r.snippet||r.summary||'').slice(0,400),
      date:Number.isFinite(date)?new Date(date).toISOString():null,dateLabel:Number.isFinite(date)?String(r.date||r.datePublished):'未提供发布时间'});
    if(out.length>=5)break;
  }
  return out;
}
export function createNewsSearch({env=process.env,stateDir=fileURLToPath(new URL('../state/',import.meta.url)),fetchImpl=fetch,readKey,now=Date.now}={}) {
  const yuanbao=createYuanbaoSearch({env,stateDir,fetchImpl,readKey});
  const key=(name,file)=>{if(env[name])return String(env[name]).trim();try{return readKey?readKey(file):fs.readFileSync(path.join(stateDir,file),'utf8').trim();}catch{return '';}};
  async function request(url,body,token) {
    const res=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
    if(!res.ok)throw Error('检索服务暂不可用');
    let raw='';const decoder=new TextDecoder();
    for await(const chunk of res.body){raw+=typeof chunk==='string'?chunk:decoder.decode(chunk,{stream:true});if(raw.length>300000)throw Error('检索结果过大');}
    raw+=decoder.decode();return JSON.parse(raw);
  }
  return async function search(query) {
    let emptyResult;
    const clean=String(query).replace(/[\x00-\x1f]/g,' ').trim().slice(0,120);
    if(!clean)throw Error('请先设置兴趣主题');
    const bocha=key('BOCHA_API_KEY','.bocha-key');
    if(bocha)try {
      const data=await request('https://api.bochaai.com/v1/web-search',{query:clean+' 最近一周',count:8,summary:false},bocha);
      if(Number(data.code)!==200)throw Error('检索服务未返回有效结果');
      const result={source:'bocha',results:normalizeNews(data.data?.webPages?.value,now())};
      if(result.results.length)return result;emptyResult=result;
    }catch{/* 沿用项目既有搜索主备顺序，仅检索，不切换聊天模型。 */}
    const deepseek=key('DEEPSEEK_API_KEY','.deepseek-key');
    if(deepseek)try {
      const data=await request('https://api.deepseek.com/v1/tools/search',{query:clean+' 最近一周',count:8,need_content:false},deepseek);
      if(!Array.isArray(data.results))throw Error('检索结果格式无效');
      const result={source:'deepseek-search',results:normalizeNews(data.results,now())};
      if(result.results.length)return result;emptyResult=result;
    }catch{/* 不向用户暴露请求URL、凭据或上游错误正文。 */}
    try {
      const data=await yuanbao(clean,{freshness:'d7'}),result={source:data.source,results:normalizeNews(data.results,now())};
      if(result.results.length)return result;emptyResult=result;
    }catch{/* 元宝是最后兜底，不切换聊天模型，不暴露上游错误。 */}
    if(emptyResult)return emptyResult;
    throw Error('兴趣简报暂时没有可用检索服务，请稍后再试；不会编造资讯');
  };
}
