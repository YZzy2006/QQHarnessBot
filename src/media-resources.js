import fs from 'node:fs';

const mib=1024*1024;
function budget(name,fallback,min,max){
  const raw=process.env[name];
  if(raw==null||raw==='')return fallback;
  const value=Number(raw);
  if(!Number.isInteger(value)||value<min||value>max)throw Error('无效的媒体资源预算：'+name);
  return value;
}
export const MEDIA_LIMITS=Object.freeze({
  active:budget('QQ_MEDIA_MAX_ACTIVE',1,1,2),
  videoBytes:budget('QQ_VIDEO_MAX_MIB',64,1,64)*mib,
  cacheBytes:budget('QQ_MEDIA_CACHE_MIB',96,24,96)*mib,
  videoPixels:budget('QQ_VIDEO_MAX_PIXELS',8294400,230400,8294400),
  minAvailableBytes:budget('QQ_MEDIA_MIN_AVAILABLE_MIB',512,256,2048)*mib
});
if(MEDIA_LIMITS.cacheBytes<MEDIA_LIMITS.videoBytes)throw Error('媒体缓存预算不能小于单个视频预算');
export function availableMemoryBytes(meminfo){
  const match=/^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(String(meminfo));
  if(!match)throw Error('无法读取服务器可用内存，暂缓媒体处理');
  return Number(match[1])*1024;
}
export function assertMediaResources({platform=process.platform,readMeminfo=()=>fs.readFileSync('/proc/meminfo','utf8'),minBytes=MEDIA_LIMITS.minAvailableBytes}={}){
  if(platform!=='linux')return;
  let available;
  try{available=availableMemoryBytes(readMeminfo());}
  catch{throw Error('无法读取服务器可用内存，暂缓媒体处理，请稍后重试');}
  if(available<minBytes)throw Error('服务器可用内存不足，暂缓媒体处理，请稍后重试或先裁剪视频');
}
