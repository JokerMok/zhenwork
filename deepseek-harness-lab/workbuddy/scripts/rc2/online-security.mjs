import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {setTimeout as delay} from 'node:timers/promises';
import {randomUUID,createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2'),origin='https://localhost:3582';
const admin=JSON.parse(fs.readFileSync(path.join(state,'bootstrap.json'))),users=JSON.parse(fs.readFileSync(path.join(state,'employees.json')));
const report={date:new Date().toISOString(),status:'RUNNING',checks:[]};
async function req(route,cookie,method='GET',body){const r=await fetch(origin+'/api'+route,{method,signal:AbortSignal.timeout(15000),headers:{Origin:origin,clientid:admin.clientId,'content-type':'application/json',...(cookie?{cookie}:{})},body:body?JSON.stringify(body):undefined});return {http:r.status,data:await r.json(),cookie:r.headers.getSetCookie().at(-1)?.split(';')[0]};}
async function login(user){const r=await req('/auth/login',null,'POST',{...user,clientId:admin.clientId,grantType:'password'});assert.equal(r.data.code,200);assert.ok(r.cookie);return r.cookie;}
try{
 const a=await login(users[0]),b=await login(users[1]),s=await login(admin);
 const listing=await req('/monitor/online/list',s);assert.equal(listing.data.code,200);const rows=listing.data.data.rows;assert.ok(rows.length>=3);
 for(const row of rows)assert.match(row.tokenId,/^sid_[a-f0-9]{64}$/);
 for(const cookie of [a,b,s])assert.ok(!JSON.stringify(listing.data).includes(cookie.slice(cookie.indexOf('=')+1)));
 report.checks.push('Native administrator online listing returns actor-bound opaque handles, never reusable session tokens');
 const actor=(await req('/ai/me',s)).data.data.userId;const exact='sid_'+createHash('sha256').update(actor+':'+a.slice(a.indexOf('=')+1)).digest('hex');const ar=rows.find(r=>r.tokenId===exact);assert.ok(ar,'Employee A is present');
 assert.equal((await req('/ai/me','__Host-workspace-rc2='+ar.tokenId)).data.code,401);
 assert.equal((await req('/monitor/online/myself/'+ar.tokenId,b,'DELETE')).http,409);
 report.checks.push('Opaque handle cannot authenticate or be used by another actor');
 const models=(await req('/ai/models/available',a)).data.data;
 const created=await req('/ai/sessions',a,'POST',{modelId:models[0].id,title:'Online identity boundary',idempotencyKey:randomUUID()});assert.equal(created.data.code,200);
 assert.equal((await req('/ai/sessions/'+created.data.data.id,s)).http,404);
 const ws=new WebSocket('wss://localhost:3582/ws?sessionId='+created.data.data.id,{headers:{cookie:a,Origin:origin},handshakeTimeout:5000});await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});const closed=new Promise(resolve=>ws.once('close',resolve));
 const kicked=await req('/monitor/online/'+ar.tokenId,s,'DELETE');assert.equal(kicked.data.code,200);assert.equal((await req('/ai/me',a)).data.code,401);
 assert.equal(await Promise.race([closed,delay(5000).then(()=>-1)]),1008);ws.close();
 report.checks.push('Administrator can revoke by handle, cannot read employee private conversation; revoked cookie is rejected and open WSS closes');
 const own=await req('/monitor/online',b);assert.equal(own.data.code,200);assert.ok(own.data.data.rows.length);for(const row of own.data.data.rows)assert.match(row.tokenId,/^sid_[a-f0-9]{64}$/);
 assert.ok(!JSON.stringify(own.data).includes(b.slice(b.indexOf('=')+1)));
 assert.equal((await req('/monitor/online/myself/'+own.data.data.rows[0].tokenId,b,'DELETE')).data.code,200);
 report.checks.push('Self-device listing also hides credentials and preserves own-device revocation');report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;process.exitCode=1;}
fs.mkdirSync(path.join(root,'evidence/v1/rc2/r5'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/v1/rc2/r5/online-security-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
