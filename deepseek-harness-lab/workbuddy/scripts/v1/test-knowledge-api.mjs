import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';

const configFile=process.env.WORKSPACE_CONFIG_FILE||'.state/v1/config.json';
const bootstrapFile=process.env.WORKSPACE_BOOTSTRAP_FILE||'.state/v1/bootstrap.json';
const reportFile=process.env.WORKSPACE_KNOWLEDGE_REPORT||'evidence/v1/p5/knowledge-api.json';
const config=JSON.parse(fs.readFileSync(configFile,'utf8'));
const bootstrap=JSON.parse(fs.readFileSync(bootstrapFile,'utf8'));
if(config.mode!=='local')throw Error('Synthetic knowledge tests require local mode');
const base=config.publicOrigin;
const suite=randomUUID().slice(0,8);
const checks=[];
const mutations=[];
const fixtures={suite,departments:[],roles:[],users:[],knowledgeBases:[],documents:[],files:[]};
const sourceFiles=['apps/server/src/knowledge.ts','apps/server/src/files.ts','apps/server/src/uploads.ts','apps/server/src/file-store.ts','apps/server/src/jobs.ts','apps/server/src/auth.ts','packages/contracts/src/index.ts','migrations/0006_knowledge_files.sql','scripts/v1/test-knowledge-api.mjs'];
const sha256=data=>createHash('sha256').update(data).digest('hex');
const sourceHashes=Object.fromEntries(sourceFiles.map(file=>[file,sha256(fs.readFileSync(file))]));
const password=()=>randomBytes(24).toString('base64url');
let admin='';
let database={};
let cleanupAttempted=false;
let cleanupComplete=false;

