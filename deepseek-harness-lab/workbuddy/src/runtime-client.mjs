import {spawn} from 'node:child_process';import readline from 'node:readline';import {EventEmitter} from 'node:events';import fs from 'node:fs';import {randomUUID} from 'node:crypto';
export class RuntimeClient extends EventEmitter{
 constructor(owner,root){super();this.owner=owner;this.root=root;this.pending=new Map();}
 async start(){
  this.child=spawn('docker',['exec','-i','wb-alpha-'+this.owner.at(-1),'/usr/local/bin/node','/opt/harness/apps/cli/lib/bin.js','--profile','sdk','--patch','/config/runtime.patch.yml'],{stdio:['pipe','pipe','pipe'],env:{PATH:process.env.PATH,HOME:process.env.HOME}});
  this.child.stderr.on('data',c=>fs.appendFileSync(this.root+'/evidence/runtime-'+this.owner+'.stderr.log',c));
  readline.createInterface({input:this.child.stdout}).on('line',line=>{fs.appendFileSync(this.root+'/evidence/runtime-'+this.owner+'.stdout.log',line+'\n');let m;try{m=JSON.parse(line);}catch{return;}if(m.id&&this.pending.has(m.id)){const p=this.pending.get(m.id);clearTimeout(p.timer);this.pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}else {this.emit('message',m);}});
  this.child.on('exit',code=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(Error('RUNTIME_EXIT_'+code));}this.pending.clear();this.emit('exit',code);});
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('RUNTIME_READY_TIMEOUT')),60000);const fn=m=>{if(m.event==='ready'){clearTimeout(timer);this.off('message',fn);resolve();}};this.on('message',fn);this.child.once('exit',()=>{clearTimeout(timer);reject(Error('RUNTIME_BOOT_FAILED'));});});
 }
 request(method,params={}){const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('RUNTIME_TIMEOUT'));},130000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,method,...params})+'\n');});}
 async close(){await this.request('shutdown').catch(()=>{});this.child.stdin.end();}
}
