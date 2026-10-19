import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const root=path.resolve(import.meta.dirname,'../..'),mode=process.argv[2],state=path.resolve(process.argv[3]||path.join(root,'.state/local-acceptance')),record=path.join(state,'tunnel-process.json'),meta=JSON.parse(fs.readFileSync(path.join(state,'deployment.json')));
process.chdir(root);
const node=(file,args=[])=>execFileSync(process.execPath,[file,...args],{cwd:root,stdio:'inherit'});
const compose=args=>execFileSync('docker',['compose','--env-file',path.join(state,'deploy.env'),'-f','deploy/v1/docker-compose.prod.yml',...args],{cwd:root,stdio:'inherit'});
function alive(r){try{const cmd=execFileSync('ps',['-p',String(r.pid),'-o','command='],{encoding:'utf8'});return cmd.includes('cloudflared tunnel')&&cmd.includes(meta.origin)&&cmd.includes(state);}catch{return false}}
async function stop(){if(fs.existsSync(record)){const r=JSON.parse(fs.readFileSync(record));if(alive(r)){process.kill(r.pid,'SIGTERM');for(let i=0;i<30&&alive(r);i++)await delay(200);if(alive(r))throw Error('Tunnel did not stop');}fs.unlinkSync(record);}if(fs.existsSync(path.join(state,'server.json.pre-tunnel')))node('scripts/ops/remote-origin.mjs',['disable','--state',state]);console.log(JSON.stringify({tunnel:'stopped',localOriginRestored:true,volumesDeleted:false}));}
if(mode==='stop'||mode==='stop-all'){await stop();if(mode==='stop-all')node('scripts/ops/install.mjs',['stop','--state',state]);}
else if(mode==='start'){
 if(fs.existsSync(record)&&alive(JSON.parse(fs.readFileSync(record))))throw Error('Acceptance Tunnel is already running; use status');
 const log=path.join(state,'tunnel.log'),fd=fs.openSync(log,'w',0o600),child=spawn('cloudflared',['tunnel','--url',meta.origin,'--origin-ca-pool',path.join(state,'caddy-data/caddy/pki/authorities/local/root.crt'),'--origin-server-name','localhost','--protocol','http2','--no-autoupdate'],{cwd:root,detached:true,stdio:['ignore',fd,fd]});child.unref();fs.closeSync(fd);
 const r={pid:child.pid,state,localOrigin:meta.origin,startedAt:new Date().toISOString()};fs.writeFileSync(record,JSON.stringify(r),{mode:0o600});let origin;
 try{for(let i=0;i<90;i++){const content=fs.readFileSync(log,'utf8');origin=content.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];if(origin)break;if(!alive(r))throw Error('Tunnel exited; inspect private log');await delay(1000);}if(!origin)throw Error('Quick Tunnel URL timeout');node('scripts/ops/remote-origin.mjs',['enable','--state',state,'--origin',origin]);
 // One canonical origin remains enforced by the frozen BFF. Local navigation redirects
 // while the public route is active; public Host requests keep the original proxy route.
 const caddy=path.join(state,'Caddyfile'),site='https://'+new URL(meta.origin).hostname+':8443',s=fs.readFileSync(caddy,'utf8');fs.writeFileSync(caddy,s.replace(site+', '+origin+':8443 {',site+' {\n tls internal\n redir '+origin+'{uri} temporary\n}\n'+origin+':8443 {'),{mode:0o600});compose(['restart','entry']);
 Object.assign(r,{origin});fs.writeFileSync(record,JSON.stringify(r,null,2),{mode:0o600});console.log(JSON.stringify({tunnel:'running',origin,localEntry:'redirects to the same active HTTPS origin'}));
 }catch(e){await stop();throw e;}
}else if(mode==='status'){const r=fs.existsSync(record)?JSON.parse(fs.readFileSync(record)):null;console.log(JSON.stringify({running:!!r&&alive(r),origin:r?.origin||null,localOrigin:meta.origin}));}
else throw Error('Usage: scripts/dev-tunnel.sh start|status|stop|stop-all [state-directory]');
