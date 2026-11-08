import fs from 'node:fs';import path from 'node:path';import {randomUUID} from 'node:crypto';
import {QrAuth,verifyAccount} from './vendor/dsh-bili-whale/auth.js';
import {parseManualCookie,AuthError} from './vendor/dsh-bili-whale/credentials.js';
export function createBilibiliAuth({stateDir,transport,now=Date.now,renderQr}){
 const dir=path.join(stateDir,'bilibili'),file=path.join(dir,'credentials.json');let tail=Promise.resolve(),generation=0;
 const read=()=>{if(!fs.existsSync(file))return null;try{return parseManualCookie(JSON.parse(fs.readFileSync(file,'utf8')));}catch{throw new AuthError('B站凭据无法读取，请重新扫码');}};
 const accountFile=path.join(dir,'account.json');
 function status(){let account=null;try{account=JSON.parse(fs.readFileSync(accountFile,'utf8'));}catch{}return {loggedIn:!!read(),account,commentsEnabled:false};}
 function save(input,{signal,check=()=>{}}={}){
  const task=tail.then(async()=>{
   const cred=parseManualCookie(input),old=fs.existsSync(file)?fs.readFileSync(file):null;
   const account=await verifyAccount(cred,{fetch:transport.fetch,signal});check();
   if(signal?.aborted)throw new AuthError('登录已取消，旧登录态保留');
   const current=fs.existsSync(file)?fs.readFileSync(file):null;
   if((old===null)!==(current===null)||old&&current&&!old.equals(current))throw new AuthError('登录态已在别处改变，旧态未替换');
   fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
   if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw new AuthError('凭据目标无效');
   if(old)fs.writeFileSync(file+'.bak-'+now(),old,{mode:0o600,flag:'wx'});
   const tmp=file+'.'+randomUUID()+'.tmp';
   try{fs.writeFileSync(tmp,JSON.stringify(cred),{mode:0o600,flag:'wx'});check();if(signal?.aborted)throw Error('cancelled');fs.renameSync(tmp,file);fs.chmodSync(file,0o600);}
   finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
   const af=accountFile+'.tmp';fs.writeFileSync(af,JSON.stringify(account),{mode:0o600});fs.renameSync(af,accountFile);generation++;
   return account;
  });tail=task.catch(()=>{});return task;
 }
 const qr=new QrAuth({save,fetch:transport.fetch,now,...(renderQr?{render:renderQr}:{})});
 return {file,read,save,status,start:()=>qr.start(),poll:id=>qr.poll(id),cancel:id=>qr.cancel(id),dispose:()=>qr.dispose(),generation:()=>fs.existsSync(file)?String(fs.statSync(file).mtimeMs)+':'+fs.statSync(file).size:'none'};
}
