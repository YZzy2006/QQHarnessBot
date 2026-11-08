import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createUtilityStore} from '../src/utility-store.js';
import {checkedQuote} from '../src/utility-content.js';
export const ownerCtx={sourceKey:'private:123',userId:'123',selfId:'999',directed:true};
export function utilityFixture(extra={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-utilities-'));let clock=Date.parse('2026-10-23T09:00:00+08:00');const sent=[],queries=[];
  const d={stateDir:dir,store:createUtilityStore({stateDir:dir}),now:()=>clock,ownerQQ:()=>123,ownerCity:()=>'',redact:v=>String(v),validateUrl:async()=>{},
    say:async(ctx,text,options={})=>{sent.push({key:ctx.sourceKey,text,...options});return true;},isAllowed:()=>true,
    getMessage:async()=>({group_id:456,sender:{user_id:234},message:[{type:'text',data:{text:'项目启动用 npm start'}}]}),
    readMessage:async q=>q.message.filter(v=>v.type==='text').map(v=>v.data.text).join(''),
    life:{weather:async city=>{queries.push(city);if(city==='西湖区')throw Object.assign(Error('重名'),{code:'AMBIGUOUS',candidates:['杭州市西湖区','南昌市西湖区']});
      return {city,provider:'hefeng',source:'和风天气',queriedAt:clock,current:{text:'晴',temp:20},days:[{date:'2026-10-23',min:10,max:20,day:'晴',night:'晴'},{date:'2026-10-24',min:10,max:21,day:'晴',night:'晴'}],hours:[],limitations:[],attribution:'https://example.com'};}},
    ...extra};
  d.quote=async ctx=>{if(!ctx.quotedId)throw Error('请引用同会话消息');return checkedQuote(ctx,await d.getMessage(ctx.quotedId));};
  return {d,sent,queries,advance:ms=>clock+=ms,close:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
