import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const root=path.resolve(import.meta.dirname,'../..'),out=path.join(root,'evidence/v1/rc2/r3'),origin='https://localhost:3582';
const user=JSON.parse(fs.readFileSync(path.join(root,'.state/rc2/bootstrap.json')));
const report={date:new Date().toISOString(),status:'RUNNING',browser:'installed Google Chrome, trusted TLS',checks:[],pageErrors:[]};
const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage();page.setDefaultTimeout(30000);
page.on('pageerror',e=>report.pageErrors.push(e.message));
try{
 await page.goto(origin+'/admin/');await page.getByPlaceholder('用户名',{exact:true}).fill(user.username);await page.getByPlaceholder('密码',{exact:true}).fill(user.password);
 await page.getByRole('button',{name:/^登\s*录$/}).click();await page.waitForURL(u=>!u.pathname.includes('login'));
 const cookies=await context.cookies();const session=cookies.find(c=>c.name==='__Host-workspace-rc2');assert.ok(session?.secure&&session?.httpOnly&&session?.sameSite==='Strict');assert.equal(await page.evaluate(()=>document.cookie.includes('__Host-workspace-rc2')),false);report.checks.push('real Chrome login with inaccessible secure session cookie');
 const storage=await page.evaluate(()=>({local:{...localStorage},session:{...sessionStorage}}));assert.ok(!JSON.stringify(storage).includes(user.password));assert.ok(!JSON.stringify(storage).includes(session.value));report.checks.push('browser storage contains neither password nor bearer credential');
 for(const route of ['user','dept','role']){
 const [response]=await Promise.all([page.waitForResponse(r=>r.url().includes('/api/system/'+route+'/list')&&r.request().method()==='GET'),page.goto(origin+'/admin/system/'+route)]);assert.equal((await response.json()).code,200);await page.locator('.el-table').first().waitFor();report.checks.push('native '+route+' page works through unified HTTPS');}
 await page.goto(origin+'/admin/workspace-settings/brand');await page.getByRole('button',{name:'保存配置'}).waitFor();const input=page.getByPlaceholder('请输入登录页副标题');const old=await input.inputValue();const next='企业 AI 工作台 · 浏览器配置验证';await input.fill(next);
 const [save]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/ai/brand')&&r.request().method()==='PUT'),page.getByRole('button',{name:'保存配置'}).click()]);assert.equal((await save.json()).code,200);await page.screenshot({path:path.join(out,'brand-admin.png'),fullPage:true});
 const anon=await browser.newContext();const login=await anon.newPage();await login.goto(origin+'/admin/login');await login.getByText(next,{exact:true}).waitFor();report.checks.push('brand saved in admin appears in new anonymous login page');await login.screenshot({path:path.join(out,'brand-login.png'),fullPage:true});await anon.close();
 await input.fill(old);const [restore]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/ai/brand')&&r.request().method()==='PUT'),page.getByRole('button',{name:'保存配置'}).click()]);assert.equal((await restore.json()).code,200);report.checks.push('original branding restored through real UI');assert.deepEqual(report.pageErrors,[]);report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;await page.screenshot({path:path.join(out,'identity-browser-failure.png'),fullPage:true});process.exitCode=1;}
finally{await browser.close();fs.writeFileSync(path.join(out,'browser-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
