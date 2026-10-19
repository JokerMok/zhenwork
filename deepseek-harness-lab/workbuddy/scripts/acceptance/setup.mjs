import {randomBytes} from 'node:crypto';import {fs,path,state,admin,req,ok,upload,login,load,privateSave,save,assert,delay} from './context.mjs';
if(fs.existsSync(path.join(state,'users.json')))throw Error('Acceptance users already exist; reuse them instead of generating duplicates');
const cookie=await admin(),me=ok(await req('/me',undefined,cookie)).data,boot=load('bootstrap'),users={admin:{id:me.id,email:boot.email,password:fs.readFileSync(path.join(state,'bootstrap-password'),'utf8').trim()}},fixtures={};
const options=ok(await req('/admin/assistant-options',undefined,cookie)).data;
for(const label of ['a','b']){
 const upper=label.toUpperCase(),role=ok(await req('/admin/roles',{name:'RC 员工 '+upper,permissions:['chat.use','files.use','knowledge.read']},cookie),201).data.id;
 const initial=randomBytes(24).toString('base64url'),password=randomBytes(24).toString('base64url'),email='employee_'+label+'@rc.local';
 const user=ok(await req('/admin/users',{name:'员工 '+upper,email,password:initial,roleIds:[role],departmentId:null},cookie),201).data;
 const signed=await login({email,password:initial});ok(await req('/auth/change-password',{currentPassword:initial,newPassword:password},signed.cookie));users[label]={id:user.id,email,password,role};privateSave('users',users);
 const kb=ok(await req('/admin/knowledge-bases',{name:'Knowledge '+upper+' · 验收资料'},cookie),201).data.id;
 const acl=[{subjectType:'user',subjectId:me.id,action:'manage',effect:'allow'},{subjectType:'user',subjectId:user.id,action:'read',effect:'allow'}];ok(await req('/admin/knowledge-bases/'+kb+'/acl',{entries:acl},cookie,'PUT'));
 const marker=label==='a'?'ALPHARC':'BETARC';ok(await upload('Knowledge-'+upper+'.txt',marker+' 合成验收资料。'+(label==='a'?'A 组项目交付周期为四周，验收代号为青松。':'B 组项目交付周期为六周，验收代号为海蓝。')+' 仅用于权限测试。',cookie,'text/plain','/admin/knowledge-bases/'+kb+'/documents'),202);
 for(let i=0;i<100;i++){const docs=ok(await req('/admin/knowledge-bases/'+kb+'/documents',undefined,cookie)).data;if(docs[0]?.status==='ready')break;if(i===99)throw Error('Knowledge indexing timeout');await delay(300);}
 const assistantBody={name:'Assistant '+upper+' · 专属助手',description:'仅员工 '+upper+' 可用；可读写文件、检索授权知识及审批导出。',enabled:true,modelId:options.models[0].id,systemPrompt:'只依据获授权资料回答。用户要求工具时实际调用。不要编造来源。导出文件必须使用 export_document 并等待审批。',tools:['read','write','enterprise_search','proposal_skill','catalog_search','export_document'],roleIds:[role],knowledgeBaseIds:[kb]};
 const assistant=ok(await req('/admin/assistants',assistantBody,cookie),201).data.id;fixtures[label]={knowledgeBaseId:kb,assistantId:assistant,marker,acl,assistantBody};privateSave('fixtures',fixtures);
}
privateSave('users',users);privateSave('test-users',{a:users.a,b:users.b});save('rbac-acl',{status:'SETUP_READY',rolesDiffer:true,resources:Object.fromEntries(Object.entries(fixtures).map(([k,v])=>[k,{assistantId:v.assistantId,knowledgeBaseId:v.knowledgeBaseId,marker:v.marker}])),adminPrivateFilesAccess:'not granted by admin role'});console.log(JSON.stringify({users:3,distinctRoles:true,distinctAssistants:true,distinctKnowledge:true,passwordsPrinted:false}));
