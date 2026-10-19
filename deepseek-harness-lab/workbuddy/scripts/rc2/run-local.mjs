import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2');
const toolchain=path.join(root,'.state/rc2-toolchain');
if(!fs.existsSync(path.join(state,'bootstrap.initialized')))throw Error('Run init-local first; example credentials must be replaced');
const home=fs.readdirSync(toolchain).map(x=>path.join(toolchain,x,'Contents/Home')).find(x=>fs.existsSync(path.join(x,'bin/java')));
if(!home)throw Error('Verified Java 21 installation missing');
const version=execFileSync(path.join(home,'bin/java'),['--version'],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
if(!/openjdk 21\./.test(version))throw Error('Java 21 required');
const builtJar=path.join(root,'platform/ruoyi/ruoyi-admin/target/ruoyi-admin.jar');
if(!fs.existsSync(builtJar))throw Error('Build ruoyi-admin first');
const release=fs.readFileSync(builtJar),digest=createHash('sha256').update(release).digest('hex');
const releaseDir=path.join(state,'releases');fs.mkdirSync(releaseDir,{recursive:true,mode:0o700});
const jar=path.join(releaseDir,digest+'.jar');if(!fs.existsSync(jar))fs.writeFileSync(jar,release,{mode:0o600,flag:'wx'});
const record=path.join(state,'processes.json');
let processes=fs.existsSync(record)?JSON.parse(fs.readFileSync(record)):{};
function alive(pid){try{process.kill(pid,0);return true;}catch{return false;}}
function start(name,command,args,cwd){
 if(processes[name]&&alive(processes[name].pid))return;
 const log=fs.openSync(path.join(state,name+'.log'),'a',0o600);
 const child=spawn(command,args,{cwd,detached:true,stdio:['ignore',log,log],env:{...process.env,JAVA_HOME:home,WORKSPACE_RC2_EXECUTION_CONFIG:path.join(state,'execution-host.json')}});child.unref();fs.closeSync(log);
 processes[name]={pid:child.pid,command,args,startedAt:new Date().toISOString()};fs.writeFileSync(record,JSON.stringify(processes,null,2),{mode:0o600});
}
start('backend',path.join(home,'bin/java'),['-Xms128m','-Xmx768m','-jar',jar,'--spring.profiles.active=rc2','--spring.config.additional-location=file:'+state+'/'],state);
start('employee',process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3583'],path.join(root,'apps/web'));
start('execution',process.execPath,[path.join(root,'apps/execution-rc2/manager.mjs')],root);
start('admin',process.execPath,['node_modules/vite/bin/vite.js','preview','--mode','rc2','--host','127.0.0.1','--port','3581','--strictPort'],path.join(root,'platform/plus-ui'));
for(let i=0;i<90;i++){
 if(!alive(processes.backend.pid))throw Error('Backend exited; see private backend.log');
 try{const r=await fetch('http://127.0.0.1:3580/auth/code',{signal:AbortSignal.timeout(2000)});if(r.ok){console.log(JSON.stringify({status:'STARTED',backend:'http://127.0.0.1:3580',admin:'http://localhost:3581/admin/',production:false}));process.exit(0);}}catch{}
 await delay(1000);
}
throw Error('Backend readiness timeout; see private backend.log');
