import fs from 'node:fs';import {spawn} from 'node:child_process';import {setTimeout} from 'node:timers/promises';
const c=JSON.parse(fs.readFileSync(process.env.WORKSPACE_CONFIG_FILE));const server=spawn(process.execPath,['apps/server/src/main.ts'],{stdio:['ignore','pipe','pipe']});const stopped=new Promise(resolve=>server.once('exit',resolve));let started=false,announced=false;
server.stdout.on('data',chunk=>{if(chunk.toString().includes('"ready":true'))announced=true;});server.stderr.resume();
try{for(let i=0;i<100;i++){if(server.exitCode!==null)throw Error('API startup failed');if(announced){try{started=(await fetch(`http://127.0.0.1:${c.port}/health/ready`)).ok;if(started)break;}catch{}}await setTimeout(100);}if(!started)throw Error('API readiness timed out');
 const file=process.argv[2]||'scripts/v1/smoke-http.mjs';const test=spawn(process.execPath,[file],{stdio:'inherit'});const code=await new Promise(resolve=>test.once('exit',resolve));if(code!==0)throw Error('HTTP validation failed');
}finally{if(server.exitCode===null)server.kill('SIGTERM');await stopped;}
