import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from '@playwright/test';

// Dedicated fixtures only. No credentials, cookies, message bodies or provider secrets in evidence.
const root=path.resolve(import.meta.dirname,'../..');process.chdir(root);
const state=path.join(root,'.state/local-acceptance'),privateDir=path.join(root,'.state/rc2');
const out=path.join(root,'evidence/v1/rc2/r1/performance');fs.mkdirSync(out,{recursive:true});
const users=JSON.parse(fs.readFileSync(path.join(privateDir,'perf-users.json')));
const meta=JSON.parse(fs.readFileSync(path.join(state,'deployment.json')));
const originals=Object.fromEntries(['server.json','Caddyfile'].map(f=>[f,fs.readFileSync(path.join(state,f))]));
const publicOrigin=JSON.parse(originals['server.json']).publicOrigin;
const compose=(...args)=>execFileSync('docker',['compose','--env-file',path.join(state,'deploy.env'),'-f','deploy/v1/docker-compose.prod.yml',...args],{stdio:['ignore','pipe','pipe']});
const summary=rows=>{const valid=rows.filter(x=>x.ok).map(x=>x.ms).sort((a,b)=>a-b);return {samples:rows.length,successes:valid.length,p50Ms:valid.length?valid[Math.ceil(valid.length*.50)-1]:null,p95Ms:valid.length?valid[Math.ceil(valid.length*.95)-1]:null,errorRate:rows.filter(x=>!x.ok).length/rows.length};};
let browser;
const report={startedAt:new Date().toISOString(),status:'RUNNING',baseline:'RC1 Technical Baseline',sourceCommit:meta.sourceCommit,images:meta.images,runtimeDigest:meta.runtimeDigest,environment:{os:os.platform(),arch:os.arch(),release:os.release(),cpus:os.cpus().length,memoryBytes:os.totalmem(),node:process.version,browser:'installed Google Chrome, headless',parallelism:1},dataset:'dedicated synthetic benchmark accounts on unchanged RC1 data; each transport creates two benchmark conversations',promptSha256:createHash('sha256').update('只回复四个字：测试成功。不要调用工具。').digest('hex'),modes:[]};
const save=()=>fs.writeFileSync(path.join(out,'baseline.json'),JSON.stringify(report,null,2)+'\n');
async function request(origin,route,{cookie,body}={}){const r=await fetch(origin+'/api'+route,{method:body?'POST':'GET',headers:{origin,...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(45000)});const data=await r.json().catch(()=>null);return {status:r.status,data,cookie:r.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ')};}
async function ready(origin){for(let n=0;n<45;n++){try{if((await request(origin,'/brand')).status===200)return;}catch{}await delay(1000);}throw Error('Entry not ready');}
async function measure(mode,origin){
 const result={transport:mode,apis:{},pages:{},ai:[],originType:mode==='local'?'trusted localhost HTTPS':'Cloudflare Quick Tunnel HTTPS'};report.modes.push(result);save();
 await ready(origin);
 for(const [name,user] of Object.entries(users)){
  const login=await request(origin,'/auth/sign-in/email',{body:{email:user.email,password:user.password}});if(login.status!==200)throw Error('Benchmark login failed '+login.status);
  for(const route of name==='admin'?['/admin/users']:['/me','/assistants','/sessions']){
   const rows=[];for(let n=0;n<30;n++){const t=performance.now();try{const r=await request(origin,route,{cookie:login.cookie});rows.push({ms:performance.now()-t,ok:r.status===200,status:r.status});}catch{rows.push({ms:performance.now()-t,ok:false,status:null});}}
   result.apis[route]={...summary(rows),raw:rows};save();console.log(JSON.stringify({mode,route,...summary(rows)}));
  }
 }
 const context=await browser.newContext({viewport:{width:1440,height:1000}});const page=await context.newPage();page.setDefaultTimeout(45000);
 try{
  await page.goto(origin);await page.getByLabel('邮箱',{exact:true}).fill(users.employee.email);await page.getByLabel('密码',{exact:true}).fill(users.employee.password);await page.getByRole('button',{name:'登录',exact:true}).click();await page.getByRole('button',{name:'开始新任务',exact:true}).waitFor();
  const rows=[];for(let n=0;n<30;n++){const t=performance.now();try{await page.goto(origin);await page.getByRole('button',{name:'开始新任务',exact:true}).waitFor();rows.push({ms:performance.now()-t,ok:true});}catch{rows.push({ms:performance.now()-t,ok:false});}}
  result.pages.employeeReload={...summary(rows),cache:'same browser context, HTTP cache retained, full document navigation',raw:rows};save();console.log(JSON.stringify({mode,page:'employeeReload',...summary(rows)}));
  // Force cold only for the dedicated benchmark owner, never another employee.
  const names=execFileSync('docker',['ps','-q','--filter','label=workspace.deployment='+meta.id,'--filter','label=workspace.owner='+users.employee.id],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
  for(const id of names)execFileSync('docker',['stop','-t','2',id],{stdio:'ignore'});
  for(const temperature of ['cold','warm']){
   await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByLabel('消息',{exact:true}).waitFor();await page.getByLabel('消息',{exact:true}).fill('只回复四个字：测试成功。不要调用工具。');
   const timings={temperature,uiResponseMs:null,apiEnqueueMs:null,runtimeAcquireMs:null,runtimeWarmupMs:null,gatewayRequestMs:null,providerTtfbMs:null,modelFirstTokenMs:null,firstVisibleTokenMs:null,totalCompletionMs:null,status:'RUNNING',missingSpans:'RC1 has no correlated internal timing spans; null is unmeasured, not zero.'};result.ai.push(timings);
   const apiStart=new Map();const onRequest=r=>{if(r.url().endsWith('/prompt'))apiStart.set(r,performance.now());};const onResponse=r=>{const t=apiStart.get(r.request());if(t!==undefined)timings.apiEnqueueMs=performance.now()-t;};page.on('request',onRequest);page.on('response',onResponse);
   await page.evaluate(()=>{window.__rc2perf={start:performance.now(),ui:null,first:null};const p=window.__rc2perf;window.__rc2observer?.disconnect();window.__rc2observer=new MutationObserver(()=>{if(!p.ui&&document.querySelector('[data-testid="terminal"]')?.textContent?.includes('正在处理'))p.ui=performance.now()-p.start;const messages=[...document.querySelectorAll('.mr-auto.max-w-full p')];if(!p.first&&messages.some(e=>e.textContent.trim()))p.first=performance.now()-p.start;});window.__rc2observer.observe(document.body,{childList:true,subtree:true,characterData:true});});
   const t=performance.now();await page.getByRole('button',{name:'发送',exact:true}).click();
   try{await page.getByTestId('terminal').filter({hasText:'已完成'}).waitFor({timeout:180000});timings.status='COMPLETED';timings.totalCompletionMs=performance.now()-t;}catch{timings.status='FAILED_OR_TIMEOUT';timings.totalCompletionMs=performance.now()-t;}
   const observed=await page.evaluate(()=>{window.__rc2observer.disconnect();return window.__rc2perf;});timings.uiResponseMs=observed.ui;timings.firstVisibleTokenMs=observed.first;
   page.off('request',onRequest);page.off('response',onResponse);save();console.log(JSON.stringify({mode,...timings}));
  }
 }finally{await context.close();}
}
try{
 browser=await chromium.launch({channel:'chrome',headless:true});
 execFileSync(process.execPath,['scripts/ops/remote-origin.mjs','disable','--state',state],{stdio:'ignore'});
 await measure('local',meta.origin);
 for(const [f,bytes] of Object.entries(originals))fs.writeFileSync(path.join(state,f),bytes,{mode:0o600});compose('restart','bff','entry');
 await measure('quick-tunnel',publicOrigin);
 report.status=report.modes.every(m=>Object.values(m.apis).every(a=>a.errorRate===0)&&Object.values(m.pages).every(a=>a.errorRate===0)&&m.ai.every(a=>a.status==='COMPLETED'))?'MEASURED':'MEASURED_WITH_ERRORS';
}catch(e){report.status='INCOMPLETE';report.error=e.message;throw e;}
finally{
 await browser?.close();for(const [f,bytes] of Object.entries(originals))fs.writeFileSync(path.join(state,f),bytes,{mode:0o600});compose('restart','bff','entry');report.finishedAt=new Date().toISOString();save();
}
