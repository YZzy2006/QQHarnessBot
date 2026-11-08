import fs from 'node:fs';
import crypto from 'node:crypto';

export const PORTRAIT_LIMIT = 3 * 1024 * 1024;
const bad = message => {throw Object.assign(Error(message),{statusCode:400});};
export function inspectPortrait(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > PORTRAIT_LIMIT) bad('图片不能为空且最大3MB');
  let type,ext,width,height;
  if (bytes.length>=24 && bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')) && bytes.toString('ascii',12,16)==='IHDR') {
    type='image/png';ext='png';width=bytes.readUInt32BE(16);height=bytes.readUInt32BE(20);
  } else if (bytes.length>=10 && ['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) {
    type='image/gif';ext='gif';width=bytes.readUInt16LE(6);height=bytes.readUInt16LE(8);
  } else if(bytes.length>=30 && bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') {
    type='image/webp';ext='webp';const tag=bytes.toString('ascii',12,16);
    if(tag==='VP8X'){width=1+bytes.readUIntLE(24,3);height=1+bytes.readUIntLE(27,3);}
    else if(tag==='VP8 ' && bytes.subarray(23,26).equals(Buffer.from('9d012a','hex'))){width=bytes.readUInt16LE(26)&0x3fff;height=bytes.readUInt16LE(28)&0x3fff;}
    else if(tag==='VP8L' && bytes[20]===0x2f){const bits=bytes.readUInt32LE(21);width=(bits&0x3fff)+1;height=((bits>>>14)&0x3fff)+1;}
  } else if(bytes.length>=4 && bytes[0]===0xff && bytes[1]===0xd8) {
    type='image/jpeg';ext='jpg';let at=2;
    while(at+4<bytes.length){if(bytes[at++]!==0xff)continue;let marker=bytes[at++];while(marker===0xff&&at<bytes.length)marker=bytes[at++];if(marker===0xda||marker===0xd9)break;if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;const length=bytes.readUInt16BE(at);if(length<2||at+length>bytes.length)break;if([0xc0,0xc1,0xc2].includes(marker)&&length>=7){height=bytes.readUInt16BE(at+3);width=bytes.readUInt16BE(at+5);break;}at+=length;}
  }
  if(!type||!width||!height||width>8192||height>8192||width*height>32000000)bad('请选择有效的PNG、JPEG、GIF或WebP图片，尺寸不超过8192且总像素不超过3200万');
  return {type,ext,width,height};
}
const hmac=(key,value)=>crypto.createHmac('sha256',key).update(value).digest();
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
// OSS V4, based on Alibaba Cloud's canonical-request specification.
export function signOssRequest({method,bucket,key,region,accessKeyId,accessKeySecret,headers={},date=new Date(),additional=[]}) {
  const stamp=date.toISOString().replace(/[:-]|\.\d{3}/g,''),day=stamp.slice(0,8);
  const signed={...headers,'x-oss-date':stamp,'x-oss-content-sha256':'UNSIGNED-PAYLOAD'};
  const names=Object.keys(signed).filter(name=>name==='content-type'||name==='content-md5'||name.startsWith('x-oss-')||additional.includes(name)).sort();
  const extras=[...additional].sort().join(';');
  const canonical=[method,'/'+bucket+'/'+key,'',names.map(name=>name+':'+String(signed[name]).trim()+'\n').join(''),extras,'UNSIGNED-PAYLOAD'].join('\n');
  const scope=day+'/'+region+'/oss/aliyun_v4_request';
  const signingKey=hmac(hmac(hmac(hmac('aliyun_v4'+accessKeySecret,day),region),'oss'),'aliyun_v4_request');
  const signature=hmac(signingKey,['OSS4-HMAC-SHA256',stamp,scope,sha(canonical)].join('\n')).toString('hex');
  signed.authorization='OSS4-HMAC-SHA256 Credential='+accessKeyId+'/'+scope+','+(extras?'AdditionalHeaders='+extras+',':'')+'Signature='+signature;
  return {headers:signed,canonical,signature};
}
export function decryptBlogSecret(value,key) {
  if(!value.startsWith('ENC:'))return value;
  const combined=Buffer.from(value.slice(4),'base64');if(combined.length<28)throw Error('OSS配置不可用');
  const decipher=crypto.createDecipheriv('aes-'+(key.length*8)+'-gcm',key,combined.subarray(0,12));decipher.setAuthTag(combined.subarray(-16));
  return Buffer.concat([decipher.update(combined.subarray(12,-16)),decipher.final()]).toString('utf8');
}
// Optional standalone OSS configuration, never read credentials from another application's database.
export function readPortraitConfig(file) {
  try {
  const st=fs.lstatSync(file);
  if(!st.isFile()||(st.mode&0o077)!==0||st.size>32768)throw Error('OSS受保护配置不可用');
  const config=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const key of ['endpoint','bucket','accessKeyId','accessKeySecret'])if(typeof config[key]!=='string'||!config[key])throw Error('OSS配置不可用');
  return {endpoint:config.endpoint,bucket:config.bucket,accessKeyId:config.accessKeyId,accessKeySecret:config.accessKeySecret};
  } catch { throw Error('OSS受保护配置不可用'); }
}
export function createBlogPortraitStorage({configFile=process.env.QQ_WORKBENCH_OSS_FILE||'/etc/qq-workbench-oss.json',fetchImpl=fetch,loadConfig}={}) {
  // Compatibility export name retained; public storage is isolated from any blog/database.
  let cache=null;
  async function configuration(){
    if(loadConfig)return loadConfig();
    return readPortraitConfig(configFile);
  }
  function connection(cfg){
    const endpoint=String(cfg.endpoint||'').replace(/^https?:\/\//,'').replace(/\/$/,'');
    const match=/^oss-([a-z0-9-]+?)(?:-internal)?\.aliyuncs\.com$/.exec(endpoint);
    if(!match||!/^[-a-z0-9]{3,63}$/.test(cfg.bucket||'')||!cfg.accessKeyId||!cfg.accessKeySecret)throw Error('OSS尚未完整配置');
    return {origin:'https://'+cfg.bucket+'.'+endpoint,region:match[1]};
  }
  async function request(method,key,bytes,type){
    if(!/^botwork\/portraits\/[a-f0-9-]{36}\.(png|jpg|gif|webp)$/.test(key))throw Error('形象对象无效');
    const cfg=await configuration(),{origin,region}=connection(cfg);
    const headers=method==='PUT'?{'content-type':type,'content-md5':crypto.createHash('md5').update(bytes).digest('base64'),'x-oss-object-acl':'private'}:{};
    const signed=signOssRequest({method,bucket:cfg.bucket,key,region,accessKeyId:cfg.accessKeyId,accessKeySecret:cfg.accessKeySecret,headers});
    const result=await fetchImpl(origin+'/'+key,{method,headers:signed.headers,...(bytes?{body:bytes}:{}),redirect:'error',signal:AbortSignal.timeout(25000)});
    if(!result.ok){await result.body?.cancel();throw Error('OSS读写未完成，请检查独立OSS配置与对象权限');}
    return result;
  }
  return {
    available:()=>!!loadConfig||fs.existsSync(configFile),
    async upload(bytes){const meta=inspectPortrait(bytes),key='botwork/portraits/'+crypto.randomUUID()+'.'+meta.ext;await request('PUT',key,bytes,meta.type);cache={key,bytes,meta,until:Date.now()+300000};return {key,type:meta.type,width:meta.width,height:meta.height,updatedAt:Date.now()};},
    async image(portrait){if(cache?.key===portrait.key&&cache.until>Date.now())return {bytes:cache.bytes,type:cache.meta.type};const response=await request('GET',portrait.key);let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>PORTRAIT_LIMIT)throw Error('形象图片过大');chunks.push(chunk);}const bytes=Buffer.concat(chunks),meta=inspectPortrait(bytes);cache={key:portrait.key,bytes,meta,until:Date.now()+300000};return {bytes,type:meta.type};}
  };
}
