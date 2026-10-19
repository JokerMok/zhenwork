import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2'),out=path.join(root,'evidence/v1/rc2/r3');
const admin=JSON.parse(fs.readFileSync(path.join(state,'bootstrap.json'))),origin='https://localhost:3582';
const report={date:new Date().toISOString(),status:'RUNNING',checks:[],scope:'Native RuoYi identity, secure cookie, revocation and brand API; not AI/product acceptance'};
function check(name,fn){fn();report.checks.push(name);}
async function req(route,{body,cookie,method=body?'POST':'GET',headers={}}={}){const r=await fetch(origin+'/api'+route,{method,headers:{'content-type':'application/json',Origin:origin,clientid:admin.clientId,...(cookie?{cookie}:{}),...headers},body:body?JSON.stringify(body):undefined});return{http:r.status,data:await r.json(),cookies:r.headers.getSetCookie()};}
async function login(c){const r=await req('/auth/login',{body:{username:c.username,password:c.password,clientId:admin.clientId,grantType:'password'}});assert.equal(r.data.code,200,'login '+r.data.msg);assert.equal(r.data.data.access_token,'cookie-session');assert.equal(r.cookies.length,1,'only one secure cookie');assert.match(r.cookies[0],/; Secure; HttpOnly; SameSite=Strict/);return{cookie:r.cookies[0].split(';')[0],mustChange:r.data.data.mustChangePassword};}
try{
 let a=await login(admin);report.checks.push('TLS trusted and login returns one Secure HttpOnly Strict cookie without bearer credential');
 let me=await req('/system/user/getInfo',{cookie:a.cookie});assert.equal(me.data.code,200,me.data.msg);assert.equal(typeof me.data.data.user.userId,'string');const deptId=me.data.data.user.deptId;report.checks.push('cookie authenticates native IAM with lossless string user ID');
 const token=a.cookie.slice(a.cookie.indexOf('=')+1);
 for(const options of [{},{headers:{Authorization:'Bearer '+token}},{headers:{'__Host-workspace-rc2':token}}])assert.equal((await req('/system/user/getInfo',options)).data.code,401);
 assert.equal((await req('/system/user/getInfo?__Host-workspace-rc2='+encodeURIComponent(token))).data.code,401);report.checks.push('anonymous, bearer, token header and query token rejected');
 assert.equal((await req('/auth/logout',{body:{},cookie:a.cookie,headers:{Origin:'https://attacker.invalid'}})).http,403);report.checks.push('cross-origin mutation rejected');
 const old=(await req('/ai/brand')).data.data;assert.ok(old.productName);
 const save=await req('/ai/brand',{method:'PUT',cookie:a.cookie,body:{...old,expectedVersion:old.version,productName:'RC2 brand smoke'}});assert.equal(save.data.code,200,save.data.msg);
 assert.equal((await req('/ai/brand',{method:'PUT',cookie:a.cookie,body:{...old,expectedVersion:old.version}})).http,409);
 assert.equal((await req('/ai/brand',{method:'PUT',cookie:a.cookie,body:{...old,expectedVersion:save.data.data.version}})).data.code,200);report.checks.push('public brand read, native admin edit and optimistic conflict with original values restored');
 const usersFile=path.join(state,'employees.json');let employees=fs.existsSync(usersFile)?JSON.parse(fs.readFileSync(usersFile)):[];
 let roles=await req('/system/role/list?pageNum=1&pageSize=100',{cookie:a.cookie});let role=roles.data.data.rows?.find(x=>x.roleKey==='workspace_employee');
 if(!role){const add=await req('/system/role',{cookie:a.cookie,body:{roleName:'Workspace 员工',roleKey:'workspace_employee',roleSort:10,dataScope:'5',status:'0',menuCheckStrictly:true,deptCheckStrictly:true,menuIds:[],deptIds:[]}});assert.equal(add.data.code,200,add.data.msg);a=await login(admin);roles=await req('/system/role/list?pageNum=1&pageSize=100',{cookie:a.cookie});role=roles.data.data.rows.find(x=>x.roleKey==='workspace_employee');}
 assert.ok(role);
 for(const suffix of ['a','b']){
 let employee=employees.find(x=>x.username==='rc2-employee-'+suffix);
 if(!employee){employee={username:'rc2-employee-'+suffix,password:randomBytes(18).toString('base64url')};const add=await req('/system/user',{cookie:a.cookie,body:{userName:employee.username,nickName:'员工 '+suffix.toUpperCase(),deptId,status:'0',userType:'sys_user',gender:'2',roleIds:[role.roleId],postIds:[],password:employee.password}});assert.equal(add.data.code,200,add.data.msg);employees.push(employee);fs.writeFileSync(usersFile,JSON.stringify(employees,null,2),{mode:0o600});}
 let e=await login(employee);
 if(e.mustChange){assert.equal((await req('/system/user/list',{cookie:e.cookie})).http,403);const newPassword=randomBytes(18).toString('base64url');const change=await req('/system/user/profile/updatePwd',{method:'PUT',cookie:e.cookie,body:{oldPassword:employee.password,newPassword}});assert.equal(change.data.code,200,change.data.msg);employee.password=newPassword;fs.writeFileSync(usersFile,JSON.stringify(employees,null,2),{mode:0o600});assert.equal((await req('/system/user/getInfo',{cookie:e.cookie})).http,401);e=await login(employee);assert.equal(e.mustChange,false);report.checks.push('employee '+suffix+' first password change required; old cookie revoked');}
 assert.equal((await req('/ai/brand',{method:'PUT',cookie:e.cookie,body:{...old,expectedVersion:old.version}})).data.code,403);assert.equal((await req('/system/user/list?pageNum=1&pageSize=10',{cookie:e.cookie})).data.code,403);report.checks.push('employee '+suffix+' denied native user administration and brand mutation');
 const info=(await req('/system/user/getInfo',{cookie:e.cookie})).data.data.user;
 assert.equal((await req('/system/user/changeStatus',{method:'PUT',cookie:a.cookie,body:{userId:info.userId,status:'1'}})).data.code,200);
 try{assert.equal((await req('/system/user/getInfo',{cookie:e.cookie})).http,401);report.checks.push('employee '+suffix+' disable immediately revokes existing cookie');}
 finally{assert.equal((await req('/system/user/changeStatus',{method:'PUT',cookie:a.cookie,body:{userId:info.userId,status:'0'}})).data.code,200);}
 }
 assert.equal((await req('/auth/logout',{body:{},cookie:a.cookie})).data.code,200);assert.equal((await req('/system/user/getInfo',{cookie:a.cookie})).data.code,401);report.checks.push('native logout invalidates cookie session');report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;process.exitCode=1;}
fs.mkdirSync(out,{recursive:true});const name='identity-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';fs.writeFileSync(path.join(out,name),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
