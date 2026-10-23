// 发布门禁：只输出文件、行号和规则名，不输出命中内容或密钥片段。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const ROOT=fileURLToPath(new URL('..',import.meta.url));
const PRIVATE_PATH=/(?:^|\/)(?:state|backups|node_modules|SnowLuma|samples|audio|\.dsh|\.ai-memory)(?:\/|$)|(?:^|\/)(?:config\.json|\.env(?:\..+)?|HANDOFF[^/]*|CLAUDE\.md|AGENTS\.md|privacy-rules\.json|id_rsa[^/]*|id_ed25519[^/]*)$|\.(?:pem|key|p12|pfx|gpg|asc|log|jsonl|bak|png|jpe?g|wav|mp3|bin|zip|tgz|exe|dll|node|so)$/i;
const RULES=[
  ['私钥内容',/-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/g],
  ['GitHub令牌',/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/g],
  ['模型API密钥',/\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{24,}\b/g],
  ['云访问密钥',/\b(?:AKIA[0-9A-Z]{16}|AKID[A-Za-z0-9]{28,}|AIza[A-Za-z0-9_-]{30,}|LTAI[A-Za-z0-9]{16,})\b/g],
  ['JWT凭据',/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/g],
  ['URL内嵌凭据',/https?:\/\/[^\s/:@]+:[^\s/@]+@/g],
  ['个人Windows目录',/[A-Z]:[\\/]+Users[\\/]+(?!<|example\b|test\b|fixture\b)[\w.-]+/gi],
];

export function unsafePath(name) {
  return name!=='.env.example'&&(PRIVATE_PATH.test(name)||name.includes('\\')||name.startsWith('/')||name.split('/').includes('..'));
}

export function scanText(name,bytes) {
  const problems=[];
  if(bytes.includes(0))return [{file:name,line:0,rule:'不允许未审查的二进制内容'}];
  let text;
  try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{return [{file:name,line:0,rule:'文件不是有效UTF-8'}];}
  const add=(index,rule)=>problems.push({file:name,line:text.slice(0,index).split('\n').length,rule});
  for(const [rule,regex] of RULES){
    regex.lastIndex=0;
    for(const m of text.matchAll(regex))add(m.index,rule);
  }
  // 检查字面量赋值，而不是把整份源码/测试加入白名单。
  const assignment=/(?:api[_-]?key|access[_-]?token|auth[_-]?token|console[_-]?token|secret|password|passwd)["']?\s*[:=]\s*["']([A-Za-z0-9_./+=-]{12,})["']/gi;
  for(const m of text.matchAll(assignment)){
    const value=m[1];
    if(/^(?:fixture-|fake-|test-|dummy-|example-|your-|placeholder|Bearer)/i.test(value))continue;
    if(value.length>=20&&/[a-z]/.test(value)&&/[0-9]/.test(value))add(m.index,'可疑的硬编码凭据字面量');
  }
  return problems;
}

function git(root,args,{input,allowFailure=false}={}) {
  const r=spawnSync('git',['-C',root,...args],{input,maxBuffer:32*1024*1024,windowsHide:true});
  if(r.status!==0&&!allowFailure)throw Error(`Git检查失败：${args[0]}（退出码${r.status}）`);
  return r;
}

function readManifest(bytes) {
  const d=JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/,''));
  if(d.version!==1||!Array.isArray(d.files)||new Set(d.files).size!==d.files.length||!d.files.includes('release-files.json'))throw Error('发布清单格式错误或路径重复');
  if(d.files.some(f=>typeof f!=='string'||unsafePath(f)))throw Error('发布清单含危险路径');
  return new Set(d.files);
}

function walk(root,dir=root,out=[]) {
  for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    if(['.git','node_modules','.release-evidence'].includes(item.name)&&dir===root)continue;
    const full=path.join(dir,item.name),name=path.relative(root,full).split(path.sep).join('/');
    if(item.isSymbolicLink())throw Error(`拒绝符号链接：${name}`);
    if(item.isDirectory())walk(root,full,out);else if(item.isFile())out.push(name);
  }
  return out;
}

