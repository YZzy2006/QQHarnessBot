// Child-process preload for test-search-maps only. No requests leave this process.
globalThis.fetch=async(url,options={})=>{
  if(String(url).startsWith('https://api.bochaai.com/'))return new Response('',{status:503});
  if(String(url).startsWith('https://api.deepseek.com/'))return Response.json({results:[]});
  if(String(url)==='https://api.wsa.cloud.tencent.com/SearchPro') {
    if(options.headers.authorization!=='Bearer fixture-yuanbao')throw Error('Unexpected fixture credential');
    return Response.json({Response:{Pages:[JSON.stringify({title:'官方资料',url:'https://example.com/official',passage:'公开资料摘要'})]}});
  }
  throw Error('External access is disabled in this fixture');
};
