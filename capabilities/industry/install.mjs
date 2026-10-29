#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {buildPackages,installPackages} from './lib.mjs';

process.umask(0o077);
const args=process.argv.slice(2),mode=args.shift(),bindingsPath=args.shift();
if(!['export','install'].includes(mode)||!bindingsPath)throw Error('Usage: node install.mjs export BINDINGS.json OUTPUT_DIR | install BINDINGS.json PRIVATE_AUTH.json STATE.json');
const bindings=JSON.parse(await fs.readFile(bindingsPath,'utf8'));
if(mode==='export'){
 const target=args.shift();if(!target)throw Error('OUTPUT_DIR required');
 for(const item of await buildPackages(bindings)){
  const folder=path.resolve(target,item.directory);await fs.mkdir(folder,{recursive:true,mode:0o700});
  await fs.writeFile(path.join(folder,'SKILL.md'),item.skill.config.source,{mode:0o600});
  for(const f of item.skill.config.files){const file=path.join(folder,f.path);await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});await fs.writeFile(file,f.content,{mode:f.executable?0o700:0o600});}
 }
 console.log('Complete four Skill directories exported; import via existing administrator directory import and bind local dependencies.');
}else{
 const authPath=args.shift(),statePath=args.shift();if(!authPath||!statePath)throw Error('Private auth file and persistent installation state required');
 const st=await fs.lstat(authPath);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077)||(process.getuid&&st.uid!==process.getuid()))throw Error('Auth must be a regular owner-only file (0600)');
 const auth=JSON.parse(await fs.readFile(authPath,'utf8'));let cookie='';const origin=new URL(bindings.adminOrigin);
 if(origin.protocol!=='https:'||origin.username||origin.password||origin.pathname!=='/'||!bindings.clientId)throw Error('Explicit HTTPS adminOrigin and clientId required');
 const request=async(route,method='GET',input)=>{
  const response=await fetch(origin.origin+'/api'+route,{method,headers:{Origin:origin.origin,clientid:bindings.clientId,...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(60000)});
  for(const value of response.headers.getSetCookie())if(value.startsWith('__Host-workspace-rc2='))cookie=value.split(';')[0];
  const value=await response.json();if(!response.ok||value.code!==200)throw Error('Control API rejected '+route+' HTTP'+response.status+' code '+value.code+' '+String(value.msg||'').slice(0,300));return value.data;
 };
 await request('/auth/login','POST',{username:auth.username,password:auth.password,clientId:bindings.clientId,grantType:'password'});
 const result=await installPackages(request,bindings,statePath);console.log(JSON.stringify(result.map(x=>({id:x.id,version:x.packageVersion,skillVersion:x.skill.version,assistantVersion:x.assistant.version,status:'published'})),null,2));
}
