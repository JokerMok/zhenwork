import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomInt } from 'node:crypto';
const require=createRequire(path.resolve(process.env.ZHENWORK_MODULES,'package.json'));
const {chromium}=require('playwright');
const credentials=JSON.parse(await fs.readFile(process.env.ZHENWORK_CREDENTIALS,'utf8'));
const out=path.resolve(process.env.ZHENWORK_EVIDENCE);const qaPath=path.join(out,'qa-private.json');
const qa=JSON.parse(await fs.readFile(qaPath,'utf8'));const adminOrigin='https://zhenwork-admin.shizibandu.icu';const origin='https://zhenwork.shizibandu.icu';
const phase=process.argv[2]||'all';
const report={phase,time:new Date().toISOString(),status:'RUNNING',checks:[],pageErrors:[]};const secretValues=[credentials.accounts[0].password,qa.password];
const redact=s=>secretValues.reduce((v,key)=>v.split(key).join('[REDACTED]'),s.split('Call log:')[0]);
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});let admin,employee,employeeContext;
async function record(){await fs.writeFile(path.join(out,'admin-usability-'+phase+'.json'),JSON.stringify(report,null,2));}
async function check(label){report.checks.push(label);await record();console.log(label);}
async function api(page,route,method='GET',body){return page.evaluate(async({route,method,body,clientId})=>{const r=await fetch(route,{method,headers:{'Content-Type':'application/json',clientid:clientId},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json().catch(()=>null)};},{route,method,body,clientId:credentials.clientId});}
async function range(days){const response=admin.waitForResponse(r=>r.url().includes('/ai/admin/dashboard?days='+days));await admin.getByText('近'+days+'天',{exact:true}).click();await (await response).finished();await admin.locator('.usage-home .el-loading-mask').first().waitFor({state:'hidden'});}
async function resetFromUi(password){
 await admin.goto(adminOrigin+'/admin/system/user',{waitUntil:'domcontentloaded'});
 const search=admin.getByPlaceholder('请输入用户名称',{exact:true});await search.fill(qa.username);await search.press('Enter');
 const row=admin.locator('.el-table__row').filter({hasText:qa.username});await row.waitFor({timeout:20000});await row.getByRole('button',{name:'重置密码',exact:true}).click();
 const dialog=admin.getByRole('dialog');await dialog.locator('input').fill(password);await dialog.getByRole('button',{name:'确定',exact:true}).click();
 await dialog.waitFor({state:'hidden',timeout:20000});await admin.getByText('密码已重置，用户首次登录时需设置新密码',{exact:true}).waitFor({timeout:10000});
}
async function setupAndLogin(resetPassword,newPassword){
 await employee.goto(origin+'/enterprise/login',{waitUntil:'domcontentloaded'});
 assert(!(await employee.locator('body').innerText()).includes('使用试点账号开始办公任务'));
 await employee.getByLabel('企业账号').fill(qa.username);await employee.getByLabel('密码',{exact:true}).fill(resetPassword);
 const needsSetup=employee.waitForResponse(r=>r.url().endsWith('/enterprise/login')&&r.request().method()==='POST');
 await employee.getByRole('button',{name:'登录',exact:true}).click();assert.equal((await needsSetup).status(),409);
 await employee.getByText('请先设置新密码，再进入工作台。',{exact:true}).waitFor();
 assert.equal((await employeeContext.cookies()).filter(c=>c.name==='__Host-aion-enterprise-web').length,0);
 await employee.getByLabel('新密码（8位字母和数字）',{exact:true}).fill(newPassword);await employee.getByLabel('确认新密码',{exact:true}).fill(newPassword);
 await employee.getByRole('button',{name:'设置密码并登录',exact:true}).click();await employee.waitForURL(u=>u.pathname!=='/enterprise/login',{timeout:30000});
 const info=await api(employee,'/api/system/info');assert.equal(info.status,200,JSON.stringify(info.body));qa.currentPassword=newPassword;await fs.writeFile(qaPath,JSON.stringify(qa,null,2),{mode:0o600});
 return (await employeeContext.cookies()).find(c=>c.name==='__Host-aion-enterprise-web');
}
try{
 const adminContext=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});admin=await adminContext.newPage();admin.on('pageerror',e=>report.pageErrors.push(redact(e.message)));
 await admin.goto(adminOrigin+'/admin/',{waitUntil:'domcontentloaded'});await admin.locator('input[type=text]').first().fill(credentials.accounts[0].username);await admin.locator('input[type=password]').fill(credentials.accounts[0].password);await admin.locator('button.submit-button').click();
 await admin.getByRole('heading',{name:'用户使用统计',exact:true}).waitFor({timeout:30000});if(phase!=='password')await admin.locator('.usage-summary dd').first().waitFor();
 if(phase!=='password'){
 const dashboard=await api(admin,'/api/ai/admin/dashboard?days=7');assert.equal(dashboard.status,200);assert.equal(dashboard.body.code,200);const data=dashboard.body.data;
 assert.equal(data.source,'CORE_MODEL_RELAY');assert.equal(data.daily.length,7);assert.equal(data.daily.reduce((n,d)=>n+d.requests,0),data.summary.requests);assert.equal(data.summary.requests,10);assert.equal(data.summary.inputTokens,120941);assert.equal(data.summary.outputTokens,2346);report.dashboard=data;
 assert(!(await admin.locator('.usage-home').innerText()).includes('RuoYi-Vue-Plus'));await check('Admin home shows real model usage, daily trend and per-user statistics; totals match live audit baseline');
 await range(30);await range(90);
 const invalid=await api(admin,'/api/ai/admin/dashboard?days=91');assert.equal(invalid.status,400);await check('Time range switching works; unsupported ranges are rejected');
 await range(7);
 await admin.screenshot({path:path.join(out,'usage-home-desktop.png'),fullPage:true});await admin.setViewportSize({width:390,height:844});await admin.screenshot({path:path.join(out,'usage-home-mobile.png'),fullPage:false});assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);await admin.setViewportSize({width:1440,height:1000});
 }
 if(phase!=='dashboard'){
 const grant=await api(admin,`/api/ai/admin/models/${credentials.modelId}/grants`,'POST',{subjectType:'USER',subjectId:qa.userId});assert.equal(grant.body.code,200);
 const first='Ab'+randomInt(100000,1000000),next='Cd'+randomInt(100000,1000000),second='Ef'+randomInt(100000,1000000),final='Gh'+randomInt(100000,1000000);secretValues.push(first,next,second,final);
 await resetFromUi(first);await check('Admin user management accepts an 8-character letter-and-digit password reset through the real dialog');
 const bad=await api(admin,'/api/system/user/resetPwd','PUT',{userId:qa.userId,password:'12345678'});assert.equal(bad.status,400);await check('Backend rejects a digits-only new password');
 employeeContext=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});employee=await employeeContext.newPage();employee.on('pageerror',e=>report.pageErrors.push(redact(e.message)));
 const oldCookie=await setupAndLogin(first,next);assert(oldCookie);await check('Correct reset credential opens first-login setup; an 8-character new password signs in and starts the employee workspace');
 await employee.goto(origin+'/api/system/info',{waitUntil:'domcontentloaded'});
 const wrong=await api(employee,'/enterprise/password','POST',{username:qa.username,password:'Wrong000',newPassword:'Valid123'});assert.equal(wrong.status,401);const foreign=await employeeContext.request.post(origin+'/enterprise/password',{headers:{Origin:'https://attacker.invalid'},data:{username:qa.username,password:next,newPassword:final}});assert.equal(foreign.status(),403);await check('Password change refuses an incorrect old password and foreign Origin');
 await resetFromUi(second);assert.equal((await api(employee,'/api/system/info')).status,401);await employeeContext.clearCookies();await setupAndLogin(second,final);await check('A second reset revokes the old employee identity and the new reset/setup/login cycle still succeeds');
 await employee.goto(origin+'/api/system/info',{waitUntil:'domcontentloaded'});assert.equal((await api(employee,'/enterprise/logout','POST',{})).status,200);await employeeContext.clearCookies();
 const direct=await browser.newContext({locale:'zh-CN'});const regular=await direct.newPage();await regular.goto(adminOrigin+'/admin/login',{waitUntil:'domcontentloaded'});
 const login=await regular.evaluate(async({qa,clientId})=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',clientid:clientId},body:JSON.stringify({username:qa.username,password:qa.currentPassword,clientId,grantType:'password'})}).then(r=>r.json()),{qa,clientId:credentials.clientId});assert.equal(login.code,200);
 const denied=await api(regular,'/api/ai/admin/dashboard?days=7');assert.equal(denied.body.code,403);assert(!denied.body.data);await check('An ordinary user cannot read the admin usage dashboard');
 await api(regular,'/api/auth/logout','POST',{});await direct.close();
 }
 await admin.goto(adminOrigin+'/api/ai/brand',{waitUntil:'domcontentloaded'});await api(admin,'/api/auth/logout','POST',{});
 assert.deepEqual(report.pageErrors,[]);report.status='PASS';await record();
}catch(e){report.status='FAIL';report.error=redact(e.message);process.exitCode=1;if(admin)await admin.screenshot({path:path.join(out,'admin-failure.png'),fullPage:true}).catch(()=>{});if(employee)await employee.screenshot({path:path.join(out,'employee-failure.png'),fullPage:true}).catch(()=>{});}
finally{await record();await browser.close();console.log(JSON.stringify(report));}
