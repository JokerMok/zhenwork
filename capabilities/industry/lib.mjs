import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
export const ROOT=path.dirname(fileURLToPath(import.meta.url));
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const stable=value=>JSON.stringify(value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(stable(value[k]))])):Array.isArray(value)?value.map(v=>JSON.parse(stable(v))):value);
export const digest=value=>createHash('sha256').update(typeof value==='string'?value:stable(value)).digest('hex');
const ids=value=>{if(!Array.isArray(value)||value.length>8||value.some(x=>!uuid.test(x))||new Set(value).size!==value.length)throw Error('Invalid dependency UUID list');return value;};
export function validateBindings(b){
 if(!b||!/^[a-z0-9][a-z0-9-]{2,60}$/.test(b.environment)||!uuid.test(b.modelId))throw Error('environment and real modelId required');
 ids(b.businessRules||[]);for(const list of Object.values(b.knowledgeByRole||{}))ids(list);
 if(!b.grantTargets?.length||b.grantTargets.length>10||b.grantTargets.some(t=>!['USER','ROLE','DEPARTMENT'].includes(t.subjectType)||!/^\d{1,19}$/.test(t.subjectId)||(t.subjectType!=='USER'&&b.allowGroupGrant!==true)))throw Error('Explicit scoped grantTargets required; group grants require allowGroupGrant=true');
 return b;
}
async function companion(file,relative){const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink())throw Error('Only ordinary package files allowed');const content=await fs.readFile(file,'utf8');return{path:relative,content,encoding:'utf8',executable:relative.startsWith('scripts/')&&relative.endsWith('.py'),sha256:digest(content)};}
/** Build complete existing SKILL_PACKAGE_V1 inputs without widening its frontmatter protocol. */
export async function buildPackages(bindings){
 validateBindings(bindings);const catalog=JSON.parse(await fs.readFile(path.join(ROOT,'catalog.json'),'utf8'));const output=[];
 for(const item of catalog.packages){
  if(!/^[a-z-]+$/.test(item.directory))throw Error('Invalid package directory');
  const dir=path.join(ROOT,item.directory),meta=JSON.parse(await fs.readFile(path.join(dir,'references/capability.json'),'utf8'));
  if(meta.id!==item.id||meta.version!==item.version||!/^\d+\.\d+\.\d+$/.test(meta.version))throw Error('Package metadata/version mismatch');
  const toolIds=item.directory==='waste-analysis'?ids(bindings.businessRules||[]):[];
  if(item.directory==='waste-analysis'&&!toolIds.length)throw Error('Waste analysis requires an actual published business rule UUID');
  let source=await fs.readFile(path.join(dir,'SKILL.md'),'utf8');
  if(!source.startsWith('---\n')||!source.includes('version: '+item.version+'\n'))throw Error('Invalid supported manifest');
  source=source.replace('requiredTools: []','requiredTools: '+JSON.stringify(toolIds));
  const files=[];
  for(const folder of ['references','templates'])for(const name of (await fs.readdir(path.join(dir,folder))).sort())files.push(await companion(path.join(dir,folder,name),folder+'/'+name));
  files.push(await companion(path.join(ROOT,'common/validate_result.py'),'scripts/validate_result.py'));
  files.push(await companion(path.join(ROOT,'common/README.md'),'scripts/README.md'));
  const skill={name:meta.title+' · 工作方法',description:'[industry:'+meta.id+'] '+meta.description,config:{source,files}};
  const assistant={name:meta.title,description:'[industry:'+meta.id+'] '+meta.description,config:{avatar:'✦',modelId:bindings.modelId,skillIds:[],mcpIds:[],toolIds,knowledgeIds:ids(bindings.knowledgeByRole?.[meta.knowledgeRole]||[]),instruction:`你是${meta.title}。使用 zhenwork-${item.directory} 工作方法 ${meta.version}，实际加载并遵循其完整步骤、判断规则与配套模板。先确认当前员工资料范围和必要输入；只在实质缺项时提问。使用现有受控工具，不能用本地命令代替正常读取/计算。仅调用当前员工获授权的知识和工具，不要求填写模型或密钥。输出范围、原文事实、推断与缺项分清，不声称未经验证的客户结论。需要双成果时用同一验证数据生成，缺少任何必需成果就如实报告部分完成。自然语言选择此能力不扩大权限，也不改变其他任务的专家。`}};
  output.push({id:item.id,version:meta.version,directory:item.directory,skill,assistant,sha256:digest({skill,assistant})});
 }
 return output;
}
const commandKey=value=>{const h=digest(value);return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
function rawConfig(type,config){if(type!=='SKILL')return config;return{source:config.source,files:(config.files||[]).map(f=>({path:f.path,content:f.content,encoding:f.encoding||'utf8',executable:!!f.executable,sha256:f.sha256||digest(f.content)})).sort((a,b)=>a.path.localeCompare(b.path))};}
async function save(file,state){await fs.mkdir(path.dirname(file),{recursive:true,mode:0o700});const temp=file+'.tmp';await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await fs.rename(temp,file);}
/** Use existing resource APIs, preserving manual edits and audit. No direct database or credential distribution. */
export async function installPackages(api,bindings,statePath){
 const definitions=await buildPackages(bindings);let state=await fs.readFile(statePath,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return{schemaVersion:1,environment:bindings.environment,packages:{}};throw e;});
 if(state.environment!==bindings.environment)throw Error('State belongs to another enterprise environment');
 const result=[];
 for(const item of definitions){
  const previous=state.packages[item.id]||{};const record={...previous,packageVersion:item.version,definitionSha256:item.sha256,status:'preparing'};state.packages[item.id]=record;await save(statePath,state);
  for(const type of ['SKILL','ASSISTANT']){
   const key=type.toLowerCase(),desired=structuredClone(item[key]);if(type==='ASSISTANT')desired.config.skillIds=[record.skill.id];
   const wanted=digest(rawConfig(type,desired.config));let current;
   if(record[key]?.id)current=await api('/ai/resources/'+record[key].id);
   else{const catalog=await api('/ai/resources?type='+type+'&scope=enterprise');const candidates=catalog.filter(x=>x.description?.startsWith('[industry:'+item.id+'] '));if(candidates.length>1)throw Error('Ambiguous managed resource; inspect installation state');if(candidates.length)current=await api('/ai/resources/'+candidates[0].id);}
   if(current){const have=digest(rawConfig(type,current.config));if(have!==wanted){if(!record[key]||have!==record[key].configSha256)throw Error('Managed resource changed outside installer; reconcile '+item.id+' '+type);current=await api('/ai/resources/'+current.id,'PUT',{...desired,expectedVersion:current.version});}}
   else current=await api('/ai/resources','POST',{...desired,resourceType:type,enterprise:true,idempotencyKey:commandKey(bindings.environment+':'+item.id+':'+type+':'+wanted)});
   record[key]={id:current.id,version:current.version,configSha256:wanted};await save(statePath,state);
   if(current.publishedVersion!==current.version)current=await api('/ai/resources/'+current.id+'/activate','POST',{version:current.version});
   if(current.enabled===false)throw Error('Managed resource is disabled; enable explicitly in administrator UI');
   const plan=await api('/ai/resources/'+current.id+'/shares/plan','POST',{targets:bindings.grantTargets,actions:['VIEW','USE']});
   if(!plan.ready)throw Error('Dependency grant blocked: '+JSON.stringify(plan.issues));
   if(plan.additions.some(a=>a.sensitive))throw Error('Sensitive dependency requires explicit administrator UI confirmation; installer does not grant it');
   const existingShares=await api('/ai/resources/'+current.id+'/shares');
   const already=bindings.grantTargets.every(t=>existingShares.some(s=>(s.subjectType||s.subject_type)===t.subjectType&&String(s.subjectId||s.subject_id)===t.subjectId&&s.status==='ACTIVE'&&(Array.isArray(s.actions)?s.actions:JSON.parse(s.actions||'[]')).includes('USE')));
   if(already&&!plan.additions.length){record[key].sharing={reused:true};await save(statePath,state);continue;}
   const shared=await api('/ai/resources/'+current.id+'/shares/batch','POST',{targets:bindings.grantTargets,actions:['VIEW','USE'],fingerprint:plan.fingerprint,confirmedDependencies:[],idempotencyKey:commandKey(bindings.environment+':'+item.id+':'+type+':'+plan.fingerprint)});
   record[key].sharing=shared;await save(statePath,state);
  }
  record.status='published';record.installedAt=new Date().toISOString();await save(statePath,state);result.push({id:item.id,packageVersion:item.version,skill:record.skill,assistant:record.assistant});
 }
 return result;
}
