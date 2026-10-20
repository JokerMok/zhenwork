import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomInt } from 'node:crypto';
const require=createRequire(path.resolve(process.env.ZHENWORK_MODULES,'package.json'));
const {chromium}=require('playwright');
const credentials=JSON.parse(await fs.readFile(process.env.ZHENWORK_CREDENTIALS,'utf8'));
const out=path.resolve(process.env.ZHENWORK_EVIDENCE);const qaPath=path.join(out,'qa-private.json');
const qaPrivate=JSON.parse(await fs.readFile(qaPath,'utf8'));const qa=qaPrivate.accounts?.[1];assert(qa&&typeof qa.username==='string'&&typeof qa.password==='string'&&qa.userId!==undefined,'Second ordinary QA account is required');
const adminOrigin='https://zhenwork-admin.shizibandu.icu';const origin='https://zhenwork.shizibandu.icu';const TEMP_PASSWORD='a123456';
const phase=process.argv[2]||'all';
const report={phase,time:new Date().toISOString(),status:'RUNNING',checks:[],pageErrors:[]};const secretValues=[credentials.accounts[0].password,qa.password,TEMP_PASSWORD].filter(Boolean);
const redact=s=>secretValues.reduce((v,key)=>v.split(key).join('[REDACTED]'),String(s).split('Call log:')[0]);
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});let admin,employee,employeeContext;
async function record(){await fs.writeFile(path.join(out,'admin-usability-'+phase+'.json'),JSON.stringify(report,null,2));}
async function check(label){report.checks.push(label);await record();console.log(label);}
async function api(page,route,method='GET',body){return page.evaluate(async({route,method,body,clientId})=>{const r=await fetch(route,{method,headers:{'Content-Type':'application/json',clientid:clientId},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json().catch(()=>null)};},{route,method,body,clientId:credentials.clientId});}
async function range(days){const response=admin.waitForResponse(r=>r.url().includes('/ai/admin/dashboard?days='+days));await admin.getByText('近'+days+'天',{exact:true}).click();await (await response).finished();await admin.locator('.usage-home .el-loading-mask').first().waitFor({state:'hidden'});}
async function resetFromUi(){
 await admin.goto(adminOrigin+'/admin/system/user',{waitUntil:'domcontentloaded'});
 const search=admin.getByPlaceholder('请输入用户名称',{exact:true});await search.fill(qa.username);await search.press('Enter');
 const row=admin.locator('.el-table__row').filter({hasText:qa.username});await row.waitFor({timeout:20000});
 const responsePromise=admin.waitForResponse(r=>r.url().includes('/system/user/resetPwd')&&r.request().method()==='PUT');
 await row.getByRole('button',{name:'重置密码',exact:true}).click();const response=await responsePromise;assert.equal(response.status(),200);
 const responseBody=await response.json();assert.equal(responseBody.code,200);const payload=response.request().postDataJSON();assert.equal(String(payload.userId),String(qa.userId));assert.equal(payload.password,TEMP_PASSWORD);
 assert.equal(await admin.getByRole('dialog').count(),0);await admin.getByText('密码已重置为临时密码 a123456，用户首次登录时需设置新密码',{exact:true}).waitFor({timeout:10000});
}
async function setupAndLogin(resetPassword,newPassword){
 await employee.goto(origin+'/enterprise/login',{waitUntil:'domcontentloaded'});
 assert(!(await employee.locator('body').innerText()).includes('使用试点账号开始办公任务'));
 await employee.getByLabel('企业账号').fill(qa.username);await employee.getByLabel('密码',{exact:true}).fill(resetPassword);
 const needsSetup=employee.waitForResponse(r=>r.url().endsWith('/enterprise/login')&&r.request().method()==='POST');
 await employee.getByRole('button',{name:'登录',exact:true}).click();assert.equal((await needsSetup).status(),409);
 await employee.getByText('请先设置新密码，再进入工作台。',{exact:true}).waitFor();
 assert.equal((await employeeContext.cookies()).filter(c=>c.name==='__Host-aion-enterprise-web').length,0);
 await employee.getByLabel('新密码（8–16位字母和数字）',{exact:true}).fill(newPassword);await employee.getByLabel('确认新密码',{exact:true}).fill(newPassword);
 await employee.getByRole('button',{name:'设置密码并登录',exact:true}).click();await employee.waitForURL(u=>u.pathname!=='/enterprise/login',{timeout:30000});
 const info=await api(employee,'/api/system/info');assert.equal(info.status,200,JSON.stringify(info.body));qa.password=newPassword;await fs.writeFile(qaPath,JSON.stringify(qaPrivate,null,2),{mode:0o600});
 return (await employeeContext.cookies()).find(c=>c.name==='__Host-aion-enterprise-web');
}
try{
 const adminContext=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});admin=await adminContext.newPage();admin.on('pageerror',e=>report.pageErrors.push(redact(e.message)));
 await admin.goto(adminOrigin+'/admin/',{waitUntil:'domcontentloaded'});await admin.locator('input[type=text]').first().fill(credentials.accounts[0].username);await admin.locator('input[type=password]').fill(credentials.accounts[0].password);const initialDashboard=phase==='password'?null:admin.waitForResponse(r=>{const url=new URL(r.url());return url.pathname.endsWith('/api/ai/admin/dashboard')&&url.searchParams.get('days')==='7';});await admin.locator('button.submit-button').click();
 await admin.getByRole('heading',{name:'用户使用统计',exact:true}).waitFor({timeout:30000});if(phase!=='password')await admin.locator('.usage-summary dd').first().waitFor();
 if(phase!=='password'){
 const dashboard=await initialDashboard;assert.equal(dashboard.status(),200);const dashboardBody=await dashboard.json();assert.equal(dashboardBody.code,200);const data=dashboardBody.data;const summary=data.summary;
 assert.equal(data.source,'CORE_MODEL_RELAY');assert.equal(data.period.timezone,'Asia/Shanghai');assert.equal(data.daily.length,7);for(const value of Object.values(summary))assert(Number.isSafeInteger(value)&&value>=0);for(const day of data.daily)for(const key of ['requests','completed','failed','cancelled','inputTokens','outputTokens'])assert(Number.isSafeInteger(day[key])&&day[key]>=0);
 assert.equal(data.daily.reduce((n,d)=>n+d.requests,0),summary.requests);assert.equal(data.daily.reduce((n,d)=>n+d.completed,0),summary.completed);assert.equal(data.daily.reduce((n,d)=>n+d.failed,0),summary.failed);assert.equal(data.daily.reduce((n,d)=>n+d.cancelled,0),summary.cancelled);assert.equal(data.daily.reduce((n,d)=>n+d.inputTokens,0),summary.inputTokens);assert.equal(data.daily.reduce((n,d)=>n+d.outputTokens,0),summary.outputTokens);assert.equal(summary.completed+summary.failed+summary.cancelled+summary.inflight+summary.incomplete,summary.requests);assert.equal(summary.reportedRequests+summary.unknownTokenRequests,summary.requests);assert(data.users.length<=100);
 await admin.locator('.usage-home .el-loading-mask').first().waitFor({state:'hidden'});const number=n=>new Intl.NumberFormat('zh-CN').format(n);const compact=s=>s.replace(/\s+/g,'');const expectedSummary=[number(summary.enabledUsers)+'人',number(summary.activeUsers)+'人',number(summary.requests)+'次',summary.reportedRequests?number(summary.inputTokens+summary.outputTokens):'—'];assert.deepEqual((await admin.locator('.usage-summary dd').allTextContents()).map(compact),expectedSummary);const expectedStatus=[`完成${number(summary.completed)}`,`失败${number(summary.failed)}`,`已取消${number(summary.cancelled)}`,`进行中${number(summary.inflight)}`,`回执未完成${number(summary.incomplete)}`];assert.deepEqual((await admin.locator('.usage-status span').allTextContents()).map(compact),expectedStatus);report.dashboard={period:data.period,source:data.source,summary,daily:data.daily,userCount:data.users.length};
 assert(!(await admin.locator('.usage-home').innerText()).includes('RuoYi-Vue-Plus'));await check('Admin home renders the same real model usage returned by the live dashboard response, including dynamic summary and status totals');
 await range(30);await range(90);
 const invalid=await api(admin,'/api/ai/admin/dashboard?days=91');assert.equal(invalid.status,400);await check('Time range switching works; unsupported ranges are rejected');
 await range(7);
 await admin.screenshot({path:path.join(out,'usage-home-desktop.png'),fullPage:true});await admin.setViewportSize({width:390,height:844});await admin.screenshot({path:path.join(out,'usage-home-mobile.png'),fullPage:false});assert.equal(await admin.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1),false);await admin.setViewportSize({width:1440,height:1000});
 }
 if(phase!=='dashboard'){
 const grant=await api(admin,`/api/ai/admin/models/${qaPrivate.modelId??credentials.modelId}/grants`,'POST',{subjectType:'USER',subjectId:qa.userId});assert.equal(grant.body.code,200);
 const next='Ab'+randomInt(100000,1000000),final='Cd'+randomInt(10000000000000,100000000000000);secretValues.push(next,final);
 await resetFromUi();await check('Admin user management resets the second ordinary QA account to the fixed temporary credential with one click and no input dialog');
 employeeContext=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000}});employee=await employeeContext.newPage();employee.on('pageerror',e=>report.pageErrors.push(redact(e.message)));
 await employee.goto(origin+'/enterprise/login',{waitUntil:'domcontentloaded'});
 for(const newPassword of ['12345678','Abc1234','Abcdefghij1234567']){const bad=await api(employee,'/enterprise/password','POST',{username:qa.username,password:TEMP_PASSWORD,newPassword});assert.equal(bad.status,400);assert.equal(bad.body?.error,'INVALID_NEW_PASSWORD');assert.equal((await employeeContext.cookies()).filter(c=>c.name==='__Host-aion-enterprise-web').length,0);}await check('Employee password setup rejects a numeric-only password and passwords outside the 8–16 character range without creating an identity');
 const oldCookie=await setupAndLogin(TEMP_PASSWORD,next);assert(oldCookie);await check('The temporary credential opens mandatory first-login setup; an 8-character mixed password signs in and starts the employee workspace');
 await employee.goto(origin+'/api/system/info',{waitUntil:'domcontentloaded'});
 const wrong=await api(employee,'/enterprise/password','POST',{username:qa.username,password:'Wrong000',newPassword:'Valid123'});assert.equal(wrong.status,401);const foreign=await employeeContext.request.post(origin+'/enterprise/password',{headers:{Origin:'https://attacker.invalid'},data:{username:qa.username,password:next,newPassword:final}});assert.equal(foreign.status(),403);await check('Password change refuses an incorrect old password and foreign Origin');
 await resetFromUi();assert.equal((await api(employee,'/api/system/info')).status,401);await employeeContext.clearCookies();await setupAndLogin(TEMP_PASSWORD,final);await check('A second one-click reset revokes the old identity; mandatory setup accepts a 16-character mixed password and signs in');
 await employee.goto(origin+'/api/system/info',{waitUntil:'domcontentloaded'});assert.equal((await api(employee,'/enterprise/logout','POST',{})).status,200);await employeeContext.clearCookies();
 const direct=await browser.newContext({locale:'zh-CN'});const regular=await direct.newPage();await regular.goto(adminOrigin+'/admin/login',{waitUntil:'domcontentloaded'});
 const login=await regular.evaluate(async({qa,clientId})=>fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',clientid:clientId},body:JSON.stringify({username:qa.username,password:qa.password,clientId,grantType:'password'})}).then(r=>r.json()),{qa,clientId:credentials.clientId});assert.equal(login.code,200);
 const denied=await api(regular,'/api/ai/admin/dashboard?days=7');assert.equal(denied.body.code,403);assert(!denied.body.data);await check('An ordinary user cannot read the admin usage dashboard');
 await api(regular,'/api/auth/logout','POST',{});await direct.close();
 }
 await admin.goto(adminOrigin+'/api/ai/brand',{waitUntil:'domcontentloaded'});await api(admin,'/api/auth/logout','POST',{});
 assert.deepEqual(report.pageErrors,[]);report.status='PASS';await record();
}catch(e){report.status='FAIL';report.error=redact(e.message);process.exitCode=1;if(admin)await admin.screenshot({path:path.join(out,'admin-failure.png'),fullPage:true}).catch(()=>{});if(employee)await employee.screenshot({path:path.join(out,'employee-failure.png'),fullPage:true}).catch(()=>{});}
finally{await record();await browser.close();console.log(JSON.stringify(report));}
