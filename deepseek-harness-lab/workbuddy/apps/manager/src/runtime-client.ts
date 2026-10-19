import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
export class RuntimeClient extends EventEmitter{
 child?:ChildProcessWithoutNullStreams;pending=new Map<string,{resolve:(value:any)=>void;reject:(reason:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
 container:string;closed=false;constructor(container:string){super();this.container=container;}
 async start(){
  const ready=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{reject(Error('Timeout'));this.child?.kill();},60000);this.once('ready',()=>{clearTimeout(timer);resolve();});this.once('exit',()=>{clearTimeout(timer);reject(Error('RuntimeError'));});});
  this.child=spawn('docker',['exec','-i',this.container,'/usr/local/bin/node','/opt/workspace/start.mjs'],{stdio:['pipe','pipe','pipe']});
  let buffer='';this.child.stdout.setEncoding('utf8');this.child.stdout.on('data',(text:string)=>{
   buffer+=text;if(Buffer.byteLength(buffer)>8*1024*1024){this.child?.kill();return;}let pos;
   while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);let m;try{m=JSON.parse(line);}catch{continue;}
    if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id)!;clearTimeout(p.timer);this.pending.delete(m.id);if(m.error)p.reject(Error(m.error.code||'RuntimeError'));else p.resolve(m.result);}
    else if(m.event==='ready')this.emit('ready');else if(['session','stream','approval'].includes(m.event))this.emit('message',m);
   }
  });
  // Raw stderr may include model data; drain it without writing business content to service logs.
  this.child.stderr.resume();this.child.on('error',()=>this.finish());this.child.on('exit',()=>this.finish());await ready;
 }
 finish(){if(this.closed)return;this.closed=true;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('RuntimeError'));}this.pending.clear();this.emit('exit');}
 request(method:string,params:Record<string,unknown>={},timeoutMs=180000):Promise<any>{
  if(this.closed||!this.child?.stdin.writable)return Promise.reject(Error('RuntimeError'));
  const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('Timeout'));},timeoutMs);this.pending.set(id,{resolve,reject,timer});this.child!.stdin.write(JSON.stringify({id,method,...params})+'\n');});
 }
 async close(){if(this.closed)return;await this.request('shutdown',{},10000).catch(()=>{});this.child?.stdin.end();this.child?.kill();}
}
