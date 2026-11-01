#!/usr/bin/env node
/** Initial setup through the existing authenticated admin/resource APIs; no database mutation. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {installPackages} from '../../capabilities/industry/lib.mjs';
import {installSpecialist} from '../../capabilities/waste-specialist/install.mjs';
const file=path.resolve(process.argv[2]||'');const st=await fs.lstat(file);
if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw Error('Pass an owner-only setup JSON file (0600)');
const cfg=JSON.parse(await fs.readFile(file,'utf8'));
if(!cfg.root||!path.isAbsolute(cfg.root)||!cfg.origin||!/^https:\/\//.test(cfg.origin)||!Number.isInteger(cfg.controlPort))throw Error('Explicit installation root, HTTPS employee origin and local control port required');
const store=path.join(cfg.root,'shared/config');const secret=JSON.parse(await fs.readFile(path.join(store,'identity.json'),'utf8'));let cookie='';
const api=async(route,method='GET',input)=>{
 const r=await fetch('http://127.0.0.1:'+cfg.controlPort+route,{method,headers:{Origin:cfg.origin,clientid:secret.clientId,...(cookie?{Cookie:cookie}:{}),...(input===undefined?{}:{'Content-Type':'application/json'})},...(input===undefined?{}:{body:JSON.stringify(input)}),signal:AbortSignal.timeout(65000)});
 for(const c of r.headers.getSetCookie())if(c.startsWith('__Host-workspace-rc2='))cookie=c.split(';')[0];
 const body=await r.json();if(!r.ok||body.code!==200)throw Error('Setup API stopped: '+route+' '+body.code+' '+body.msg);return body.data??body;
};
await api('/auth/login','POST',{...secret.admin,clientId:secret.clientId,grantType:'password'});
try{
 const info=(await api('/system/user/getInfo')).user;
 const rows=v=>v.rows||v;
 const roles=rows(await api('/system/role/list?pageNum=1&pageSize=100'));const role=roles.find(r=>r.roleKey==='workspace_employee');if(!role)throw Error('Employee role missing');
 let state=await fs.readFile(path.join(store,'enterprise-setup.json'),'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return{employees:[]};throw e;});
 const save=()=>fs.writeFile(path.join(store,'enterprise-setup.json'),JSON.stringify(state,null,2)+'\n',{mode:0o600});
 for(const employee of cfg.employees||[]){
  if(!/^[a-zA-Z0-9_.-]{3,30}$/.test(employee.username))throw Error('Invalid employee username');
  if(state.employees.some(e=>e.username===employee.username))continue;
  const existing=rows(await api('/system/user/list?pageNum=1&pageSize=100')).find(x=>x.userName===employee.username);if(existing)throw Error('Existing employee requires explicit administrator reconciliation');
  const password='Aa'+randomBytes(7).toString('hex');await api('/system/user','POST',{userName:employee.username,nickName:employee.name||employee.username,deptId:info.deptId,status:'0',userType:'sys_user',gender:'2',roleIds:[role.roleId],postIds:[],password});
  const created=rows(await api('/system/user/list?pageNum=1&pageSize=100')).find(x=>x.userName===employee.username);if(!created)throw Error('Created employee not found');
  state.employees.push({username:employee.username,password,userId:String(created.userId),mustChangePassword:true});await save();
 }
 if(cfg.provider){
  // Keys are read from a separate private file at execution; never copied into the bundle.
  const p=path.resolve(cfg.provider);const st=await fs.lstat(p);if(!st.isFile()||st.isSymbolicLink()||(st.mode&0o077))throw Error('Provider input must be 0600');const model=JSON.parse(await fs.readFile(p,'utf8'));
  if(!state.providerId){const result=await api('/ai/admin/providers','POST',{name:'企业模型连接',providerType:model.providerType,baseUrl:model.baseUrl,protocol:model.protocol||'OPENAI_CHAT',secret:model.secret,enabled:true,timeoutSeconds:90,retryCount:0});state.providerId=String(result.id);await save();}
  if(!state.modelId){const result=await api('/ai/admin/models','POST',{providerId:state.providerId,code:model.code,name:'企业默认模型',enabled:true,streaming:true,tools:true,vision:false,contextWindow:model.contextWindow||128000,maxOutputTokens:model.maxOutputTokens||8192,defaultParameters:{},costConfig:{}});state.modelId=String(result.id);await save();}
 }
 if(!state.modelId&&!cfg.modelId)throw Error('Configure a provider/model in the existing administrator interface or supply a private provider file');state.modelId=state.modelId||cfg.modelId;
 const targets=state.employees.map(e=>({subjectType:'USER',subjectId:e.userId}));
 for(const target of [...targets,{subjectType:'USER',subjectId:String(info.userId)}])await api('/ai/admin/models/'+state.modelId+'/grants','POST',target);
 const defaults=await api('/ai/admin/office-defaults');await api('/ai/admin/office-defaults','PUT',{modelId:state.modelId,expectedVersion:defaults?.version||0});
 const brand=await api('/ai/brand');await api('/ai/brand','PUT',{...brand,productName:cfg.productName||'ZhenWork',companyName:cfg.companyName||'企业',loginTitle:'登录工作台',loginSubtitle:'',expectedVersion:brand.version});
 if(cfg.businessRuleId){
  const rule=await api('/ai/resources/'+cfg.businessRuleId);if(rule.resourceType!=='TOOL'||rule.publishedVersion!==rule.version)throw Error('Publish the enterprise business rule before installation');
  const bindings={environment:cfg.environment,modelId:state.modelId,businessRules:[rule.id],knowledgeByRole:cfg.knowledgeByRole||{},grantTargets:targets};
  const packages=await installPackages(api,bindings,path.join(store,'industry-install.json'));state.packages=packages;
  if(!cfg.methodConfiguration?.company||!cfg.methodConfiguration?.preferences)throw Error('Supply this enterprise’s company and preferences configuration; demo defaults are never assumed for customer files');
  const methodConfiguration={};for(const name of ['company','preferences'])methodConfiguration[name]=JSON.parse(await fs.readFile(path.resolve(cfg.methodConfiguration[name]),'utf8'));
  const waste=packages.find(x=>x.id==='zhenwork-waste-analysis');state.specialist=await installSpecialist(api,{assistantId:waste.assistant.id,expectedAssistantVersion:waste.assistant.version,businessRuleId:rule.id,methodConfiguration,grantTargets:targets},path.join(store,'waste-install.json'));await save();
 }
 const probe=await api('/ai/admin/models/'+state.modelId+'/tests','POST',{});if(probe.status!=='PASS')throw Error('Real provider probe did not pass');
 console.log(JSON.stringify({status:'initialized',employeeCount:state.employees.length,modelProbe:probe.status,standardPackage:state.specialist?.packageVersion||'not-installed',privateReceipt:path.join(store,'enterprise-setup.json')}));
}finally{await api('/auth/logout','POST',{}).catch(()=>{});}
