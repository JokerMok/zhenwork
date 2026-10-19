/** External Harness plugin. Stdio is the only control plane; no listening Runtime port. */
import fs from 'node:fs';import path from 'node:path';import readline from 'node:readline';import {randomUUID} from 'node:crypto';
import {createUserMessage} from '/opt/harness/packages/llm/llm/lib/index.js';
import {defineTool} from '/opt/harness/packages/core/tools/lib/index.js';
import {searchKnowledge} from './knowledge.mjs';
export const name='workbuddy-boundary-bridge';
export const inject=['agents','agentLoop','sessions','tools','approval','sdkAppStartup','sessionQuery'];
const owner=process.env.WB_OWNER,model=process.env.WB_MODEL;
const allowed=['read','write','bash','skill','mcp__boundary__search','boundary_action','boundary_wait'];
const identity=/^[a-f0-9-]{36}$/;
function allowedFile(file,writing=false){
 if(typeof file!=='string'||file.includes('\0'))return false;
 const p=path.resolve('/workspace',file);let actual;
 try{actual=fs.realpathSync(p);}catch{try{actual=path.join(fs.realpathSync(path.dirname(p)),path.basename(p));}catch{return false;}}
 return (writing?['/workspace']:['/workspace','/knowledge','/skills']).some(root=>actual===root||actual.startsWith(root+'/'));
}
export function apply(ctx){
 const handles=new Map(),pending=new Map();
 const emit=x=>process.stdout.write(JSON.stringify(x)+'\n');
 ctx.on('session/event',(s,event)=>emit({event:'session',sessionId:s.id,data:event}));
 ctx.on('agent/assistant-stream',function({agent,frame}){emit({event:'stream',sessionId:agent.id,frame});});
 ctx.on('approval/request',async(req)=>{
  const id=randomUUID();emit({event:'approval',id,sessionId:req.agent.session.id,tool:req.toolName,reason:req.reason});
  return await new Promise(resolve=>{const finish=value=>{clearTimeout(timer);pending.delete(id);resolve(value);};const timer=setTimeout(()=>finish('unavailable'),30000);pending.set(id,{sessionId:req.agent.session.id,finish});req.signal?.addEventListener('abort',()=>finish('cancelled'),{once:true});});
 });
 ctx.tools.guard(exec=>{
  if(!allowed.includes(exec.name))return 'ENTERPRISE_TOOL_DENIED';
  if(['read','write'].includes(exec.name)&&!allowedFile(exec.arguments?.file_path,exec.name==='write'))return 'ENTERPRISE_PATH_DENIED';
 });
 ctx.tools.register(defineTool({name:'boundary_action',description:'Write a synthetic approval marker after explicit human approval. Use label allow or deny as requested.',parameters:{label:{type:'string',required:true}},output:{schema:{type:'object',properties:{written:{type:'boolean',required:true}},additionalProperties:false},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async args=>{if(!['allow','deny'].includes(args.label))throw Error('INVALID_LABEL');fs.writeFileSync('/workspace/approval-'+args.label+'.txt','APPROVED_ACTION');return{written:true};}}));
 ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='boundary_action'?{kind:'ask',reason:'Synthetic write requires owner approval'}:next());
 ctx.tools.register(defineTool({name:'boundary_wait',description:'Wait up to 20 seconds for a cancellable synthetic operation.',parameters:{},output:{schema:{type:'object',properties:{done:{type:'boolean',required:true}},additionalProperties:false},render:(_a,v)=>[{type:'text',text:JSON.stringify(v)}]},execute:async(_args,exec)=>{await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,20000);exec.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('CANCELLED'));},{once:true});});return{done:true};}}));
 const options={provider:'workbuddy-gateway',model,maxTokens:1024};
 const setup=(agentCtx)=>{agentCtx.tools.restrict({allow:allowed});};
 async function acquire(id,resume=false){if(!identity.test(id))throw Error('INVALID_ID');if(handles.has(id))return handles.get(id);const h=await(resume?ctx.agents.resume({resumeSessionId:id,agentOptions:options,setup}):ctx.agents.create({sessionId:id,meta:{cwd:'/workspace'},agentOptions:options,setup}));handles.set(id,h);return h;}
 async function dispatch(q){
  if(q.method==='health')return{ready:true,owner,model};
  if(q.method==='knowledge')return searchKnowledge(owner,q.args);
  if(q.method==='shutdown'){for(const h of handles.values())await h.dispose();setTimeout(()=>process.exit(0),30);return{closed:true};}
  if(!identity.test(q.sessionId||''))throw Error('INVALID_ID');
  if(q.method==='create')return{id:(await acquire(q.sessionId)).agent.id};
  if(q.method==='resume'){const old=handles.get(q.sessionId);if(old){await old.dispose();handles.delete(q.sessionId);}const h=await acquire(q.sessionId,true);return{id:h.agent.id,events:(await ctx.sessionQuery.readSession(h.agent.id)).events};}
  const h=handles.get(q.sessionId);if(!h)throw Error('NOT_FOUND');const agent=h.agent;
  if(q.method==='snapshot')return{events:(await ctx.sessionQuery.readSession(agent.id)).events,status:agent.status};
  if(q.method==='prompt'){
   if(typeof q.text!=='string'||q.text.length>12000)throw Error('INVALID_PROMPT');
   if(agent.status!=='idle')throw Error('BUSY');
   agent.followup(createUserMessage({content:[{type:'text',text:q.text}],source:{kind:'user'}}));
   await agent.whenIdle();await ctx.sessions.flush(agent.session);
   return{events:(await ctx.sessionQuery.readSession(agent.id)).events,status:agent.status};
  }
  if(q.method==='cancel'){agent.cancel({kind:'user'});await agent.whenIdle();await ctx.sessions.flush(agent.session);return{cancelled:true,events:(await ctx.sessionQuery.readSession(agent.id)).events};}
  if(q.method==='approval'){const p=pending.get(q.approvalId);if(!p||p.sessionId!==q.sessionId)throw Error('NOT_FOUND');if(!['allow','deny'].includes(q.decision))throw Error('INVALID_DECISION');p.finish(q.decision==='allow'?'allowed-once':'rejected');return{decided:true};}
  if(q.method==='tool'){if(!allowed.includes(q.name))throw Error('TOOL_DENIED');return ctx.tools.execute({name:q.name,arguments:q.args,agent,callId:'boundary-'+randomUUID(),signal:AbortSignal.timeout(10000)});}
  if(q.method==='dispose'){await h.dispose();handles.delete(q.sessionId);return{disposed:true};}
  throw Error('NOT_FOUND');
 }
 const lines=readline.createInterface({input:process.stdin});lines.on('line',line=>{let q;try{q=JSON.parse(line);}catch{return;}(async()=>{try{emit({id:q.id,result:await dispatch(q)});}catch(error){emit({id:q.id,error:{message:String(error.message).slice(0,500)}});}})();});
 setImmediate(async()=>{await ctx.get('loader')?.await();emit({event:'ready',owner,model});});
 ctx.effect(()=>()=>{lines.close();});
}
