// Bounded in-process queues for explicit local commands, not model turns.
let contextOrder=0;
export const nextQueryContextOrder=()=>++contextOrder;
export function createLocalRequestQueue({now=Date.now,maxPending=4,ttlMs=120000,maxActors=128}={}) {
  const actors=new Map();
  const failure=(message,code)=>Object.assign(Error(message),{code});
  function run(key,task,{onQueued}={}) {
    let state=actors.get(key);
    if(state&&state.size>=maxPending+1)return Promise.reject(failure('排队已满，本条未接受；请等现有请求完成后重试','QUEUE_FULL'));
    if(!state&&actors.size>=maxActors)return Promise.reject(failure('当前请求较多，本条未接受；请稍后再试','QUEUE_FULL'));
    const queued=!!state,previous=state?.tail,at=now();
    if(!state){state={size:0,tail:Promise.resolve()};actors.set(key,state);}
    state.size++;
    const result=Promise.resolve().then(async()=>{
      if(queued){
        // A missing acknowledgment must not silently drop an accepted operation.
        try{await onQueued?.();}catch{}
        await previous;
        if(now()-at>ttlMs)throw failure('这条排队请求已超过2分钟，尚未执行；请重新发起','QUEUE_EXPIRED');
      }
      return task();
    }).finally(()=>{state.size--;if(!state.size)actors.delete(key);});
    state.tail=result.then(()=>{},()=>{});
    return result;
  }
  return {run,busy:key=>actors.has(key)};
}
