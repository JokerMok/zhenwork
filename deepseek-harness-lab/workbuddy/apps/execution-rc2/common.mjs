import fs from 'node:fs';
import {createHmac,timingSafeEqual} from 'node:crypto';
export const config=JSON.parse(fs.readFileSync(process.env.WORKSPACE_RC2_EXECUTION_CONFIG,'utf8'));
const key=fs.readFileSync(config.executionKeyFile);
export const serviceToken=createHmac('sha256',key).update('workspace-rc2-service-v1').digest('base64url');
export function service(req){const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+serviceToken);if(a.length!==b.length||!timingSafeEqual(a,b))throw Error('PermissionDenied');}
export function verify(grant){const parts=String(grant).split('.');if(parts.length!==2)throw Error('PermissionDenied');const a=Buffer.from(parts[1],'base64url'),b=createHmac('sha256',key).update(parts[0]).digest();if(a.length!==b.length||!timingSafeEqual(a,b))throw Error('PermissionDenied');const p=JSON.parse(Buffer.from(parts[0],'base64url'));if(p.iss!=='workspace-ruoyi'||p.aud!=='deepseek-execution'||p.scope!=='run.execute'||p.exp<=Date.now()/1000||!/^\d{1,19}$/.test(p.userId)||![p.sessionId,p.runId].every(x=>/^[a-f0-9-]{36}$/.test(x)))throw Error('PermissionDenied');return p;}
export async function control(route,body){const r=await fetch(config.controlOrigin+'/internal/rc2/'+route,{method:'POST',headers:{authorization:'Bearer '+serviceToken,'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal:AbortSignal.timeout(15000)});const data=await r.json();if(!r.ok||data.code!==200)throw Error(data.code===403?'PermissionDenied':'ControlPlaneUnavailable');return data.data;}
export async function body(req,limit=600000){let size=0;const parts=[];for await(const part of req){size+=part.length;if(size>limit)throw Error('InvalidRequest');parts.push(part);}return JSON.parse(Buffer.concat(parts).toString('utf8'));}
export function reply(res,status,data){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(data));}
