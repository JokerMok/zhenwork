import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2'),out=path.join(root,'evidence/v1/rc2/r2');
const credentials=JSON.parse(fs.readFileSync(path.join(state,'bootstrap.json'))),origin='http://127.0.0.1:3580';
const report={date:new Date().toISOString(),status:'RUNNING',checks:[],scope:'Official RuoYi native API with actual PostgreSQL17 and Redis; not RC2 AI/security/product acceptance'};
async function request(route,body,token,method=body?'POST':'GET'){const r=await fetch(origin+route,{method,headers:{'content-type':'application/json',clientid:credentials.clientId,...(token?{Authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {http:r.status,data:await r.json()};}
try{
 const anonymous=await request('/system/user/getInfo');assert.equal(anonymous.data.code,401);report.checks.push('native protected API rejects anonymous access');
 const login=await request('/auth/login',{username:credentials.username,password:credentials.password,clientId:credentials.clientId,grantType:'password'});assert.equal(login.data.code,200,'native login failed');const token=login.data.data.access_token;assert.ok(token);report.checks.push('generated administrator BCrypt credential logs in via Sa-Token');
 for(const route of ['/system/user/getInfo','/system/user/list?pageNum=1&pageSize=10','/system/dept/list','/system/role/list?pageNum=1&pageSize=10','/system/menu/getRouters']){
  const r=await request(route,undefined,token);assert.equal(r.data.code,200,'native route failed '+route);report.checks.push('PostgreSQL-backed native route '+route);
  if(route.includes('getInfo')){const id=r.data.data.user.userId;assert.equal(typeof id,'string','native IAM ID must not lose browser precision');report.checks.push('BIGINT user identity serialized as a string');}
 }
 const parent=(await request('/system/user/getInfo',undefined,token)).data.data.user.deptId;const name='RC2-smoke-'+Date.now();const dept={parentId:parent,deptName:name,orderNum:999,status:'0'};
 assert.equal((await request('/system/dept',dept,token)).data.code,200,'native department insert');
 const created=(await request('/system/dept/list?deptName='+name,undefined,token)).data.data.find(x=>x.deptName===name);assert.ok(created);
 try{assert.equal((await request('/system/dept',{...dept,deptId:created.deptId,deptName:name+'-edit'},token,'PUT')).data.code,200,'native department update');report.checks.push('native department insert/query/update using PostgreSQL and dynamic datasource');}
 finally{assert.equal((await request('/system/dept/'+created.deptId,undefined,token,'DELETE')).data.code,200,'native department cleanup');}
 const logout=await request('/auth/logout',{},token);assert.equal(logout.data.code,200);const after=await request('/system/user/getInfo',undefined,token);assert.equal(after.data.code,401);report.checks.push('logout invalidates the actual Sa-Token session');report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;process.exitCode=1;}
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'native-smoke.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