async function api(route,options={}){
 const method=options.method||'GET';
 const headers={...(method==='GET'||method==='HEAD'?{}:{origin:base}),...(Object.hasOwn(options,'cookie')?(options.cookie?{cookie:options.cookie}:{}):(admin?{cookie:admin}:{})),...(options.headers||{})};
 let body;
 if(Object.hasOwn(options,'json')){headers['content-type']='application/json';body=JSON.stringify(options.json);}
 else if(options.form)body=options.form;
 const response=await fetch(base+route,{method,headers,body,redirect:'error'});
 const bytes=Buffer.from(await response.arrayBuffer());
 let value=null;
 if((response.headers.get('content-type')||'').includes('application/json'))try{value=JSON.parse(bytes.toString('utf8'));}catch{/* malformed JSON is asserted by callers when relevant */}
 return {status:response.status,value,bytes,headers:response.headers,cookie:response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ')};
}

async function test(name,fn){
 try{const details=await fn();checks.push({name,status:'PASS',...(details===undefined?{}:{details})});return true;}
 catch(error){checks.push({name,status:'FAIL',error:error instanceof Error?error.message:String(error)});return false;}
}

function expectStatus(response,status,label='request'){
 assert.equal(response.status,status,`${label}: expected ${status}, received ${response.status} ${JSON.stringify(response.value)}`);
 return response;
}

async function login(email,secret){
 const response=expectStatus(await api('/api/auth/sign-in/email',{method:'POST',cookie:'',json:{email,password:secret}}),200,'login');
 assert.ok(response.cookie,'login did not set a cookie');
 return response.cookie;
}

async function createUser(label,departmentId,roleId){
 const initial=password(),next=password(),email=`p5-${label}-${suite}@local.example`;
 const created=expectStatus(await api('/api/admin/users',{method:'POST',json:{name:`P5 ${label} ${suite}`,email,password:initial,departmentId,roleIds:[roleId]}}),201,'create user');
 let cookie=await login(email,initial);
 const changed=expectStatus(await api('/api/auth/change-password',{method:'POST',cookie,json:{currentPassword:initial,newPassword:next}}),200,'change password');
 cookie=changed.cookie||await login(email,next);
 expectStatus(await api('/api/me',{cookie}),200,'new user /me');
 const user={label,id:created.value.id,email,password:next,cookie,departmentId,roleId,finalEnabled:true};
 fixtures.users.push({label,id:user.id,email,departmentId,roleId,finalEnabled:true});
 mutations.push({type:'user.create',id:user.id,label});
 return user;
}

function uploadForm(name,type,data,field='files'){
 const form=new FormData();form.append(field,new Blob([data],{type}),name);return form;
}

async function setKbAcl(kbId,entries){return expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/acl`,{method:'PUT',json:{entries}}),200,'set KB ACL');}
async function setDocumentAcl(documentId,entries){return expectStatus(await api(`/api/admin/documents/${documentId}/acl`,{method:'PUT',json:{entries}}),200,'set document ACL');}

async function waitForDocument(kbId,documentId,version,{timeoutMs=20000}={}){
 const deadline=Date.now()+timeoutMs;
 let last;
 while(Date.now()<deadline){
  const response=await api(`/api/admin/knowledge-bases/${kbId}/documents`);
  if(response.status===200){last=response.value.find(v=>v.id===documentId);if(last?.version===version&&['ready','failed'].includes(last.status))return last;}
  await delay(250);
 }
 throw Error(`document ${documentId} version ${version} did not settle: ${JSON.stringify(last)}`);
}

async function search(cookie,query,knowledgeBaseId){return api('/api/knowledge/search',{method:'POST',cookie,json:{query,...(knowledgeBaseId?{knowledgeBaseId}:{})}});}
const readAllow=(subjectType,subjectId)=>({subjectType,subjectId,action:'read',effect:'allow'});
const readDeny=(subjectType,subjectId)=>({subjectType,subjectId,action:'read',effect:'deny'});
const manageAllow=(subjectType,subjectId)=>({subjectType,subjectId,action:'manage',effect:'allow'});
const manageDeny=(subjectType,subjectId)=>({subjectType,subjectId,action:'manage',effect:'deny'});

let roles={};let departments={};let users={};let organization;let kbId;let documentId;let sourceV1;let sourceV2;
const markerV1=`P5ACL-${suite}-VERSION-ONE`;
const markerV2=`P5ACL-${suite}-VERSION-TWO`;
const documentV1=Buffer.from(`Synthetic authorization evidence.\n${markerV1}\nOnly this dedicated test fixture uses this marker.\n`,'utf8');
const documentV2=Buffer.from(`Synthetic authorization evidence replacement.\n${markerV2}\nThe former marker is intentionally absent.\n`,'utf8');

try{
 await test('local PG17-backed unified API is reachable',async()=>{
  const pool=new pg.Pool({connectionString:fs.readFileSync(config.databaseURLFile,'utf8').trim(),max:1});
  try{const version=(await pool.query('SHOW server_version')).rows[0].server_version;const versionNum=(await pool.query('SHOW server_version_num')).rows[0].server_version_num;assert.match(versionNum,/^17/);database={engine:'PostgreSQL',serverVersion:version,serverVersionNum:versionNum,connection:'local synthetic app role'};}
  finally{await pool.end();}
  expectStatus(await api('/api/brand',{cookie:''}),200,'unified API');
  return database;
 });

 await test('bootstrap super administrator login',async()=>{
  admin=await login(bootstrap.email,fs.readFileSync(bootstrap.passwordFile,'utf8').trim());
  const me=expectStatus(await api('/api/me'),200,'admin /me').value;
  assert.ok(me.roleCodes.includes('super_admin'));assert.ok(me.permissions.includes('knowledge.manage'));
  return {adminId:me.id,role:'super_admin'};
 });
 if(!admin)throw Error('fixture setup cannot continue without administrator session');
 const adminId=(await api('/api/me')).value.id;

 await test('create dedicated departments, roles, and users through admin APIs',async()=>{
  for(const label of ['alpha','beta']){
   const response=expectStatus(await api('/api/admin/departments',{method:'POST',json:{name:`P5 ACL ${label} ${suite}`,parentId:null}}),201,'create department');
   departments[label]=response.value.id;fixtures.departments.push({label,id:response.value.id});mutations.push({type:'department.create',id:response.value.id,label});
  }
  for(const [label,permissions] of Object.entries({direct:['knowledge.read','files.use'],department:['knowledge.read','files.use'],roleSubject:['knowledge.read','files.use'],other:['knowledge.read','files.use'],manager:['knowledge.read','knowledge.manage','files.use']})){
   const response=expectStatus(await api('/api/admin/roles',{method:'POST',json:{name:`P5 ACL ${label} ${suite}`,permissions}}),201,'create role');
   roles[label]=response.value.id;fixtures.roles.push({label,id:response.value.id,permissions});mutations.push({type:'role.create',id:response.value.id,label});
  }
  users.direct=await createUser('direct',departments.alpha,roles.direct);
  users.department=await createUser('department',departments.alpha,roles.department);
  users.roleSubject=await createUser('role',departments.beta,roles.roleSubject);
  users.other=await createUser('other',departments.beta,roles.other);
  users.manager=await createUser('manager',departments.beta,roles.manager);
  assert.equal(new Set(Object.values(users).map(v=>v.id)).size,5);
  return {departments:2,roles:5,users:5};
 });
 if(Object.keys(users).length!==5)throw Error('fixture setup did not create all dedicated users');

 await test('create dedicated knowledge base and inspect ACL options',async()=>{
  const options=expectStatus(await api('/api/admin/knowledge-options'),200,'knowledge options').value;
  organization=options.organization;
  assert.ok(options.users.some(v=>v.id===users.direct.id));assert.ok(options.departments.some(v=>v.id===departments.alpha));assert.ok(options.roles.some(v=>v.id===roles.roleSubject));
  const created=expectStatus(await api('/api/admin/knowledge-bases',{method:'POST',json:{name:`P5 ACL KB ${suite}`,enabled:true}}),201,'create KB');
  kbId=created.value.id;fixtures.knowledgeBases.push({id:kbId,name:`P5 ACL KB ${suite}`});mutations.push({type:'knowledgeBase.create',id:kbId});
  const acl=expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/acl`),200,'read initial ACL').value.entries;
  assert.ok(acl.some(v=>v.subjectType==='user'&&v.subjectId===adminId&&v.action==='read'&&v.effect==='allow'));
  assert.ok(acl.some(v=>v.subjectType==='user'&&v.subjectId===adminId&&v.action==='manage'&&v.effect==='allow'));
  return {knowledgeBaseId:kbId,organizationId:organization.id,initialEntries:acl.length};
 });
 if(!kbId)throw Error('fixture setup did not create knowledge base');

 await test('real multipart knowledge upload indexes searchable source',async()=>{
  const response=expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/documents`,{method:'POST',form:uploadForm(`p5-${suite}.txt`,'text/plain',documentV1)}),202,'upload knowledge document');
  assert.equal(response.value.documentIds.length,1);documentId=response.value.documentIds[0];fixtures.documents.push({id:documentId,knowledgeBaseId:kbId});mutations.push({type:'document.upload',id:documentId,sha256:sha256(documentV1)});
  const settled=await waitForDocument(kbId,documentId,1);assert.equal(settled.status,'ready');assert.equal(settled.parseStatus,'ready');
  await setKbAcl(kbId,[readAllow('user',adminId),manageAllow('user',adminId)]);
  const result=expectStatus(await search(admin,markerV1,kbId),200,'search uploaded document').value.results;
  assert.equal(result.length,1);assert.equal(result[0].documentId,documentId);sourceV1=result[0].sourceId;
  const source=expectStatus(await api(`/api/knowledge/sources/${sourceV1}`),200,'read source').value;
  assert.equal(source.checksum,sha256(documentV1));assert.equal(source.text,documentV1.toString('utf8'));
  return {documentId,version:source.version,sourceId:sourceV1,checksum:source.checksum,parserVersion:source.parserVersion};
 });
 if(!documentId||!sourceV1)throw Error('document indexing prerequisite failed');

 await test('knowledge manage needs global permission plus dynamic ACL; super_admin is global override',async()=>{
  await setKbAcl(kbId,[readAllow('user',adminId),manageAllow('user',users.manager.id),manageAllow('user',users.direct.id)]);
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/documents`,{cookie:users.manager.cookie}),200,'manager with ACL');
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/documents`,{cookie:users.direct.cookie}),403,'reader lacks global manage permission');
  await setKbAcl(kbId,[manageAllow('organization',organization.id),manageDeny('user',users.manager.id),readAllow('user',adminId)]);
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/documents`,{cookie:users.manager.cookie}),404,'manager explicit deny wins');
  await setKbAcl(kbId,[manageDeny('user',adminId),readAllow('user',adminId)]);
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}`,{method:'PATCH',json:{name:`P5 ACL KB ${suite}`,enabled:true}}),200,'super admin manage override');
  return {readerWithoutPermission:403,managerDenied:404,superAdminOverride:200};
 });

 await test('user-scoped ALLOW exposes only the named user',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('user',users.direct.id)]);await setDocumentAcl(documentId,[]);
  const allowed=expectStatus(await search(users.direct.cookie,markerV1,kbId),200,'direct allow').value.results;
  assert.equal(allowed.length,1);
  expectStatus(await search(users.other.cookie,markerV1,kbId),404,'other user denied');
  const bases=expectStatus(await api('/api/knowledge/bases',{cookie:users.other.cookie}),200,'other bases').value;assert.equal(bases.some(v=>v.id===kbId),false);
  return {allowedUser:users.direct.id,hiddenFromOther:true};
 });

 await test('department-scoped ALLOW grants only department members',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('department',departments.alpha)]);
  for(const user of [users.direct,users.department])assert.equal(expectStatus(await search(user.cookie,markerV1,kbId),200,'department member').value.results.length,1);
  expectStatus(await search(users.roleSubject.cookie,markerV1,kbId),404,'different department');
  return {departmentId:departments.alpha,allowedUsers:2};
 });

 await test('role-scoped ALLOW grants only holders of that role',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('role',roles.roleSubject)]);
  assert.equal(expectStatus(await search(users.roleSubject.cookie,markerV1,kbId),200,'role holder').value.results.length,1);
  expectStatus(await search(users.other.cookie,markerV1,kbId),404,'different role');
  return {roleId:roles.roleSubject};
 });

 await test('organization ALLOW is overridden by matching user or department DENY',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('organization',organization.id),readDeny('user',users.direct.id)]);
  expectStatus(await search(users.direct.cookie,markerV1,kbId),404,'user deny');
  assert.equal(expectStatus(await search(users.other.cookie,markerV1,kbId),200,'organization allow').value.results.length,1);
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('organization',organization.id),readDeny('department',departments.alpha)]);
  expectStatus(await search(users.department.cookie,markerV1,kbId),404,'department deny');
  assert.equal(expectStatus(await search(users.roleSubject.cookie,markerV1,kbId),200,'other department').value.results.length,1);
  return {denyWins:true,organizationId:organization.id};
 });

 await test('document ACL intersects with KB ACL and document DENY wins',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('organization',organization.id)]);
  await setDocumentAcl(documentId,[readAllow('user',users.direct.id)]);
  assert.equal(expectStatus(await search(users.direct.cookie,markerV1,kbId),200,'document allow').value.results.length,1);
  assert.equal(expectStatus(await search(users.other.cookie,markerV1,kbId),200,'document intersection').value.results.length,0);
  const documents=expectStatus(await api(`/api/knowledge/bases/${kbId}/documents`,{cookie:users.other.cookie}),200,'visible documents').value;assert.equal(documents.some(v=>v.id===documentId),false);
  await setDocumentAcl(documentId,[readAllow('organization',organization.id),readDeny('department',departments.alpha)]);
  assert.equal(expectStatus(await search(users.direct.cookie,markerV1,kbId),200,'document deny search').value.results.length,0);
  assert.equal(expectStatus(await search(users.other.cookie,markerV1,kbId),200,'document allow other').value.results.length,1);
  await setDocumentAcl(documentId,[]);
  return {kbAndDocumentIntersection:true,documentDenyWins:true};
 });

 await test('source text and download enforce ACL and preserve exact bytes',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('user',users.direct.id)]);
  const source=expectStatus(await api(`/api/knowledge/sources/${sourceV1}`,{cookie:users.direct.cookie}),200,'allowed source');
  assert.equal(source.value.text,documentV1.toString('utf8'));assert.equal(source.value.checksum,sha256(documentV1));
  const download=expectStatus(await api(`/api/knowledge/sources/${sourceV1}/download`,{cookie:users.direct.cookie}),200,'allowed source download');
  assert.equal(sha256(download.bytes),sha256(documentV1));assert.ok((download.headers.get('x-content-type-options')||'').split(',').every(v=>v.trim()==='nosniff'));assert.match(download.headers.get('content-disposition')||'',/attachment/);
  expectStatus(await api(`/api/knowledge/sources/${sourceV1}`,{cookie:users.other.cookie}),404,'denied source');
  expectStatus(await api(`/api/knowledge/sources/${sourceV1}/download`,{cookie:users.other.cookie}),404,'denied source download');
  return {sourceId:sourceV1,sha256:sha256(download.bytes),bytes:download.bytes.length};
 });

 await test('document replacement creates v2 and invalidates every v1 source URL',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('organization',organization.id)]);await setDocumentAcl(documentId,[]);
  expectStatus(await api(`/api/admin/documents/${documentId}`,{method:'POST',form:uploadForm(`p5-${suite}-v2.txt`,'text/plain',documentV2)}),202,'replace document');mutations.push({type:'document.replace',id:documentId,sha256:sha256(documentV2)});
  const settled=await waitForDocument(kbId,documentId,2);assert.equal(settled.status,'ready');
  expectStatus(await api(`/api/knowledge/sources/${sourceV1}`,{cookie:users.direct.cookie}),404,'old source after replacement');
  expectStatus(await api(`/api/knowledge/sources/${sourceV1}/download`,{cookie:users.direct.cookie}),404,'old download after replacement');
  const oldSearch=expectStatus(await search(users.direct.cookie,markerV1,kbId),200,'old marker search').value.results;assert.equal(oldSearch.some(v=>v.text.includes(markerV1)),false);
  const fresh=expectStatus(await search(users.direct.cookie,markerV2,kbId),200,'new marker search').value.results;assert.equal(fresh.length,1);sourceV2=fresh[0].sourceId;assert.notEqual(sourceV2,sourceV1);
  const source=expectStatus(await api(`/api/knowledge/sources/${sourceV2}`,{cookie:users.direct.cookie}),200,'new source').value;assert.equal(source.version,2);assert.equal(source.checksum,sha256(documentV2));
  const download=expectStatus(await api(`/api/knowledge/sources/${sourceV2}/download`,{cookie:users.direct.cookie}),200,'new download');assert.equal(sha256(download.bytes),sha256(documentV2));
  const versions=expectStatus(await api(`/api/admin/documents/${documentId}/versions`),200,'version list').value;assert.deepEqual(versions.map(v=>v.version),[2,1]);
  return {oldSourceId:sourceV1,newSourceId:sourceV2,versions:versions.map(v=>v.version),sha256:sha256(download.bytes)};
 });
 if(!sourceV2)throw Error('version replacement prerequisite failed');

 await test('ACL revocation blocks later general search, scoped search, source, and download',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('user',adminId)]);
  const general=expectStatus(await search(users.direct.cookie,markerV2),200,'general search after revoke').value;assert.equal(general.results.some(v=>v.documentId===documentId),false);
  expectStatus(await search(users.direct.cookie,markerV2,kbId),404,'scoped search after revoke');
  expectStatus(await api(`/api/knowledge/sources/${sourceV2}`,{cookie:users.direct.cookie}),404,'source after revoke');
  expectStatus(await api(`/api/knowledge/sources/${sourceV2}/download`,{cookie:users.direct.cookie}),404,'download after revoke');
  return {generalSearchResultsForDocument:0,scopedSearch:404,source:404,download:404};
 });

 await test('disabled knowledge base hides reads but remains manageable, then re-enables',async()=>{
  await setKbAcl(kbId,[manageAllow('organization',organization.id),readAllow('organization',organization.id)]);
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}`,{method:'PATCH',json:{name:`P5 ACL KB ${suite}`,enabled:false}}),200,'disable KB');mutations.push({type:'knowledgeBase.disable',id:kbId});
  const bases=expectStatus(await api('/api/knowledge/bases',{cookie:users.direct.cookie}),200,'bases while disabled').value;assert.equal(bases.some(v=>v.id===kbId),false);
  expectStatus(await search(users.direct.cookie,markerV2,kbId),404,'search disabled KB');expectStatus(await api(`/api/knowledge/sources/${sourceV2}`,{cookie:users.direct.cookie}),404,'source disabled KB');
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/documents`,{cookie:users.manager.cookie}),200,'manager manages disabled KB');
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}`,{method:'PATCH',json:{name:`P5 ACL KB ${suite}`,enabled:true}}),200,'re-enable KB');mutations.push({type:'knowledgeBase.enable',id:kbId});
  assert.equal(expectStatus(await search(users.direct.cookie,markerV2,kbId),200,'search re-enabled KB').value.results.length,1);
  return {disabledRead:404,disabledManage:200,reEnabledRead:200};
 });

 await test('dedicated user disable revokes cookie; re-enable requires login and restores ACL access',async()=>{
  await setKbAcl(kbId,[manageAllow('user',adminId),readAllow('user',users.direct.id)]);
  expectStatus(await api(`/api/admin/users/${users.direct.id}`,{method:'PATCH',json:{enabled:false}}),200,'disable user');mutations.push({type:'user.disable',id:users.direct.id});
  expectStatus(await api('/api/me',{cookie:users.direct.cookie}),401,'disabled old cookie');
  const blocked=await api('/api/auth/sign-in/email',{method:'POST',cookie:'',json:{email:users.direct.email,password:users.direct.password}});assert.notEqual(blocked.status,200);assert.equal(blocked.cookie,'');
  expectStatus(await api(`/api/admin/users/${users.direct.id}`,{method:'PATCH',json:{enabled:true}}),200,'re-enable user');mutations.push({type:'user.enable',id:users.direct.id});
  users.direct.cookie=await login(users.direct.email,users.direct.password);
  assert.equal(expectStatus(await search(users.direct.cookie,markerV2,kbId),200,'restored user search').value.results.length,1);
  return {disabledCookie:401,disabledLogin:blocked.status,reEnabledSearch:200};
 });

 await test('private file API denies cross-user and administrator reads',async()=>{
  const content=Buffer.from(`private-${suite}\n`,'utf8');
  const uploaded=expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:uploadForm(`private-${suite}.txt`,'text/plain',content)}),201,'private upload').value.files[0];
  fixtures.files.push({id:uploaded.id,ownerId:users.direct.id,kind:'upload',sha256:sha256(content)});mutations.push({type:'file.upload',id:uploaded.id,ownerId:users.direct.id});
  const own=expectStatus(await api(`/api/files/${uploaded.id}/download`,{cookie:users.direct.cookie}),200,'owner download');assert.equal(sha256(own.bytes),sha256(content));
  for(const [label,cookie] of [['other',users.other.cookie],['admin',admin]]){expectStatus(await api(`/api/files/${uploaded.id}`,{cookie}),404,`${label} metadata`);expectStatus(await api(`/api/files/${uploaded.id}/download`,{cookie}),404,`${label} download`);}
  return {fileId:uploaded.id,ownerSha256:sha256(own.bytes),crossUser:404,administrator:404};
 });

 await test('multipart filename and MIME validation rejects unsafe inputs',async()=>{
  const cases=[
   ['path traversal','../escape.txt','text/plain',Buffer.from('safe'),415],
   ['backslash traversal','..\\escape.txt','text/plain',Buffer.from('safe'),415],
   ['bidi filename','safe\u202Etxt.md','text/plain',Buffer.from('safe'),415],
   ['unknown extension','safe.exe','application/octet-stream',Buffer.from('safe'),415],
   ['MIME mismatch','safe.txt','application/pdf',Buffer.from('safe'),415],
   ['forged PDF','safe.pdf','application/pdf',Buffer.from('not a pdf'),415],
   ['active text','safe.txt','text/plain',Buffer.from('<script>alert(1)</script>'),415],
   ['invalid JSON','safe.json','application/json',Buffer.from('{broken'),415]
  ];
  const statuses={};for(const [label,name,type,data,status] of cases){const response=await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:uploadForm(name,type,data)});expectStatus(response,status,label);statuses[label]=response.status;}
  const accepted=expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:uploadForm(`octet-${suite}.txt`,'application/octet-stream',Buffer.from('plain text'))}),201,'allowed octet-stream for text');
  fixtures.files.push({id:accepted.value.files[0].id,ownerId:users.direct.id,kind:'upload',mime:'text/plain'});mutations.push({type:'file.upload',id:accepted.value.files[0].id,ownerId:users.direct.id});
  return {...statuses,allowedOctetStream:201};
 });

 await test('multipart cardinality, field, and byte limits reject excess before storage',async()=>{
  expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:new FormData()}),400,'empty multipart');
  expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:uploadForm('safe.txt','text/plain',Buffer.from('safe'),'unexpected')}),400,'unexpected field');
  const tooMany=new FormData();for(let i=0;i<11;i++)tooMany.append('files',new Blob([`file-${i}`],{type:'text/plain'}),`f-${i}.txt`);expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:tooMany}),413,'too many files');
  const tooLarge=Buffer.alloc(config.uploadLimitBytes+1,0x61);expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:uploadForm('large.txt','text/plain',tooLarge)}),413,'oversized file');
  const total=new FormData();const half=Math.floor(config.uploadLimitBytes/2)+1024;for(let i=0;i<2;i++){const data=Buffer.alloc(half,0x62);data.write('%PDF-1.7');total.append('files',new Blob([data],{type:'application/pdf'}),`total-${i}.pdf`);}expectStatus(await api('/api/files',{method:'POST',cookie:users.direct.cookie,form:total}),413,'oversized aggregate');
  return {maxFiles:10,tooMany:413,limitBytes:config.uploadLimitBytes,oversizedFile:413,oversizedAggregate:413};
 });

 await test('ACL schema rejects duplicate subjects and foreign IDs atomically',async()=>{
  const before=expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/acl`),200,'ACL before invalid mutation').value;
  const duplicate=[readAllow('user',users.direct.id),readDeny('user',users.direct.id)];expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/acl`,{method:'PUT',json:{entries:duplicate}}),400,'duplicate ACL key');
  expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/acl`,{method:'PUT',json:{entries:[readAllow('user',randomUUID())]}}),400,'foreign subject');
  const after=expectStatus(await api(`/api/admin/knowledge-bases/${kbId}/acl`),200,'ACL after invalid mutation').value;assert.deepEqual(after,before);
  return {duplicate:400,foreignSubject:400,atomic:true};
 });
}
catch(error){checks.push({name:'suite prerequisite or harness failure',status:'FAIL',error:error instanceof Error?error.message:String(error)});}
finally{
 if(admin&&fixtures.users.length){
  cleanupAttempted=true;let ok=true;
  for(const fixture of fixtures.users){
   const response=await api(`/api/admin/users/${fixture.id}`,{method:'PATCH',json:{enabled:false}}).catch(()=>({status:0}));
   if(response.status===200){fixture.finalEnabled=false;mutations.push({type:'user.cleanup_disable',id:fixture.id});}
   else ok=false;
  }
  cleanupComplete=ok;
 }
 const failed=checks.filter(v=>v.status==='FAIL');
 const report={schemaVersion:1,date:new Date().toISOString(),suiteId:suite,target:{origin:base,service:'unified BFF',mode:config.mode,database,synthetic:true},summary:{total:checks.length,passed:checks.length-failed.length,failed:failed.length},checks,fixtures,mutations,contentHashes:{documentV1:sha256(documentV1),documentV2:sha256(documentV2)},sourceHashes,cleanup:{attempted:cleanupAttempted,complete:cleanupComplete,usersLeftDisabled:fixtures.users.filter(v=>v.finalEnabled===false).length},securityReview:{expectedAuthorizationModel:'global permission AND dynamic ACL; DENY wins; document ACL intersects with KB ACL; super_admin overrides manage ACL only',confirmedDefects:[]},secretsPrinted:false};
 fs.mkdirSync(path.dirname(reportFile),{recursive:true});
 fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify({report:reportFile,suiteId:suite,summary:report.summary,cleanup:report.cleanup,secretsPrinted:false},null,2));
 if(failed.length||!cleanupComplete)process.exitCode=1;
}
