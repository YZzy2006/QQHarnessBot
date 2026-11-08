import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {Resvg} from '@resvg/resvg-js';

const escape=s=>String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,' ').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
function wrap(text,columns=30){
  const lines=[];
  for(const raw of text.replace(/\r\n?/g,'\n').split('\n')){
    if(!raw){lines.push('');continue;}
    let row='',units=0;
    for(const ch of raw){const n=/[\x20-\x7e]/.test(ch)?0.55:1;if(units+n>columns&&row){lines.push(row);row='';units=0;}row+=ch;units+=n;}
    if(row)lines.push(row);
  }
  return lines;
}
export function buildResultCards(input,{width=900,maxPages=4}={}){
  if(width!==900||!Number.isInteger(maxPages)||maxPages<1||maxPages>4)throw Error('卡片尺寸或页数超出预算');
  const text=String(input||'').slice(0,12000),match=/^【([^\n]{1,36})】/.exec(text),rawTitle=match?.[1]||'查询结果';
  const title=[...rawTitle].length>24?[...rawTitle].slice(0,23).join('')+'…':rawTitle;
  const lines=wrap(match?text.slice(match[0].length).trimStart():text),perPage=20,total=Math.min(maxPages,Math.max(1,Math.ceil(lines.length/perPage))),truncated=lines.length>perPage*maxPages||String(input).length>12000;
  return Array.from({length:total},(_,index)=>{
    const rows=lines.slice(index*perPage,(index+1)*perPage),height=168+Math.max(4,rows.length)*38;
    const footer=index===total-1&&truncated?'仅展示部分内容，可发送“结果原文”查看文字':'可发送“结果原文”获取文字与引用';
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="${height}" viewBox="0 0 900 ${height}"><rect width="900" height="${height}" rx="24" fill="#f4f6fa"/><rect x="22" y="22" width="856" height="${height-44}" rx="18" fill="#ffffff"/><rect x="48" y="50" width="5" height="34" rx="2" fill="#3568cc"/><g font-family="Microsoft YaHei,Noto Sans CJK SC,Noto Sans SC,WenQuanYi Micro Hei,sans-serif" fill="#1e293b"><text x="70" y="78" font-size="28" font-weight="600">${escape(title)}</text><text x="800" y="77" font-size="18" fill="#64748b">${index+1}/${total}</text>${rows.map((line,i)=>`<text x="52" y="${126+i*38}" font-size="24">${escape(line)}</text>`).join('')}<text x="52" y="${height-37}" font-size="18" fill="#64748b">${escape(footer)}</text></g></svg>`;
    return {svg,width:900,height,page:index+1,pages:total,truncated};
  });
}
export function cardFont(){
  const known=[process.env.QQ_CARD_FONT,'C:/Windows/Fonts/msyh.ttc','C:/Windows/Fonts/msyh.ttf','/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc','/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf','/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc','/usr/share/fonts/google-noto-sans-cjk-ttc/NotoSansCJK-Regular.ttc','/usr/share/fonts/wqy-microhei/wqy-microhei.ttc','/usr/share/fonts/truetype/wqy/wqy-microhei.ttc'].filter(Boolean).find(p=>{try{return fs.statSync(p).isFile();}catch{return false;}});
  if(known)return known;
  try{const result=execFileSync('fc-match',['-f','%{lang}\n%{file}','sans-serif:lang=zh'],{encoding:'utf8',timeout:2000,maxBuffer:4096,windowsHide:true});const font=fontMatchPath(result);if(font&&fs.statSync(font).isFile())return font;}catch{}
  return '';
}
export function fontMatchPath(result){const split=String(result).lastIndexOf('\n');if(split<0)return '';const lang=result.slice(0,split),font=result.slice(split+1).trim();return /(?:^|[|\s])zh(?:-|$|[|\s])/.test(lang)?font:'';}
export function renderResultCards(text,{fontPath=cardFont(),...options}={}){
  if(!fontPath||!fs.existsSync(fontPath))throw Error('缺少可用中文字体，保留文字结果；可由管理端设置QQ_CARD_FONT');
  return buildResultCards(text,options).map(page=>{
    const family=/msyh/i.test(fontPath)?'Microsoft YaHei':/wqy.*zen/i.test(fontPath)?'WenQuanYi Zen Hei':/wqy/i.test(fontPath)?'WenQuanYi Micro Hei':/NotoSansSC/i.test(fontPath)?'Noto Sans SC':'Noto Sans CJK SC';
    const resvg=new Resvg(page.svg,{font:{fontFiles:[fontPath],loadSystemFonts:false,defaultFontFamily:family},fitTo:{mode:'width',value:900}});
    const buffer=resvg.render().asPng();if(buffer.length>4*1024*1024)throw Error('卡片超过发送体积预算，保留文字结果');
    return {...page,buffer};
  });
}
