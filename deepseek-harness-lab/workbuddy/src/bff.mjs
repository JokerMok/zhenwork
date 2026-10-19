/** Minimal two-user Alpha BFF. Resource ownership is mandatory on every HTTP/WS operation. */
import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {randomBytes,randomUUID,timingSafeEqual} from 'node:crypto';import {WebSocketServer} from 'ws';import {RuntimeClient} from './runtime-client.mjs';
const root=path.resolve(import.meta.dirname,'..'),state=root+'/.state';
const users=['user_a','user_b'];
const passwordFile=state+'/users.json';if(!fs.existsSync(passwordFile))fs.writeFileSync(passwordFile,JSON.stringify(Object.fromEntries(users.map(u=>[u,randomBytes(20).toString('hex')]))),{mode:0o600});
const passwords=JSON.parse(fs.readFileSync(passwordFile));const auth=new Map(),runtimes=new Map(),subscribers=new Set();
const regFile=state+'/sessions.json';const sessions=fs.existsSync(regFile)?JSON.parse(fs.readFileSync(regFile)):{};
function persist(){fs.writeFileSync(regFile+'.tmp',JSON.stringify(sessions),{mode:0o600});fs.renameSync(regFile+'.tmp',regFile);}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length&&timingSafeEqual(aa,bb);}
function authenticated(req){const h=req.headers.authorization;if(typeof h!=='string'||!h.startsWith('Bearer '))return;return auth.get(h.slice(7));}
function owned(user,id){return sessions[id]?.owner===user&&!sessions[id]?.deleted;}
function audit(user,action,resource,status){fs.appendFileSync(root+'/evidence/bff-audit.jsonl',JSON.stringify({time:new Date().toISOString(),user,action,resource,status})+'\n');}
function answer(res,status,value){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));}
function failure(code){const err=Error(String(code));err.status=code;throw err;}
async function body(req,keys){let b='',seen=new Set();for await(const c of req){b+=c;if(b.length>24000)failure(413);}if(b&&req.headers['content-type']?.split(';')[0]!=='application/json')failure(415);let x;try{x=JSON.parse(b||'{}');}catch{failure(400);}if(!x||typeof x!=='object'||Array.isArray(x)||Object.keys(x).some(k=>!keys.includes(k)))failure(400);for(const m of b.matchAll(/"((?:\\.|[^"\\])*)"\s*:/g)){const k=JSON.parse('"'+m[1]+'"');if(seen.has(k))failure(400);seen.add(k);}return x;}
for(const owner of users){const r=new RuntimeClient(owner,root);runtimes.set(owner,r);r.on('message',m=>{for(const s of subscribers)if(s.owner===owner&&s.sessionId===m.sessionId&&owned(owner,m.sessionId))s.send(m);});await r.start();}
const server=http.createServer(async(req,res)=>{
 let user,resource;try{
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)failure(403);
  const url=new URL(req.url,'http://127.0.0.1');for(const k of new Set(url.searchParams.keys()))if(url.searchParams.getAll(k).length!==1)failure(400);
  if(url.search)failure(400);
  if(req.method==='POST'&&url.pathname==='/login'){const x=await body(req,['username','password']);if(!users.includes(x.username)||!equal(x.password,passwords[x.username]))failure(401);const token=randomBytes(32).toString('base64url');auth.set(token,x.username);answer(res,200,{token,user:x.username});return;}
  user=authenticated(req);if(!user)failure(401);
  const runtime=runtimes.get(user);
  if(req.method==='POST'&&url.pathname==='/logout'){auth.delete(req.headers.authorization.slice(7));for(const s of subscribers)if(s.owner===user)s.close();answer(res,200,{loggedOut:true});return;}
  if(url.pathname==='/sessions'){
   if(req.method==='GET'){answer(res,200,{sessions:Object.entries(sessions).filter(([id])=>owned(user,id)).map(([id])=>({id}))});return;}
   if(req.method==='POST'){await body(req,[]);const id=randomUUID();await runtime.request('create',{sessionId:id});sessions[id]={owner:user};persist();answer(res,201,{id});return;}
  }
  if(url.pathname==='/knowledge/search'&&req.method==='POST'){const args=await body(req,['query','docId']);answer(res,200,{results:await runtime.request('knowledge',{args})});return;}
  const match=url.pathname.match(/^\/sessions\/([a-f0-9-]{36})(?:\/(prompt|resume|cancel|follow|export|approval|tool))?$/);
  if(!match)failure(404);const [,id,op]=match;resource=id;if(!owned(user,id))failure(404);
  if(req.method==='GET'&&!op||req.method==='GET'&&op==='export'){answer(res,200,await runtime.request('snapshot',{sessionId:id}));return;}
  if(req.method==='GET'&&op==='follow'){
   const snapshot=await runtime.request('snapshot',{sessionId:id});res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-store'});res.write('data: '+JSON.stringify({snapshot})+'\n\n');const s={owner:user,sessionId:id,send:m=>res.write('data: '+JSON.stringify(m)+'\n\n'),close:()=>res.end()};subscribers.add(s);req.on('close',()=>subscribers.delete(s));return;
  }
  if(req.method==='DELETE'&&!op){await body(req,[]);await runtime.request('dispose',{sessionId:id});sessions[id].deleted=true;persist();for(const s of subscribers)if(s.sessionId===id)s.close();answer(res,200,{deleted:true});return;}
  if(req.method==='POST'&&op){const keys={prompt:['text'],resume:[],cancel:[],approval:['approvalId','decision'],tool:['name','args']}[op];if(!keys)failure(404);const x=await body(req,keys);const result=await runtime.request(op,{sessionId:id,...x});answer(res,200,result);return;}
  failure(404);
 }catch(error){const status=error.status||(/NOT_FOUND/.test(error.message)?404:400);if(!res.headersSent)answer(res,status,{error:status===404?'not found':status===401?'unauthorized':'request rejected'});else res.end();audit(user,req.method,resource,status);}
});
const ws=new WebSocketServer({noServer:true,maxPayload:4096});
server.on('upgrade',(req,socket,head)=>{
 const user=authenticated(req);const url=new URL(req.url,'http://127.0.0.1');const id=url.searchParams.get('sessionId');
 const valid=user&&url.pathname==='/ws'&&url.searchParams.size===1&&url.searchParams.getAll('sessionId').length===1&&owned(user,id)&&(!req.headers.origin||req.headers.origin===`http://${req.headers.host}`);
 if(!valid){socket.end('HTTP/1.1 '+(user?'404 Not Found':'401 Unauthorized')+'\r\nConnection: close\r\n\r\n');audit(user,'WS',id,user?404:401);return;}
 ws.handleUpgrade(req,socket,head,async conn=>{
  const s={owner:user,sessionId:id,send:m=>{if(conn.readyState===1)conn.send(JSON.stringify(m));},close:()=>conn.close()};subscribers.add(s);
  conn.on('message',()=>conn.close(1008,'Subscription is bound at handshake'));conn.on('close',()=>subscribers.delete(s));
  try{s.send({snapshot:await runtimes.get(user).request('snapshot',{sessionId:id})});}catch{conn.close(1011);}
 });
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));fs.writeFileSync(state+'/bff.json',JSON.stringify({port:server.address().port,pid:process.pid}));console.log(JSON.stringify({ready:true,port:server.address().port}));
process.on('SIGTERM',async()=>{for(const s of subscribers)s.close();await Promise.all([...runtimes.values()].map(r=>r.close()));server.close(()=>process.exit(0));});
