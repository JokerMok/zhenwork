import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(path.resolve(process.env.ZHENWORK_MODULES,'package.json'));
const {chromium}=require('playwright');const XLSX=require('xlsx-republish');
const credentials=JSON.parse(await fs.readFile(process.env.ZHENWORK_CREDENTIALS,'utf8'));
const out=path.resolve(process.env.ZHENWORK_EVIDENCE);await fs.mkdir(out,{recursive:true});
const phase=process.argv[2]||'create';const statePath=path.join(out,'pilot-state.json');
let state=await fs.readFile(statePath,'utf8').then(JSON.parse).catch(()=>({}));
const origin='https://zhenwork.shizibandu.icu';const filename='试点费用汇总.xlsx';
const report={time:new Date().toISOString(),phase,checks:[],pageErrors:[],wsFrames:0,wsEvents:[],approvals:0,status:'RUNNING'};
const browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
let context,page;
async function record(){await fs.writeFile(path.join(out,'employee-'+phase+'.json'),JSON.stringify(report,null,2));}
async function check(label){report.checks.push(label);await record();console.log(label);}
async function request(route,method='GET',body){
 return page.evaluate(async({route,method,body})=>{
  const res=await fetch(route,{method,headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:res.status,body:await res.json().catch(()=>null)};
 },{route,method,body});
}
async function login(account){
 context=await browser.newContext({locale:'zh-CN',viewport:{width:1440,height:1000},acceptDownloads:true});page=await context.newPage();
 page.on('pageerror',e=>report.pageErrors.push(e.message));
 page.on('websocket',ws=>ws.on('framereceived',({payload})=>{report.wsFrames++;try{const d=JSON.parse(String(payload));const n=d.name||d.type||d.event;if(typeof n==='string'){if(!report.wsEvents.includes(n))report.wsEvents.push(n);report.wsEventCounts||={};report.wsEventCounts[n]=(report.wsEventCounts[n]||0)+1;}}catch{}}));
 await page.goto(origin+'/enterprise/login',{waitUntil:'domcontentloaded'});
 await page.getByLabel('企业账号').fill(account.username);await page.getByLabel('密码').fill(account.password);await page.getByRole('button',{name:'登录',exact:true}).click();
 await page.waitForURL(u=>u.pathname!=='/enterprise/login',{timeout:30000});
 const info=await request('/api/system/info');assert.equal(info.status,200,JSON.stringify(info));
 const cookie=(await context.cookies()).find(c=>c.name==='__Host-aion-enterprise-web');assert(cookie?.secure&&cookie.httpOnly&&cookie.sameSite==='Strict');
 return info.body.data;
}
async function awaitArtifact(total){
 const deadline=Date.now()+360000;let found=false;
 while(Date.now()<deadline){
  const approvals=page.getByTestId('message-permission-option-proceed_once');
  for(let i=0;i<await approvals.count();i++)if(await approvals.nth(i).isVisible()){
   await approvals.nth(i).click();report.approvals++;await record();break;
  }
  const file=page.getByRole('button',{name:filename,exact:true});
  const stop=page.locator('.sendbox-stop-button');
  if(await file.count() && !(await stop.count()) && (report.wsEventCounts?.['turn.completed']||0)>(report.turnBaseline||0)){found=true;break;}
  await page.waitForTimeout(1000);
 }
 if(!found)throw Error('Actual model task did not finish with the expected office artifact: '+(await page.locator('body').innerText()).slice(-1800));
 await check('Actual model task completed; one-use write approvals preserved');
 const messages=await request(`/api/conversations/${state.conversationId}/messages`);assert.equal(messages.status,200);
 const items=messages.body.data.items;report.messageTypes=[...new Set(items.map(x=>x.type))];
 report.toolMessageCount=items.filter(x=>/tool|function/i.test(String(x.type))).length;
 assert(report.toolMessageCount>0,'No persisted tool call messages');
 const links=await page.locator('[data-local-file-path]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-local-file-path')));
 state.filePath=links.find(x=>x?.endsWith(filename))||state.filePath;
 if(!state.filePath){
  const metadata=await request(`/api/conversations/${state.conversationId}/artifacts`);
  state.filePath=metadata.body?.data?.items?.find(x=>x.name===filename)?.path;
 }
 await page.getByRole('button',{name:filename,exact:true}).last().click();
 await page.locator(`span[title="${filename}"]`).waitFor({timeout:30000});
 await page.getByText('资料印刷',{exact:true}).last().waitFor({timeout:30000});
 await check('Generated XLSX rendered in the employee browser preview');
 const downloadPromise=page.waitForEvent('download',{timeout:20000});
 await page.locator('[title="下载文件"],[title="Download file"]').first().click();
 const download=await downloadPromise;const downloaded=path.join(out,phase+'-'+filename);await download.saveAs(downloaded);
 const bytes=await fs.readFile(downloaded);assert(bytes.subarray(0,2).equals(Buffer.from('PK')));
 const book=XLSX.read(bytes,{type:'buffer'});const rows=XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{header:1});
 const sum=rows.find(r=>r.some(v=>/总计|合计/.test(String(v))));
 assert(sum?.some(v=>Number(String(v).replace(/[^\d.-]/g,''))===total),'Office workbook total mismatch: '+JSON.stringify(rows));
 report.workbookTotal=total;report.downloadBytes=bytes.length;report.downloadedFile=downloaded;
 await fs.writeFile(statePath,JSON.stringify(state,null,2));
 await page.screenshot({path:path.join(out,'employee-'+phase+'.png'),fullPage:true});
 await check('Browser download produced a readable XLSX with expected total '+total);
}
try{
 const account=['isolation','idle'].includes(phase)?credentials.accounts[2]:credentials.accounts[1];const info=await login(account);
 await check('Real Chromium employee login, Core startup, private cookie and public HTTPS');
 if(phase==='create'){
  const created=await request('/api/conversations','POST',{type:'aionrs',name:'网页试点办公文件验收',model:{provider_id:'rc2-enterprise-model',model:'doubao-seed-2-0-mini-260428'},extra:{}});assert.equal(created.status,201,JSON.stringify(created));
  state.conversationId=created.body.data.id;state.workspace=info.work_dir;await fs.writeFile(statePath,JSON.stringify(state,null,2));
  await page.goto(origin+'/#/conversation/'+state.conversationId,{waitUntil:'domcontentloaded'});
  await page.locator('textarea:visible').first().waitFor({timeout:30000});
  const upload=page.waitForResponse(r=>r.url().includes('/api/fs/upload')&&r.request().method()==='POST').catch(()=>null);
  await page.getByTestId('aionrs-file-upload-input').setInputFiles(path.join(out,'试点办公样例.docx'));
  const uploaded=await upload;assert(uploaded,'Browser upload did not produce an HTTP response');assert.equal(uploaded.status(),200);state.uploadPath=(await uploaded.json()).data;
  await page.getByText('试点办公样例.docx',{exact:true}).first().waitFor({timeout:20000});await check('Real DOCX sample uploaded through the browser file input');
  const composer=page.locator('textarea:visible').first();await composer.fill('请读取我上传的《试点办公样例.docx》，使用办公文件工具生成《试点费用汇总.xlsx》，放在工作空间根目录。列为事项、数量、单价、小计，最后一行合计。所有金额请填入计算后的数值，样式简洁易读。必须实际调用工具创建文件，给出可点击的文件链接。不要只回复表格或操作说明。');report.turnBaseline=report.wsEventCounts?.['turn.completed']||0;await composer.press('Enter');await awaitArtifact(72);
  assert((report.wsEventCounts?.['message.stream']||0)>2,'No streamed model output events');await check('WebSocket carried live task events and model output');
 }else if(phase==='modify'){
  await page.goto(origin+'/#/conversation/'+state.conversationId,{waitUntil:'domcontentloaded'});const composer=page.locator('textarea:visible').first();await composer.waitFor({timeout:30000});
  await composer.fill('请继续修改刚才的《试点费用汇总.xlsx》：资料印刷的数量改为3，单价及其他事项保持不变，重新计算小计和合计并将数值保存到原文件。必须实际调用工具修改，再给出更新后的可点击文件链接。');report.turnBaseline=report.wsEventCounts?.['turn.completed']||0;await composer.press('Enter');await awaitArtifact(90);
  await check('Existing conversation and office file continued and modified successfully');
 }else if(phase==='isolation'){
  const list=await request('/api/conversations?limit=100');assert.equal(list.status,200);assert(!JSON.stringify(list.body).includes(state.conversationId));
  for(const route of [`/api/conversations/${state.conversationId}`,`/api/conversations/${state.conversationId}/messages`,`/api/conversations/${state.conversationId}/confirmations`,`/api/fs/stream?kind=local&path=${encodeURIComponent(state.filePath)}`]){
   const denied=await request(route);assert([400,403,404].includes(denied.status),route+' returned '+denied.status);
  }
  const denied=await request('/api/fs/read','POST',{path:state.uploadPath,workspace:state.workspace});assert([400,403,404].includes(denied.status));
  await check('Second ordinary account cannot list/read the first account conversation, task confirmations, generated file or upload');
  const empty=await request('/api/conversations','POST',{type:'aionrs',name:'空会话回收验收',model:{provider_id:'rc2-enterprise-model',model:'doubao-seed-2-0-mini-260428'},extra:{}});assert.equal(empty.status,201);
  await page.goto(origin+'/#/conversation/'+empty.body.data.id,{waitUntil:'domcontentloaded'});await page.locator('textarea:visible').first().waitFor({timeout:30000});
  report.emptyConversationId=empty.body.data.id;await check('Initialized an unused conversation to verify natural Core reclamation after logout');
 }else if(phase==='idle'){
  const empty=await request('/api/conversations','POST',{type:'aionrs',name:'自然空闲回收验收',model:{provider_id:'rc2-enterprise-model',model:'doubao-seed-2-0-mini-260428'},extra:{}});assert.equal(empty.status,201);
  await page.goto(origin+'/#/conversation/'+empty.body.data.id,{waitUntil:'domcontentloaded'});await page.locator('textarea:visible').first().waitFor({timeout:30000});
  await page.goto(origin+'/api/system/info',{waitUntil:'domcontentloaded'});
  const count=()=>Number(execFileSync('ssh',['tencent-main',"sudo docker ps -q --filter label=aionui.enterprise=1 --filter label=aionui.root=7701568bf2f8f1e565dd --filter name=-core | wc -l"],{encoding:'utf8'}).trim());
  assert.equal(count(),1);report.emptyConversationId=empty.body.data.id;report.idleStarted=new Date().toISOString();await check('Unused initialized conversation remains authenticated while the WebSocket closes');
  const start=Date.now();while(count()>0&&Date.now()-start<210000)await page.waitForTimeout(10000);
  assert.equal(count(),0,'Unused Pending conversation prevented automatic Core reclamation');report.reclaimedAfterSeconds=Math.round((Date.now()-start)/1000);await check('Core and Gateway naturally reclaimed without logout or service restart');
 }else if(phase==='persistence'){
  const conversation=await request(`/api/conversations/${state.conversationId}`);assert.equal(conversation.status,200);
  const artifact=await page.evaluate(async(route)=>{const r=await fetch(route);return {status:r.status,bytes:Array.from(new Uint8Array(await r.arrayBuffer()))};},`/api/fs/stream?kind=local&path=${encodeURIComponent(state.filePath)}`);assert.equal(artifact.status,200);
  const workbook=XLSX.read(Buffer.from(artifact.bytes),{type:'buffer'});const rows=XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]],{header:1});assert(JSON.stringify(rows).includes('90'));
  await page.goto(origin+'/#/conversation/'+state.conversationId,{waitUntil:'domcontentloaded'});await page.locator('textarea:visible').first().waitFor({timeout:30000});
  await check('After project service restart, conversation and modified office file remain readable');
 }
 // Leave the React conversation before an out-of-band logout to avoid its
 // in-flight, intentionally revoked requests being mistaken for persistence errors.
 if(phase!=='idle')await page.goto(origin+'/api/system/info',{waitUntil:'domcontentloaded'});
 const oldCookie=(await context.cookies()).find(c=>c.name==='__Host-aion-enterprise-web');
 const logout=await request('/enterprise/logout','POST',{});assert.equal(logout.status,200);
 await context.addCookies([oldCookie]);const denied=await request('/api/system/info');assert.equal(denied.status,401);await context.clearCookies();
 await check('Employee logout makes the old identity unusable');assert.deepEqual(report.pageErrors,[]);report.status='PASS';
}catch(e){report.status='FAIL';report.error=e.message.split('Call log:')[0].replace(/(__Host-[^=\s]+)=([^;\s]+)/g,'$1=[REDACTED]');process.exitCode=1;if(page)await page.screenshot({path:path.join(out,'employee-'+phase+'-failure.png'),fullPage:true}).catch(()=>{});}
finally{await browser.close();await record();console.log(JSON.stringify(report));}
