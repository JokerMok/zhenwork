import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {chromium} from '@playwright/test';
const root=path.resolve(import.meta.dirname,'../..'),out=path.join(root,'evidence/v1/rc2/r2');
const user=JSON.parse(fs.readFileSync(path.join(root,'.state/rc2/bootstrap.json')));
const report={date:new Date().toISOString(),status:'RUNNING',browser:'installed Google Chrome',checks:[],pageErrors:[]};
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(30000);
page.on('pageerror',e=>report.pageErrors.push(e.message));
try{
 await page.goto('http://localhost:3581/admin/');
 await page.getByPlaceholder('用户名',{exact:true}).fill(user.username);await page.getByPlaceholder('密码',{exact:true}).fill(user.password);
 await page.getByRole('button',{name:/^登\s*录$/}).click();await page.waitForURL(u=>!u.pathname.includes('login'));report.checks.push('official Vue UI login uses real RuoYi API');
 for(const [route,title,api] of [['user','用户管理','/system/user/list'],['dept','部门管理','/system/dept/list'],['role','角色管理','/system/role/list']]){
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().includes('/api'+api)&&r.request().method()==='GET'),page.goto('http://localhost:3581/admin/system/'+route)]);
  assert.equal(response.status(),200);assert.equal((await response.json()).code,200);await page.locator('.el-table').first().waitFor();report.checks.push(title+' renders actual PostgreSQL-backed data');
  await page.screenshot({path:path.join(out,'native-'+route+'.png'),fullPage:true});
 }
 assert.deepEqual(report.pageErrors,[]);report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message;await page.screenshot({path:path.join(out,'native-browser-failure.png'),fullPage:true});process.exitCode=1;}
finally{await browser.close();fs.writeFileSync(path.join(out,'native-browser.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));}
