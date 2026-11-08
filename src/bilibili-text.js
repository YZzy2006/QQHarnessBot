export async function requestBilibiliText({q,provider,model,effort,apiKey,fetchImpl=fetch,onUsage=()=>{}}){
 if(provider!=='deepseek-official'||!apiKey)throw Error('当前提供方未配置B站角色文本适配，不自动换供应商');
 if(!['none','low','high','max'].includes(effort))throw Error('当前思考档位不在B站适配范围');
 const facts=JSON.stringify(q.facts);
 if(q.system.length+facts.length>100000)throw Error('当前人物卡或视频资料超过文本预算，未截断人格卡');
 const response=await fetchImpl('https://api.deepseek.com/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+apiKey},redirect:'error',signal:AbortSignal.timeout(60000),
 body:JSON.stringify({model,stream:false,max_tokens:8192,thinking:{type:effort==='none'?'disabled':'enabled'},...(effort==='none'?{}:{reasoning_effort:effort}),
 messages:[{role:'system',content:q.system},{role:'user',content:JSON.stringify({kind:q.kind,facts:q.facts})}]})});
 if(!response.ok)throw Error('B站角色请求返回HTTP '+response.status+'，未自动重试');
 const raw=await response.text();if(raw.length>2000000)throw Error('B站角色响应超限');
 let data;try{data=JSON.parse(raw);}catch{throw Error('B站角色响应格式无效');}
 if(data.usage)onUsage(data.usage);
 const c=data.choices?.[0];if(c?.message?.tool_calls?.length||c?.message?.function_call)throw Error('B站辅助返回工具请求，已拒绝');
 if(c?.finish_reason==='length')throw Error('B站角色响应不完整，未提交分享');
 if(typeof c?.message?.content!=='string'||!c.message.content.trim())throw Error('B站角色没有返回有效内容');
 return c.message.content.trim();
}
