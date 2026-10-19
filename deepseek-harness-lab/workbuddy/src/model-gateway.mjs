/** Private, fixed-upstream OpenAI chat gateway. Never logs headers, keys or prompt bodies. */
import http from 'node:http';
import fs from 'node:fs';
import {randomUUID,timingSafeEqual} from 'node:crypto';
import yaml from '/app/node_modules/js-yaml/index.js';
const cfg=JSON.parse(fs.readFileSync('/config/gateway.json','utf8'));
const credential=yaml.load(fs.readFileSync('/secret/credentials.yaml','utf8'));
const key=credential.refs?.VOLCENGINE_ARK_API_KEY;
if(typeof key!=='string'||!key){console.error('ARK_API_KEY=NOT_SET');process.exit(1);}
const upstream=new URL(cfg.baseURL);
if(upstream.protocol!=='https:'||upstream.hostname!=='ark.cn-beijing.volces.com'||upstream.pathname!=='/api/v3')throw Error('Unapproved upstream');
const tokens=JSON.parse(fs.readFileSync('/config/gateway-tokens.json','utf8'));
const counts=new Map();
function who(header){if(typeof header!=='string')return;for(const [u,t]of Object.entries(tokens)){const a=Buffer.from(header),b=Buffer.from('Bearer '+t);if(a.length===b.length&&timingSafeEqual(a,b))return u;}}
function reply(res,status,body){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));}
function record(row){fs.appendFileSync('/evidence/gateway.jsonl',JSON.stringify(row)+'\n');}
const server=http.createServer(async(req,res)=>{
 if(req.method==='GET'&&req.url==='/health'){reply(res,200,{ready:true,model:cfg.model});return;}
 const user=who(req.headers.authorization);
 if(!user){reply(res,401,{error:'unauthorized'});return;}
 if(req.method==='GET'&&req.url==='/admin/models'&&user==='probe'){
  try{const remote=await fetch(upstream.href+'/models',{headers:{authorization:'Bearer '+key},signal:AbortSignal.timeout(15000)});const value=await remote.json();reply(res,remote.status,{status:remote.status,models:(value.data||[]).filter(v=>/deepseek/i.test(v.id)).map(v=>({id:v.id,status:v.status,owned_by:v.owned_by})),code:value.error?.code});}catch{reply(res,502,{error:'MODEL_DISCOVERY_FAILED'});}return;
 }
 if(req.method!=='POST'||req.url!=='/v1/chat/completions'){reply(res,404,{error:'not found'});return;}
 const id=randomUUID(),start=Date.now();let bytes=0,body;const chunks=[];
 try{for await(const c of req){bytes+=c.length;if(bytes>512000)throw Error('body too large');chunks.push(c);}body=JSON.parse(Buffer.concat(chunks).toString());}catch{reply(res,400,{error:'invalid body'});return;}
 if(body.model!==cfg.model||!Array.isArray(body.messages)){reply(res,400,{error:'invalid model/messages'});return;}
 const count=(counts.get(user)||0)+1;counts.set(user,count);if(count>160){reply(res,429,{error:'alpha request budget exceeded'});return;}
 // Only model parameters survive. No caller URL, auth, proxy or arbitrary header forwarding.
 const allowed=['messages','tools','tool_choice','temperature','top_p','stop','stream','parallel_tool_calls'];
 const payload=Object.fromEntries(allowed.filter(k=>body[k]!==undefined).map(k=>[k,body[k]]));
 payload.model=cfg.model;payload.max_tokens=Math.min(Math.max(Number(body.max_tokens)||1024,1),2048);payload.thinking={type:'disabled'};
 if(payload.stream)payload.stream_options={include_usage:true};
 const ac=new AbortController();const timer=setTimeout(()=>ac.abort(),120000);res.on('close',()=>{if(!res.writableEnded)ac.abort();});
 const row={id,user,model:cfg.model,start:new Date(start).toISOString(),stream:!!payload.stream,toolNames:(payload.tools||[]).map(t=>t.function?.name),requestBytes:bytes};
 let usage,toolCalls=0,chunksSeen=0,firstMs=null,tail='';
 try{
  const remote=await fetch(upstream.href+'/chat/completions',{method:'POST',headers:{authorization:'Bearer '+key,'content-type':'application/json'},body:JSON.stringify(payload),signal:ac.signal});
  row.status=remote.status;row.requestId=remote.headers.get('x-request-id');
  if(!remote.ok){const err=await remote.json().catch(()=>({}));row.errorCode=typeof err.error?.code==='string'?err.error.code.slice(0,100):'UPSTREAM_ERROR';
   const message=typeof err.error?.message==='string'?err.error.message:'';
   row.diagnostic={mentionsAccount:/account/i.test(message),mentionsActivation:/activat|not open|enable|开通/i.test(message),mentionsPermission:/permission|authoriz|权限/i.test(message)};
   reply(res,remote.status,{error:{code:row.errorCode,message:'Ark request failed; inspect sanitized gateway status.'}});return;}
  res.writeHead(200,{'content-type':payload.stream?'text/event-stream':'application/json','cache-control':'no-store','x-workbuddy-request-id':id});
  if(!payload.stream){const data=await remote.json();usage=data.usage;toolCalls=data.choices?.[0]?.message?.tool_calls?.length||0;const out=JSON.stringify(data);if(out.includes(key))throw Error('SECRET_IN_RESPONSE');res.end(out);}
  else{const decoder=new TextDecoder();for await(const c of remote.body){if(firstMs===null)firstMs=Date.now()-start;tail+=decoder.decode(c,{stream:true});let pos;while((pos=tail.indexOf('\n\n'))>=0){const frame=tail.slice(0,pos);tail=tail.slice(pos+2);if(frame.includes(key))throw Error('SECRET_IN_RESPONSE');for(const line of frame.split('\n'))if(line.startsWith('data: ')&&line!=='data: [DONE]'){try{const j=JSON.parse(line.slice(6));if(j.usage)usage=j.usage;for(const v of j.choices||[])toolCalls+=(v.delta?.tool_calls||[]).filter(t=>t.function?.name).length;chunksSeen++;}catch{}}
    res.write(frame+'\n\n');}}
   if(tail){if(tail.includes(key))throw Error('SECRET_IN_RESPONSE');res.write(tail);}res.end();}
  row.success=true;
 }catch(error){row.success=false;row.error=ac.signal.aborted?'ABORTED':'GATEWAY_OR_UPSTREAM_FAILURE';if(!res.headersSent)reply(res,502,{error:row.error});else res.end();}
 finally{clearTimeout(timer);record({...row,latencyMs:Date.now()-start,firstChunkMs:firstMs,usage,toolCalls,chunksSeen});}
});
server.listen(8081,'0.0.0.0',()=>console.log(JSON.stringify({ready:true,model:cfg.model,baseURL:cfg.baseURL,key:'SET'})));
