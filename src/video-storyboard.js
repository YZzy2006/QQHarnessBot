import {scanShots} from './vendor/dsh-video-storyboard/scan.js';
import {segmentsFromCuts,fitSegments} from './vendor/dsh-video-storyboard/segments.js';
import {bestLayout} from './vendor/dsh-video-storyboard/plan.js';
import {layoutCanvas,composeSheet} from './vendor/dsh-video-storyboard/sheet.js';
import {displayAspect,parseSar} from './vendor/dsh-video-storyboard/probe.js';
import {assertMediaResources} from './media-resources.js';

export const STORYBOARD_SCAN_FPS=6;
export const STORYBOARD_SCAN_TIMEOUT_MS=15000;
export const STORYBOARD_PIXEL_BUDGET=640000;
export const VIDEO_DETAIL_PATTERN=/放大|看清|细看|细节|型号|文字|字幕|屏幕|按键|商标|标志/;
export function storyboardLayout(video,count){
  const rotation=Number(video.side_data_list?.find(v=>Number.isFinite(Number(v.rotation)))?.rotation??video.tags?.rotate??0);
  const aspect=Math.max(.25,Math.min(4,displayAspect(video.width,video.height,parseSar(video.sample_aspect_ratio),rotation)));
  const grid=bestLayout(count,aspect);
  return {...grid,...layoutCanvas(grid.cols,grid.rows,aspect,STORYBOARD_PIXEL_BUDGET),aspect};
}
export function assembleStoryboard(frames,layout){
  return composeSheet({frames,cols:layout.cols,rows:layout.rows,cellAspect:layout.aspect,budget:STORYBOARD_PIXEL_BUDGET,burn:'index',badgeRatio:.12});
}
export async function sceneAwareTimes({input,ffmpeg,guard,duration,fps,question,focus,tailSeconds,fallbackTimes,authorize,scanTimeoutMs=STORYBOARD_SCAN_TIMEOUT_MS}){
  const ordinal=focus!=null&&/第[零一二两三四五六七八九十\d]+分钟/.test(question);
  const from=focus==null?0:ordinal?focus:Math.max(0,focus-3);
  const to=focus==null?duration:Math.min(duration,ordinal?focus+60:focus+3);
  const controller=new AbortController();let pressure=null;
  const timeout=setTimeout(()=>controller.abort('scan-budget'),Math.max(1,Math.min(STORYBOARD_SCAN_TIMEOUT_MS,Number(scanTimeoutMs)||STORYBOARD_SCAN_TIMEOUT_MS)));
  const monitor=setInterval(()=>{
    try{assertMediaResources();if(!authorize())controller.abort('cancelled');}
    catch(error){pressure=error;controller.abort('memory');}
  },250);monitor.unref?.();
  try{
    assertMediaResources();if(!authorize())throw Error('视频处理权限已变化');
    const scan=await scanShots({input,fps:Number.isFinite(fps)&&fps>0?fps:25,ffmpegPath:ffmpeg,start:from,end:to,sampleFps:STORYBOARD_SCAN_FPS,minGap:.35,threshold:'auto',signal:controller.signal,inputArgs:['-threads','1','-filter_threads','1',...guard]});
    if(!authorize())throw Error('视频处理权限已变化');
    const segments=fitSegments(segmentsFromCuts(to-from,scan.cuts.map(c=>c.t),.1,from),focus==null?8:7,{minGap:.2});
    const last=Math.max(0,duration-tailSeconds),raw=segments.map(([a,b])=>(a+b)/2);
    if(focus!=null)raw.push(focus);
    const times=[...new Set(raw.map(v=>Math.round(Math.max(0,Math.min(last,v))*1000)/1000))].sort((a,b)=>a-b).slice(0,8);
    return {times,sampling:{method:'scene-aware',from,to,cuts:scan.cuts.length,scanFps:STORYBOARD_SCAN_FPS,degraded:scan.degraded||null}};
  }catch(error){
    if(pressure)throw pressure;
    if(!authorize())throw Error('视频处理权限已变化');
    assertMediaResources();
    return {times:fallbackTimes,sampling:{method:'uniform-fallback',from:0,to:duration,cuts:0,scanFps:STORYBOARD_SCAN_FPS,reason:controller.signal.aborted?'scan-budget':'scan-unavailable'}};
  }finally{clearTimeout(timeout);clearInterval(monitor);}
}
