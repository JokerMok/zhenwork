/** R1 only: trusted same-origin relay to the unchanged Alpha BFF. No browser bearer or client-selected owner. */
import fs from 'node:fs';
import path from 'node:path';
import {WebSocket,WebSocketServer} from 'ws';
import {pool,root,config,identity} from './auth.mjs';
import {EventProjection,project} from './projector.mjs';
const alphaRoot=path.join(root,'.research/spike-alpha');
const tokens=new Map();
function base(){return `http://127.0.0.1:${JSON.parse(fs.readFileSync(path.join(alphaRoot,'.state/bff.json'))).port}`;}
async function token(slot){if(!['user_a','user_b'].includes(slot))throw Object.assign(Error('PermissionDenied'),{status:403});if(tokens.has(slot))return tokens.get(slot);const users=JSON.parse(fs.readFileSync(path.join(alphaRoot,'.state/users.json')));const res=await fetch(base()+'/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:slot,password:users[slot]})});if(!res.ok)throw Error('AlphaLoginFailed');const value=(await res.json()).token;tokens.set(slot,value);return value;}
async function request(user,route,method='GET',body){const res=await fetch(base()+route,{method,headers:{authorization:'Bearer '+await token(user.alpha_slot),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(125000)});const result=await res.json();if(!res.ok)throw Object.assign(Error(res.status===404?'NotFound':'RuntimeError'),{status:res.status});return result;}
async function owned(user,id){if(!/^[a-f0-9-]{36}$/.test(id))throw Object.assign(Error('NotFound'),{status:404});const {rows}=await pool.query('SELECT id FROM session_binding WHERE id=$1 AND user_id=$2',[id,user.user_id]);if(!rows.length)throw Object.assign(Error('NotFound'),{status:404});}
export async function chatRoute(user,url,method,body){
 if(url.pathname==='/api/sessions'){
  if(method==='GET')return {sessions:(await pool.query('SELECT id FROM session_binding WHERE user_id=$1 ORDER BY id',[user.user_id])).rows};
  if(method==='POST'){const result=await request(user,'/sessions','POST',{});await pool.query('INSERT INTO session_binding(id,user_id) VALUES($1,$2)',[result.id,user.user_id]);return result;}
 }
 const match=url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})(?:\/(prompt|resume|cancel|approval))?$/);
 if(!match)return null;const [,id,op]=match;await owned(user,id);
 if(method==='GET'&&!op)return project((await request(user,`/sessions/${id}`)).events);
 if(method==='POST'&&op){
  const keys={prompt:['text'],resume:[],cancel:[],approval:['approvalId','decision']}[op];
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!keys.includes(k)))throw Object.assign(Error('InvalidRequest'),{status:400});
  if(op==='prompt'&&(typeof body.text!=='string'||!body.text.trim()||body.text.length>12000))throw Object.assign(Error('InvalidPrompt'),{status:400});
  const result=await request(user,`/sessions/${id}/${op}`,'POST',body);return result.events?project(result.events):result;
 }
 return null;
}
export function attachChatWebsocket(server){
 const ws=new WebSocketServer({noServer:true,maxPayload:1024});
 server.on('upgrade',async(req,socket,head)=>{
  if(!req.url?.startsWith('/ws'))return;
  try{
   if(req.headers.origin!==config.baseURL)throw Error('OriginDenied');
   const url=new URL(req.url,config.baseURL),id=url.searchParams.get('sessionId');
   if(url.pathname!=='/ws'||url.searchParams.size!==1)throw Error('InvalidRequest');
   const user=await identity(req);await owned(user,id);
   const bearer=await token(user.alpha_slot);
   ws.handleUpgrade(req,socket,head,client=>{
    const projection=new EventProjection();
    const upstream=new WebSocket(base().replace('http:','ws:')+'/ws?sessionId='+id,{headers:{authorization:'Bearer '+bearer}});
    let alive=true;
    const send=x=>{if(client.readyState===1)client.send(JSON.stringify(x));};
    const timer=setInterval(async()=>{try{await identity(req);if(!alive)return client.terminate();alive=false;client.ping();}catch{client.close(1008,'Session revoked');}},1000);
    client.on('pong',()=>{alive=true;});
    upstream.on('message',async data=>{try{await identity(req);send(projection.accept(JSON.parse(data.toString())));}catch{client.close(1008,'Session revoked');}});
    upstream.on('error',()=>{send({type:'error',terminal:'RuntimeError'});client.close(1011);});
    client.on('message',()=>client.close(1008,'Read-only stream'));
    client.on('close',()=>{clearInterval(timer);upstream.close();});
   });
  }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');}
 });
}
