import http from 'node:http';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID,randomBytes} from 'node:crypto';
import {RuntimeClient} from '../manager/src/runtime-client.ts';
import {createRuntimeNetwork} from '../manager/src/networking.ts';
import {config,serviceToken,service,verify,control,body,reply} from './common.mjs';
const exec=promisify(execFile),prefix='wb-rc2',clients=new Map(),acquiring=new Map();
const docker=async args=>(await exec('docker',args,{timeout:90000,maxBuffer:4000000})).stdout.trim();
async function inspect(kind,name){try{return JSON.parse(await docker([kind,'inspect',name]))[0];}catch{return null;}}
async function gateway(route,payload){const r=await fetch('http://127.0.0.1:3585/'+route,{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.timeout(15000)});if(!r.ok)throw Error('GatewayUnavailable');}
function normalize(snapshot){return(snapshot.events||[]).filter(e=>['user/message','assistant/message'].includes(e.type)).map(e=>{const m=e.type==='user/message'?e.data:e.data.message;return{role:e.type==='user/message'?'user':'assistant',content:(m?.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('')};}).filter(m=>m.content);}
async function acquire(owner){
 if(clients.has(owner))return clients.get(owner);if(acquiring.has(owner))return acquiring.get(owner);
 const pending=(async()=>{
 const network=prefix+'-'+owner,name=prefix+'-rt-'+owner,instanceId=randomUUID();const old=await inspect('container',name);
 if(old){if(old.Config.Labels?.['workspace.owner']!==owner||old.Config.Labels?.['workspace.deployment']!==prefix)throw Error('PermissionDenied');await docker(['rm','-f',name]);}
 const net=await inspect('network',network);if(net&&(!net.Internal||net.Labels?.['workspace.owner']!==owner))throw Error('PermissionDenied');if(!net)await createRuntimeNetwork(docker,network,owner,prefix,'10.233.0.0/16');
 const gw=await inspect('container','wb-rc2-gateway');if(!gw?.State?.Running||gw.Config.Labels?.['workspace.product']!=='rc2-execution-gateway')throw Error('GatewayUnavailable');if(!gw.NetworkSettings.Networks[network])await docker(['network','connect','--alias','model-gateway',network,'wb-rc2-gateway']);
 const volumes=[network+'-workspace',network+'-home'];for(const volume of volumes){const v=await inspect('volume',volume);if(v&&v.Labels?.['workspace.owner']!==owner)throw Error('PermissionDenied');if(!v)await docker(['volume','create','--label','workspace.owner='+owner,'--label','workspace.deployment='+prefix,volume]);}
 await docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--cap-add','CHOWN','--user','0:0','--memory','128m','--pids-limit','32','--mount',`type=volume,src=${volumes[0]},dst=/workspace`,'--mount',`type=volume,src=${volumes[1]},dst=/data/home`,config.runtimeImage,'node','-e',"require('fs').chownSync('/workspace',10001,10001);require('fs').chownSync('/data/home',10001,10001)"]);
 const modelToken=randomBytes(32).toString('hex'),toolToken=randomBytes(32).toString('hex');
 await docker(['run','-d','--name',name,'--label','workspace.deployment='+prefix,'--label','workspace.owner='+owner,'--label','workspace.instance='+instanceId,'--network',network,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','10001:10001','--memory','768m','--cpus','1','--pids-limit','96','--tmpfs','/tmp:rw,noexec,nosuid,size=64m','--env','WORKSPACE_OWNER='+owner,'--env','WORKSPACE_MODEL_TOKEN='+modelToken,'--env','WORKSPACE_TOOL_TOKEN='+toolToken,'--mount',`type=volume,src=${volumes[0]},dst=/workspace`,'--mount',`type=volume,src=${volumes[1]},dst=/data/home`,'--mount',`type=bind,src=${path.join(import.meta.dirname,'runtime.patch.yml')},dst=/opt/workspace/runtime.patch.yml,readonly`,'--mount',`type=bind,src=${path.join(import.meta.dirname,'start.mjs')},dst=/opt/workspace/start.mjs,readonly`,'--mount',`type=bind,src=${path.join(import.meta.dirname,'bridge.mjs')},dst=/opt/workspace/bridge.mjs,readonly`,config.runtimeImage]);
 const detail=await inspect('container',name),ip=detail.NetworkSettings.Networks[network].IPAddress,client=new RuntimeClient(name);const entry={client,owner,instanceId,modelToken,toolToken,ip,current:null,chain:Promise.resolve(),lastActive:Date.now()};
 client.on('exit',()=>clients.delete(owner));client.on('message',frame=>{const run=entry.current;if(!run||frame.sessionId!==run.sessionId)return;entry.chain=entry.chain.then(async()=>{
  if(frame.event==='approval')await control('approvals',{executionGrant:run.grant,approvalId:frame.id,resourceId:frame.resourceId,callId:frame.callId,argsHash:frame.argsHash,arguments:frame.arguments});
  if(frame.event==='session'&&frame.data?.type==='tool/call'){const call=frame.data.data;run.calls??=new Map();run.calls.set(call.callId,call.name);await control('events',{executionGrant:run.grant,eventId:randomUUID(),type:'tool.started',payload:{callId:call.callId,name:call.name}});}
  if(frame.event==='session'&&frame.data?.type==='tool/result'){const block=frame.data.data.message?.content?.[0];if(block){await control('events',{executionGrant:run.grant,eventId:randomUUID(),type:block.isError?'tool.failed':'tool.completed',payload:{callId:block.toolCallId,name:run.calls?.get(block.toolCallId)||'unknown'}});}}
  if(frame.event==='stream'&&frame.frame?.chunk?.type==='text-delta'){await control('events',{executionGrant:run.grant,eventId:randomUUID(),type:'message.delta',payload:{messageId:run.messageId,delta:frame.frame.chunk.text}});}
 }).catch(()=>{run.failed=true;void client.request('cancel',{sessionId:run.sessionId}).catch(()=>{});});});
 await client.start();clients.set(owner,entry);return entry;
 })();acquiring.set(owner,pending);try{return await pending;}finally{acquiring.delete(owner);}
}
const server=http.createServer(async(req,res)=>{try{
 service(req);if(req.method!=='POST'||req.url!=='/command')return reply(res,404,{code:'NotFound'});const q=await body(req);if(q.method==='health'){let gatewayState='UNAVAILABLE';try{const h=await fetch('http://127.0.0.1:3585/health',{signal:AbortSignal.timeout(3000)});if(h.ok&&(await h.json()).ready)gatewayState='READY';}catch{}return reply(res,200,{ready:true,adapter:'DeepSeekHarnessAdapter',gateway:gatewayState,runtimes:[...clients.values()].map(e=>({ownerUserId:e.owner,instanceId:e.instanceId,state:e.current?'RUNNING':'IDLE',lastActive:new Date(e.lastActive).toISOString()}))});}
 const claims=verify(q.executionGrant);if(['cancel','shutdown'].includes(q.method)){const e=clients.get(claims.userId);if(e){if(q.method==='cancel'){if(e.current?.runId===claims.runId)await e.client.request('cancel',{sessionId:claims.sessionId});}else{await e.client.close();await docker(['stop','-t','1',prefix+'-rt-'+claims.userId]);clients.delete(claims.userId);}}return reply(res,200,{stopped:true});}
 if(['approve','deny'].includes(q.method)){await control('check',{executionGrant:q.executionGrant});const entry=clients.get(claims.userId);if(!entry||entry.current?.runId!==claims.runId)throw Error('PermissionDenied');await entry.client.request('approval',{sessionId:claims.sessionId,approvalId:q.approvalId,decision:q.method==='approve'?'allow':'deny'});return reply(res,200,{decided:true});}
 const approved=await control('check',{executionGrant:q.executionGrant});const e=await acquire(claims.userId);e.lastActive=Date.now();if(e.current&&e.current.runId!==claims.runId)await e.client.request('cancel',{sessionId:e.current.sessionId});await gateway('register',{executionGrant:q.executionGrant,modelToken:e.modelToken,toolToken:e.toolToken,runtimeIp:e.ip,instanceId:e.instanceId});
 const policy={model:'workspace-selected',maxTokens:approved.config.max_output_tokens,systemPrompt:approved.config.system_prompt||'你是企业 AI 助手，请用准确简洁的中文回答。',skills:approved.config.skills||[],mcps:approved.config.mcps||[],workspaceTools:approved.config.workspaceTools||[],attachments:approved.config.attachments||[],tools:[...(approved.config.skills?.length?['skill']:[]),...(approved.config.knowledge?.length?['knowledge_search']:[]),...(approved.config.attachments?.length?['attachment_read']:[])]};
 if(q.method==='createSession'||q.method==='resumeSession'){await e.client.request(q.method==='createSession'?'create':'resume',{sessionId:claims.sessionId,policy});return reply(res,200,{sessionId:claims.sessionId});}
 if(q.method==='history'||q.method==='streamEvents'){const result=await e.client.request('snapshot',{sessionId:claims.sessionId});return reply(res,200,{messages:normalize(result)});}
 if(q.method!=='sendMessage')throw Error('UnsupportedOperation');if(typeof q.text!=='string'||q.text.length>12000)throw Error('InvalidRequest');
 const run={runId:claims.runId,sessionId:claims.sessionId,grant:q.executionGrant,messageId:randomUUID(),failed:false};e.current=run;
 try{await control('events',{executionGrant:run.grant,eventId:randomUUID(),type:'message.started',payload:{messageId:run.messageId,role:'assistant'}});const result=await e.client.request('prompt',{sessionId:claims.sessionId,text:q.text},300000);await e.chain;
 const end=result.events?.findLast(x=>x.type==='turn/end');if(run.failed||end?.data?.reason?.kind!=='completed')throw Error('RuntimeError');const text=normalize(result).findLast(x=>x.role==='assistant')?.content;if(!text)throw Error('EmptyModelResponse');
 await control('events',{executionGrant:run.grant,eventId:randomUUID(),type:'message.completed',payload:{messageId:run.messageId,content:text,role:'assistant'}});return reply(res,200,{status:'COMPLETED'});
 }finally{if(e.current===run)e.current=null;e.lastActive=Date.now();}
 }catch(e){reply(res,e.message==='PermissionDenied'?403:503,{code:['PermissionDenied','UnsupportedOperation'].includes(e.message)?e.message:'RuntimeUnavailable'});}});
server.listen(3584,'127.0.0.1',()=>console.log(JSON.stringify({service:'rc2-execution-manager',ready:true})));
const idle=setInterval(async()=>{for(const [owner,e] of clients)if(!e.current&&Date.now()-e.lastActive>900000){await e.client.close().catch(()=>{});await docker(['stop','-t','1',prefix+'-rt-'+owner]).catch(()=>{});clients.delete(owner);}},30000);idle.unref();
process.on('SIGTERM',()=>server.close(async()=>{for(const e of clients.values())await e.client.close().catch(()=>{});process.exit(0);}));
