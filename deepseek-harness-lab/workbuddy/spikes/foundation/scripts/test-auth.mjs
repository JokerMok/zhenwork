import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pool,config,root} from '../src/auth.mjs';
const users=JSON.parse(fs.readFileSync(path.join(root,'.state/foundation/test-users.json')));
const a=users.find(u=>u.role==='employee'),admin=users.find(u=>u.role==='admin');
const results=[];
async function req(route,{method='GET',cookie,body,origin=config.baseURL}={}) {
 const res=await fetch(config.baseURL+route,{method,headers:{...(cookie?{cookie}:{}),...(method!=='GET'?{'content-type':'application/json',origin}:{} )},body:body?JSON.stringify(body):undefined});
 const cookies=res.headers.getSetCookie();let json;try{json=await res.json();}catch{}
 return {status:res.status,retryAfter:res.headers.get('retry-after'),body:json,cookies,cookie:cookies.map(c=>c.split(';')[0]).join('; ')};
}
async function test(name,fn){try{await fn();results.push({name,status:'PASS'});}catch(e){results.push({name,status:'FAIL',error:e.message.slice(0,400)});}}
async function login(user=a){for(let n=0;n<3;n++){const r=await req('/api/auth/sign-in/email',{method:'POST',body:{email:user.email,password:user.password}});if(r.status===429){console.log('Rate limit respected; waiting for retry window');await new Promise(resolve=>setTimeout(resolve,Math.min(61000,(Number(r.retryAfter)||60)*1000+500)));continue;}assert.equal(r.status,200);return r;}throw Error('Login retry window exhausted');}
await test('anonymous rejected',async()=>assert.equal((await req('/api/me')).status,401));
let original;
await test('login cookie HttpOnly SameSite and server identity',async()=>{original=await login();assert(original.cookies.some(c=>/httponly/i.test(c)&&/samesite=lax/i.test(c)));const me=await req('/api/me',{cookie:original.cookie});assert.equal(me.status,200);assert.equal(me.body.id,a.id);});
await test('invalid password rejected',async()=>assert.equal((await req('/api/auth/sign-in/email',{method:'POST',body:{email:a.email,password:'Invalid-password-123'}})).status,401));
await test('employee admin API denied',async()=>assert.equal((await req('/api/admin/users',{cookie:original.cookie})).status,403));
await test('admin users API includes actual PostgreSQL users',async()=>{const s=await login(admin);const r=await req('/api/admin/users',{cookie:s.cookie});assert.equal(r.status,200);assert(r.body.some(u=>u.id===a.id));});
await test('CSRF foreign origin blocked',async()=>assert.equal((await req('/api/auth/sign-out',{method:'POST',cookie:original.cookie,body:{},origin:'https://foreign.example'})).status,403));
await test('public registration hidden',async()=>assert.equal((await req('/api/auth/sign-up/email',{method:'POST',body:{}})).status,404));
await test('logout revokes server session with old cookie',async()=>{assert.equal((await req('/api/auth/sign-out',{method:'POST',cookie:original.cookie,body:{}})).status,200);assert.equal((await req('/api/me',{cookie:original.cookie})).status,401);});
await test('database expiry rejects retained cookie',async()=>{const s=await login();await pool.query('UPDATE session SET "expiresAt"=NOW()-INTERVAL \'1 minute\' WHERE "userId"=$1',[a.id]);assert.equal((await req('/api/me',{cookie:s.cookie})).status,401);});
await test('database revocation rejects retained cookie',async()=>{const s=await login();await pool.query('DELETE FROM session WHERE "userId"=$1',[a.id]);assert.equal((await req('/api/me',{cookie:s.cookie})).status,401);});
await test('disabled employee immediately denied despite valid auth cookie',async()=>{const s=await login();try{await pool.query('UPDATE employee SET enabled=FALSE WHERE user_id=$1',[a.id]);assert.equal((await req('/api/me',{cookie:s.cookie})).status,403);const denied=await req('/api/auth/sign-in/email',{method:'POST',body:{email:a.email,password:a.password}});assert(denied.status>=400);assert(!denied.cookie.includes('session_token='));}finally{await pool.query('UPDATE employee SET enabled=TRUE WHERE user_id=$1',[a.id]);await pool.query('DELETE FROM session WHERE "userId"=$1',[a.id]);}});
await test('brand persists through API, employee write denied',async()=>{const s=await login(admin), employee=await login();const before=await req('/api/brand');assert.equal((await req('/api/admin/brand',{method:'PUT',cookie:employee.cookie,body:{productName:'非法修改'}})).status,403);assert.equal((await req('/api/admin/brand',{method:'PUT',cookie:s.cookie,body:{productName:'品牌集成验证'}})).status,200);assert.equal((await req('/api/brand')).body.productName,'品牌集成验证');await req('/api/admin/brand',{method:'PUT',cookie:s.cookie,body:{productName:before.body.productName}});});
const report={timestamp:new Date().toISOString(),scope:'R1 Spike B actual Better Auth 1.7.5 PostgreSQL 17 HTTP; local HTTP Secure-cookie TLS gate not tested',pass:results.filter(x=>x.status==='PASS').length,total:results.length,results};
fs.writeFileSync(path.join(root,'evidence/v1/reuse-r1/auth-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await pool.end();if(report.pass!==report.total)process.exitCode=1;
