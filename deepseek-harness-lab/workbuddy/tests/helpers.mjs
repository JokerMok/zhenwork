import fs from 'node:fs';import path from 'node:path';import {WebSocket} from 'ws';
export const root=path.resolve(import.meta.dirname,'..');export const state=root+'/.state';
export const base='http://127.0.0.1:'+JSON.parse(fs.readFileSync(state+'/bff.json')).port;
export const passwords=JSON.parse(fs.readFileSync(state+'/users.json'));
export const canaries=JSON.parse(fs.readFileSync(state+'/canaries.json'));
export const tokens={};
export async function req(user,method,url,data,headers={}){const r=await fetch(base+url,{method,headers:{...(tokens[user]?{authorization:'Bearer '+tokens[user]}:{}),...(data!==undefined?{'content-type':'application/json'}:{}),...headers},body:data===undefined?undefined:typeof data==='string'?data:JSON.stringify(data),signal:AbortSignal.timeout(125000)});const raw=await r.text();let body;try{body=JSON.parse(raw)}catch{body=raw}return{status:r.status,body};}
export async function login(){for(const u of ['user_a','user_b']){const r=await req(null,'POST','/login',{username:u,password:passwords[u]});if(r.status!==200)throw Error('LOGIN_FAILED');tokens[u]=r.body.token;}}
export async function create(u){const r=await req(u,'POST','/sessions',{});if(r.status!==201)throw Error('CREATE_FAILED '+JSON.stringify(r));return r.body.id;}
export async function tool(u,id,name,args){return req(u,'POST',`/sessions/${id}/tool`,{name,args});}
export function socket(u,id){return new WebSocket(base.replace('http:','ws:')+'/ws?sessionId='+id,{headers:tokens[u]?{authorization:'Bearer '+tokens[u]}:{}});}
export async function wsStatus(u,id){return new Promise(resolve=>{const w=socket(u,id);const t=setTimeout(()=>{w.terminate();resolve(0)},5000);w.on('open',()=>{clearTimeout(t);w.close();resolve(101)});w.on('unexpected-response',(_r,r)=>{clearTimeout(t);w.terminate();resolve(r.statusCode)});w.on('error',()=>{});});}
export function save(name,data){fs.writeFileSync(root+'/evidence/'+name,JSON.stringify(data,null,2));}
