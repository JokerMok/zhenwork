import fs from 'node:fs';import path from 'node:path';import {execFileSync,spawnSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'../..'),file=path.join(root,'.state/rc2/processes.json');
const records=JSON.parse(fs.readFileSync(file));const names=process.argv.slice(2);if(!names.length||names.some(n=>!['backend','execution','employee','admin'].includes(n)))throw Error('Specify owned RC2 process names');
const alive=pid=>{try{process.kill(pid,0);return true;}catch{return false;}};
const owned=[];
for(const name of names){
 const record=records[name];if(!record||!alive(record.pid))continue;
 const command=execFileSync('ps',['-p',String(record.pid),'-o','command='],{encoding:'utf8'});
 const marker=name==='backend'?record.args.find(x=>x.endsWith('.jar')):name==='execution'?path.join(root,'apps/execution-rc2/manager.mjs'):name==='employee'?path.join(root,'node_modules/next/dist/bin/next'):'node_modules/vite/bin/vite.js';
 let valid=marker&&command.includes(marker)&&command.includes(name==='backend'?record.command:'node');
 if(name==='employee'&&/^next-server \(v[0-9.]+\)/.test(command)){
  const cwd=execFileSync('lsof',['-a','-p',String(record.pid),'-d','cwd','-Fn'],{encoding:'utf8'});
  const port=execFileSync('lsof',['-nP','-a','-p',String(record.pid),'-iTCP:3583','-sTCP:LISTEN','-Fn'],{encoding:'utf8'});
  valid=cwd.split('\n').includes('n'+path.join(root,'apps/web'))&&port.split('\n').includes('n127.0.0.1:3583');
 }
 if(!valid)throw Error('Process identity mismatch: '+name);owned.push({name,pid:record.pid});
}
for(const {name,pid}of owned){process.kill(pid,'SIGTERM');for(let i=0;i<300&&alive(pid);i++)await delay(100);if(alive(pid))throw Error('Owned process did not stop: '+name);}
const started=spawnSync(process.execPath,[path.join(root,'scripts/rc2/run-local.mjs')],{cwd:root,stdio:'inherit',timeout:120000});process.exitCode=started.status??1;
