import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {MEDIA_LIMITS,assertMediaResources} from './media-resources.js';
import {sceneAwareTimes,storyboardLayout,assembleStoryboard,VIDEO_DETAIL_PATTERN} from './video-storyboard.js';

const exec=promisify(execFile);
let ownerTag;
async function mediaOwnerTag(){
  if(process.platform!=='linux')return '';
  if(ownerTag)return ownerTag;
  const [processStat,boot]=await Promise.all([fs.readFile('/proc/self/stat','utf8'),fs.readFile('/proc/sys/kernel/random/boot_id','utf8')]);
  const ticks=processStat.slice(processStat.lastIndexOf(')')+1).trim().split(/\s+/)[19],bootId=boot.trim();
  if(!/^\d+$/.test(ticks)||! /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(bootId))throw Error('无法确认媒体处理进程标识，暂缓处理');
  ownerTag=process.pid+'-'+ticks+'-'+bootId;return ownerTag;
}
export const VIDEO_MAX_BYTES=MEDIA_LIMITS.videoBytes;
export function looksLikeVideo(b){return Buffer.isBuffer(b)&&b.length>=12&&(b.toString('ascii',4,8)==='ftyp'||b.readUInt32BE(0)===0x1a45dfa3||b.toString('ascii',0,3)==='FLV'||b.toString('ascii',0,4)==='RIFF'&&b.toString('ascii',8,12)==='AVI ');}
const number=s=>/^\d+$/.test(s)?Number(s):({零:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9,十:10}[s]??(s.includes('十')?(({'':1,一:1,二:2,三:3,四:4,五:5}[s.split('十')[0]]??NaN)*10+({'':0,一:1,二:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9}[s.split('十')[1]]??NaN)):NaN));
export function requestedVideoTime(question=''){
  const clock=/\b(\d{1,2}):([0-5]\d)\b/.exec(question);if(clock)return Number(clock[1])*60+Number(clock[2]);
  const m=/第?([零一二两三四五六七八九十\d]+)分(?:钟)?(?:([零一二两三四五六七八九十\d]+)秒)?/.exec(question);
  if(m)return (number(m[1])-(m[0].startsWith('第')&&m[0].includes('分钟')&&!m[2]?1:0))*60+(m[2]?number(m[2]):0);
  const s=/第?([零一二两三四五六七八九十\d]+)秒/.exec(question);return s?number(s[1]):null;
}
export function sampleVideoTimes(duration,question='',tailSeconds=0.25){
  if(!Number.isFinite(duration)||duration<=0||duration>600)throw Error('只处理10分钟以内且时长有效的视频，请裁剪后重试');
  const focus=requestedVideoTime(question);
  if(focus!=null&&(!Number.isFinite(focus)||focus<0||focus>=duration))throw Error('所问时间点超出本视频范围');
  const ordinal=/第[零一二两三四五六七八九十\d]+分钟/.test(question);
  const last=Math.max(0,duration-tailSeconds),rows=focus==null?Array.from({length:8},(_,i)=>last*i/7):ordinal?[0,focus,focus+15,focus+30,focus+45,Math.min(focus+59,last),last]:[0,Math.max(0,focus-2),focus,Math.min(last,focus+2),last/2,last];
  return [...new Set(rows.map(v=>Math.round(Math.min(last,v)*1000)/1000))].sort((a,b)=>a-b).slice(0,8);
}
async function run(binary,args,timeout=15000){
  assertMediaResources();
  try{return await exec(binary,args,{timeout,killSignal:'SIGKILL',maxBuffer:65536,windowsHide:true,encoding:'utf8'});}
  catch(error){throw Error(error.code==='ENOENT'?'缺少FFmpeg或FFprobe，请安装后重试':'视频解码失败或处理超时，请换MP4/WebM文件或裁剪视频',{cause:error});}
}
export async function withVideoEvidence(buffer,{tempRoot,question='',ffmpeg=process.env.FFMPEG_PATH||'ffmpeg',ffprobe=process.env.FFPROBE_PATH||'ffprobe',authorize=()=>true,scanTimeoutMs}={},consume){
  if(!looksLikeVideo(buffer)||buffer.length>VIDEO_MAX_BYTES)throw Error('只接受'+VIDEO_MAX_BYTES/1024/1024+'MiB以内的MP4/MOV/WebM/MKV/AVI/FLV视频，拒绝播放列表和任意文件');
  if(!tempRoot||typeof consume!=='function')throw Error('缺少受限媒体处理目录或回调');
  if(!authorize())throw Error('视频处理权限已变化');
  const root=path.resolve(tempRoot);await fs.mkdir(root,{recursive:true});
  const owner=await mediaOwnerTag();
  const dir=await fs.mkdtemp(path.join(root,owner?'video-'+owner+'-':'video-'));
  const files=[];
  try{
    const input=path.join(dir,'source.media');files.push(input);await fs.writeFile(input,buffer,{flag:'wx'});
    const guard=['-max_alloc','67108864','-probesize','5242880','-analyzeduration','5000000','-protocol_whitelist','file,pipe',...(buffer.toString('ascii',4,8)==='ftyp'?['-enable_drefs','0']:[])];
    const info=JSON.parse((await run(ffprobe,['-v','error','-threads','1',...guard,'-show_entries','format=duration,format_name:stream=index,codec_type,width,height,avg_frame_rate,sample_aspect_ratio:stream_tags=rotate:stream_side_data=rotation','-of','json',input])).stdout);
    const video=info.streams?.find(s=>s.codec_type==='video'),duration=Number(info.format?.duration);
    if(!video||!Number.isFinite(video.width)||!Number.isFinite(video.height)||video.width<=0||video.height<=0||video.width*video.height>MEDIA_LIMITS.videoPixels)throw Error('视频没有可用画面或分辨率超过处理预算，请先降低分辨率');
    const [rateN,rateD]=String(video.avg_frame_rate||'0/1').split('/').map(Number),fps=rateN/rateD;
    const tailSeconds=Number.isFinite(fps)&&fps>0?Math.max(.08,1.2/fps):1;
    const fallbackTimes=sampleVideoTimes(duration,question,tailSeconds),focus=requestedVideoTime(question);
    const {times,sampling}=await sceneAwareTimes({input,ffmpeg,guard,duration,fps,question,focus,tailSeconds,fallbackTimes,authorize,scanTimeoutMs});
    const detail=focus!=null||VIDEO_DETAIL_PATTERN.test(question),layout=storyboardLayout(video,times.length),frames=[],smallFrames=[];
    for(const [index,at] of times.entries()){
      if(!authorize())throw Error('视频处理权限已变化');
      const output=path.join(dir,'frame-'+index+'.jpg'),small=path.join(dir,'cell-'+index+'.rgb');files.push(output,small);
      const filter='[0:v]split=2[large][cell];[large]scale=960:960:force_original_aspect_ratio=decrease,format=yuvj420p[outlarge];[cell]scale='+layout.cellW+':'+layout.cellH+':force_original_aspect_ratio=decrease,pad='+layout.cellW+':'+layout.cellH+':(ow-iw)/2:(oh-ih)/2,format=rgb24[outcell]';
      await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-filter_threads','1','-filter_complex_threads','1','-threads','1',...guard,'-ss',String(at),'-i',input,'-filter_complex',filter,'-map','[outlarge]','-frames:v','1','-threads','1','-q:v','4',output,'-map','[outcell]','-frames:v','1','-threads','1','-f','rawvideo',small]);
      const bytes=await fs.readFile(output);if(bytes.length>1024*1024)throw Error('视频帧超过处理预算');
      frames.push({at,buffer:bytes,mimeType:'image/jpeg'});
      const rgb=await fs.readFile(small);if(rgb.length!==layout.cellW*layout.cellH*3)throw Error('分镜格画面尺寸无效');smallFrames.push({buffer:rgb,index:index+1});
    }
    if(!authorize())throw Error('视频处理权限已变化');
    const sheet=assembleStoryboard(smallFrames,layout),gridRaw=path.join(dir,'storyboard.rgb'),gridImage=path.join(dir,'storyboard.jpg');files.push(gridRaw,gridImage);
    await fs.writeFile(gridRaw,sheet.buffer,{flag:'wx'});
    await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-threads','1','-filter_threads','1','-max_alloc','67108864','-protocol_whitelist','file,pipe','-f','rawvideo','-pixel_format','rgb24','-video_size',sheet.width+'x'+sheet.height,'-i',gridRaw,'-frames:v','1','-threads','1','-q:v','4',gridImage]);
    const gridBuffer=await fs.readFile(gridImage);if(gridBuffer.length>1024*1024)throw Error('内部宫格超过处理预算');
    const storyboard={buffer:gridBuffer,mimeType:'image/jpeg',cols:layout.cols,rows:layout.rows,width:sheet.width,height:sheet.height,cells:frames.map((f,index)=>({index:index+1,at:f.at}))};
    let audio=null;
    if(info.streams.some(s=>s.codec_type==='audio')){
      if(!authorize())throw Error('视频处理权限已变化');
      const focus=requestedVideoTime(question),start=focus==null?0:Math.max(0,focus-30),end=Math.min(duration,start+120);
      const output=path.join(dir,'audio.wav');files.push(output);
      await run(ffmpeg,['-nostdin','-hide_banner','-loglevel','error','-filter_threads','1','-threads','1',...guard,'-ss',String(start),'-i',input,'-vn','-t',String(end-start),'-threads','1','-ac','1','-ar','16000','-c:a','pcm_s16le',output],20000);
      const bytes=await fs.readFile(output);if(bytes.length>4*1024*1024)throw Error('视频音轨超过处理预算');audio={buffer:bytes,start,end};
    }
    if(!authorize())throw Error('视频处理权限已变化');
    return await consume({duration,frames,audio,storyboard,sampling,detail,detailFocus:focus,coverage:(sampling.method==='scene-aware'?'场景选帧':'场景扫描预算或解码限制，降级时间采样')+frames.length+'帧；内部'+layout.cols+'×'+layout.rows+'编号宫格'+(detail?'及细节大图':'概览')+(audio?'；音轨覆盖'+Math.floor(audio.start)+'~'+Math.ceil(audio.end)+'秒':'；视频无可用音轨')+'，不是逐帧完整审阅'});
  }finally{
    // Delete only exact files created by this call, never a caller supplied source path or parent tree.
    if(path.dirname(dir)!==root||!path.basename(dir).startsWith('video-'))throw Error('媒体临时路径校验失败');
    for(const file of files){if(path.dirname(file)!==dir)throw Error('媒体清理路径越界');await fs.unlink(file).catch(e=>{if(e.code!=='ENOENT')throw e;});}
    await fs.rmdir(dir);
  }
}
