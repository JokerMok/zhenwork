import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID,createHash,createHmac} from 'node:crypto';import {execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2'),out=path.join(root,'evidence/v1/rc2/'+(process.env.RC2_PHASE||'r10')),origin='https://localhost:3582',admin=JSON.parse(fs.readFileSync(path.join(state,'bootstrap.json'))),users=JSON.parse(fs.readFileSync(path.join(state,'employees.json')));
const report={date:new Date().toISOString(),status:'RUNNING',checks:[]},sql=q=>execFileSync('docker',['compose','-f',path.join(state,'compose.json'),'exec','-T','db','psql','-U','workspace_rc2','-d','workspace_rc2','-At'],{input:q,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
async function req(route,cookie,method='GET',body){const r=await fetch(origin+'/api'+route,{method,signal:AbortSignal.timeout(15000),headers:{Origin:origin,clientid:admin.clientId,'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});return {http:r.status,data:await r.json(),cookie:r.headers.getSetCookie().at(-1)?.split(';')[0]};}
async function ok(route,cookie,method,body){const r=await req(route,cookie,method,body);assert.equal(r.data.code,200,route+': '+r.data.msg);return r.data.data;}
async function login(u){const r=await req('/auth/login',null,'POST',{...u,clientId:admin.clientId,grantType:'password'});assert.equal(r.data.code,200);return r.cookie;}
async function resource(cookie,type,name,config){const r=await ok('/ai/resources',cookie,'POST',{resourceType:type,name,config,idempotencyKey:randomUUID()});await ok('/ai/resources/'+r.id+'/activate',cookie,'POST',{version:1});return r;}
async function poll(read,accept,n=300){for(let i=0;i<n;i++){const result=await read();if(accept(result))return result;if(result?.runs?.[0]?.status==='FAILED')throw Error('Run failed: '+result.runs[0].errorCode);await delay(100);}throw Error('Expected state not reached');}
async function upload(route,cookie,name,content,fields={}){const form=new FormData();form.set('file',new Blob([content]),name);for(const[k,v]of Object.entries(fields))form.set(k,String(v));const r=await fetch(origin+'/api'+route,{method:'POST',headers:{Origin:origin,clientid:admin.clientId,cookie},body:form});return {http:r.status,data:await r.json()};}
try{
 const a=await login(users[0]),b=await login(users[1]),ad=await login(admin),modelId=(await ok('/ai/models/available',a)).find(x=>x.name==='Doubao Seed 2.0 Mini').id,bId=(await ok('/ai/me',b)).userId;
 const kb=await resource(a,'KNOWLEDGE','R10 版本撤回',{format:'TEXT_V1'}),assistant=await resource(a,'ASSISTANT','R10 共享知识助手',{modelId,instruction:'必须调用 knowledge_search 搜索“山茶”。先报告查到的批准编号并引用，再遵循用户要求。',knowledgeIds:[kb.id]});report.baseId=kb.id;
 const doc=(await upload('/ai/knowledge/'+kb.id+'/documents',a,'山茶.md','山茶批准编号为 R10-CAMELLIA-V1。',{idempotencyKey:randomUUID()})).data.data;
 await poll(()=>ok('/ai/knowledge/'+kb.id+'/jobs',a),rows=>rows.some(j=>j.id===doc.jobId&&j.status==='COMPLETED'));
 await ok('/ai/resources/'+assistant.id+'/shares',a,'POST',{subjectType:'USER',subjectId:bId,actions:['VIEW','USE']});
 const s=(await ok('/ai/sessions',b,'POST',{modelId,assistantId:assistant.id,title:'R10 version/revoke',idempotencyKey:randomUUID()})).id;report.sessionId=s;
 assert.equal((await req('/ai/sessions/'+s+'/runs',b,'POST',{text:'查询山茶。',idempotencyKey:randomUUID()})).http,404);
 const share=await ok('/ai/resources/'+kb.id+'/shares',a,'POST',{subjectType:'USER',subjectId:bId,actions:['VIEW','USE']});
 const run=(await ok('/ai/sessions/'+s+'/runs',b,'POST',{text:'查询山茶批准编号，然后逐个列出从 1 到 1000 的编号，不得省略。',idempotencyKey:randomUUID()})).runId;
 await poll(()=>ok('/ai/sessions/'+s,b),h=>h.citations.length>0,900);
 const update=(await upload('/ai/knowledge/'+kb.id+'/documents',a,'山茶.md','山茶批准编号为 R10-CAMELLIA-V2。',{idempotencyKey:randomUUID(),documentId:doc.id,expectedVersion:1})).data.data;
 await poll(()=>ok('/ai/knowledge/'+kb.id+'/jobs',a),rows=>rows.some(j=>j.id===update.jobId&&j.status==='COMPLETED'));
 assert.equal(sql(`SELECT version FROM ai_run_document WHERE run_id='${run}';`),'1');const h=await ok('/ai/sessions/'+s,b);assert.equal(h.citations[0].version,1);assert.match((await ok('/ai/citations/'+h.citations[0].id,b)).content,/R10-CAMELLIA-V1/);await ok('/ai/sessions/'+s+'/cancel',b,'POST',{});
 const run2=(await ok('/ai/sessions/'+s+'/runs',b,'POST',{text:'重新检索山茶，返回最新批准编号，然后逐个列出从 1 到 1000 的编号，不得省略。',idempotencyKey:randomUUID()})).runId;
 await poll(()=>ok('/ai/sessions/'+s,b),h=>h.citations.some(c=>c.version===2),900);assert.equal(sql(`SELECT version FROM ai_run_document WHERE run_id='${run2}';`),'2');
 const {WebSocket}=await import('ws'),ws=new WebSocket('wss://localhost:3582/ws?sessionId='+s,{headers:{cookie:b,Origin:origin}});ws.on('error',()=>{});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});const closed=new Promise(resolve=>ws.once('close',resolve));
 await ok('/ai/resources/'+kb.id+'/shares/'+share.id,a,'DELETE');assert.equal(sql(`SELECT status FROM ai_run WHERE id='${run2}';`),'CANCELLED');assert.equal(await Promise.race([closed,delay(5000).then(()=>-1)]),1008);ws.close();
 for(const route of['/ai/knowledge/'+kb.id+'/search?query=test','/ai/knowledge/documents/'+doc.id+'/versions/1','/ai/files/'+doc.fileId+'/download','/ai/citations/'+h.citations[0].id,'/ai/sessions/'+s])assert.equal((await req(route,b)).http,404,route);
 assert.equal((await req('/ai/sessions/'+s+'/runs',b,'POST',{text:'接着说。',idempotencyKey:randomUUID()})).http,404);
 report.checks.push('shared Assistant never grants knowledge dependency; run V1 stays pinned after document V2 indexing; next real run searches V2; knowledge share revoke cancels in-flight run, closes WSS and blocks search/source/citation/download/history/new run');report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;process.exitCode=1;}
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'knowledge-revoke-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
