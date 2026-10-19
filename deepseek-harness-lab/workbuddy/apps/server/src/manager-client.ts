import {WebSocket} from 'ws';import {EventEmitter} from 'node:events';import type {Config} from './config.ts';import {readSecret} from './config.ts';import type {Command} from '../../../packages/runtime-contract/src/index.ts';
export class ManagerClient extends EventEmitter{
 config:Config;secret:string;socket?:WebSocket;timer?:ReturnType<typeof setTimeout>;closed=false;connected=false;
 constructor(config:Config){super();this.config=config;this.secret=readSecret(config.managerSecretFile);}
 start(){if(this.closed)return;const url=new URL('/events',this.config.managerURL);url.protocol=url.protocol==='https:'?'wss:':'ws:';const ws=new WebSocket(url,{headers:{authorization:'Bearer '+this.secret},maxPayload:8*1024*1024});this.socket=ws;
  ws.on('open',()=>{this.connected=true;this.emit('connected');});ws.on('message',data=>{try{this.emit('frame',JSON.parse(data.toString()));}catch{this.emit('protocol-error');}});ws.on('error',()=>{});ws.on('close',()=>{this.connected=false;if(!this.closed)this.timer=setTimeout(()=>this.start(),1500);});
 }
 async command(body:Command){const response=await fetch(this.config.managerURL+'/command',{method:'POST',headers:{authorization:'Bearer '+this.secret,'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(body.method==='prompt'?610000:120000),redirect:'error'});const value=await response.json();if(!response.ok)throw Error(value.error?.code||'RuntimeError');return value.result;}
 close(){this.closed=true;clearTimeout(this.timer);this.socket?.close();}
}