export function checkRelease(root=ROOT,mode='worktree') {
  const findings=[];let checked=0;
  const inspect=(name,bytes,allowed,meta='')=>{
    if(unsafePath(name))findings.push({file:name,line:0,rule:'禁止发布的路径'});
    if(!allowed.has(name))findings.push({file:name,line:0,rule:'文件未列入发布清单'});
    findings.push(...scanText(name,bytes).map(f=>({...f,...(meta?{revision:meta}:{})})));checked++;
  };
  if(mode==='history'){
    const commits=git(root,['rev-list','HEAD']).stdout.toString('utf8').trim().split('\n').filter(Boolean);
    const seen=new Set();
    for(const commit of commits){
      const manifest=git(root,['show',`${commit}:release-files.json`]).stdout;
      const allowed=readManifest(manifest),paths=new Set();
      const entries=git(root,['ls-tree','-rz','--full-tree',commit]).stdout.toString('utf8').split('\0').filter(Boolean);
      for(const row of entries){
        const tab=row.indexOf('\t'),name=row.slice(tab+1),[perm,type,oid]=row.slice(0,tab).split(' ');paths.add(name);
        if(type!=='blob'||!['100644','100755'].includes(perm))throw Error(`拒绝Git链接或子模块：${name}`);
        if(!allowed.has(name)||unsafePath(name))inspect(name,Buffer.alloc(0),allowed,commit.slice(0,12));
        else if(!seen.has(oid)){inspect(name,git(root,['cat-file','blob',oid]).stdout,allowed,commit.slice(0,12));seen.add(oid);}
      }
      for(const name of allowed)if(!paths.has(name))findings.push({file:name,line:0,rule:'历史提交缺少清单文件',revision:commit.slice(0,12)});
    }
  }else if(mode==='staged'){
    const allowed=readManifest(git(root,['show',':release-files.json']).stdout);
    const entries=git(root,['ls-files','--stage','-z']).stdout.toString('utf8').split('\0').filter(Boolean),paths=new Set();
    for(const row of entries){
      const tab=row.indexOf('\t'),name=row.slice(tab+1),[perm,oid,stage]=row.slice(0,tab).split(' ');paths.add(name);
      if(stage!=='0'||!['100644','100755'].includes(perm))throw Error(`暂存区有冲突、链接或子模块：${name}`);
      inspect(name,git(root,['cat-file','blob',oid]).stdout,allowed);
    }
    for(const name of allowed)if(!paths.has(name))findings.push({file:name,line:0,rule:'暂存区缺少清单文件'});
  }else{
    const allowed=readManifest(fs.readFileSync(path.join(root,'release-files.json')));
    const probe=git(root,['rev-parse','--show-toplevel'],{allowFailure:true});
    const hasOwnGit=probe.status===0&&path.resolve(probe.stdout.toString('utf8').trim())===path.resolve(root);
    const candidates=hasOwnGit?git(root,['ls-files','--cached','--others','--exclude-standard','-z']).stdout.toString('utf8').split('\0').filter(Boolean):walk(root);
    for(const name of new Set(candidates)){
      const full=path.join(root,name);
      const st=fs.lstatSync(full);
      if(st.isSymbolicLink()||!st.isFile())throw Error(`拒绝链接或非普通文件：${name}`);
      if(st.size>8*1024*1024)throw Error(`文件过大，需要单独审查：${name}`);
      inspect(name,fs.readFileSync(full),allowed);
    }
    for(const name of allowed)if(!fs.existsSync(path.join(root,name)))findings.push({file:name,line:0,rule:'工作树缺少清单文件'});
  }
  return {mode,checked,findings};
}

if(path.resolve(process.argv[1]||'')===fileURLToPath(import.meta.url)){
  try{
    const mode=process.argv.includes('--history')?'history':process.argv.includes('--staged')?'staged':'worktree';
    const result=checkRelease(ROOT,mode);
    console.log(JSON.stringify(result,null,2));process.exitCode=result.findings.length?1:0;
  }catch(error){console.error(`发布检查失败：${error.message}`);process.exitCode=1;}
}
