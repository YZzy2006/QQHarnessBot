// Interactive operator helper. No model calls or QQ messages. Credentials never leave stateDir.
import fs from'node:fs';import path from'node:path';
import{createBilibiliTransport}from'../src/bilibili-transport.js';import{createBilibiliAuth}from'../src/bilibili-auth.js';
const stateDir=path.resolve(process.argv[2]||'state'),dir=path.join(stateDir,'bilibili');
fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(dir,0o700);
const auth=createBilibiliAuth({stateDir,transport:createBilibiliTransport({stateDir})});
const challenge=await auth.start(),file=path.join(dir,'login-qr.png');
const m=/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(challenge.image);if(!m)throw Error('QR generation failed');
fs.writeFileSync(file,Buffer.from(m[1],'base64'),{mode:0o600});
console.log(JSON.stringify({status:'waiting',imagePath:file,expiresAt:challenge.expiresAt}));
for(;;){
 await new Promise(r=>setTimeout(r,2200));const s=await auth.poll(challenge.id);
 if(s.status==='waiting'||s.status==='scanned')continue;
 console.log(JSON.stringify({status:s.status,loggedIn:s.status==='success',commentsEnabled:false}));
 if(fs.existsSync(file))fs.unlinkSync(file);
 process.exitCode=s.status==='success'?0:2;break;
}
