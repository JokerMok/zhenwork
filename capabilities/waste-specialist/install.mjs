/** Existing resource create/version/activate/share APIs only. No direct database writes or secrets. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildBundle, digest } from './bundle.mjs';
const canonical=v=>JSON.stringify(v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):v);
const hash=v=>digest(canonical(v));
const raw=(type,c)=>type==='SKILL'?{source:c.source,files:c.files.map(f=>({path:f.path,content:f.content,encoding:f.encoding||'utf8',executable:!!f.executable,sha256:f.sha256})).sort((a,b)=>a.path.localeCompare(b.path))}:c;
export async function installSpecialist(api,bindings,stateFile){
 if(!/^[0-9a-f-]{36}$/i.test(bindings.assistantId)||!bindings.grantTargets?.length||bindings.grantTargets.some(t=>t.subjectType!=='USER'||!/^\d+$/.test(t.subjectId)))throw Error('Existing assistant ID and explicit employee targets required');
 let state=await fs.readFile(stateFile,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return{schemaVersion:1,resources:{}};throw e;});
 if(state.assistantId&&state.assistantId!==bindings.assistantId)throw Error('Installation belongs to another assistant');state.assistantId=bindings.assistantId;
 const save=async()=>{await fs.mkdir(path.dirname(stateFile),{recursive:true,mode:0o700});const temp=stateFile+'.tmp';await fs.writeFile(temp,JSON.stringify(state,null,2)+'\n',{mode:0o600});await fs.rename(temp,stateFile);};
 const targets=bindings.grantTargets;
 const share=async id=>{
  const plan=await api(`/ai/resources/${id}/shares/plan`,'POST',{targets,actions:['VIEW','USE']});
  if(!plan.ready||plan.additions.some(x=>x.sensitive))throw Error('Dependency sharing needs separate review');
  const existing=await api(`/ai/resources/${id}/shares`);
  const complete=targets.every(t=>existing.some(s=>(s.subjectType||s.subject_type)===t.subjectType&&String(s.subjectId||s.subject_id)===t.subjectId&&s.status==='ACTIVE'&&(Array.isArray(s.actions)?s.actions:JSON.parse(s.actions||'[]')).includes('USE')));
  if(!complete||plan.additions.length)await api(`/ai/resources/${id}/shares/batch`,'POST',{targets,actions:['VIEW','USE'],fingerprint:plan.fingerprint,confirmedDependencies:[],idempotencyKey:randomUUID()});
 };
 const publish=async(key,type,desired)=>{
  const previous=state.resources[key];let current=previous?.id?await api('/ai/resources/'+previous.id):null;
  const wanted=hash(raw(type,desired.config));
  if(current&&hash(raw(type,current.config))!==wanted){if(hash(raw(type,current.config))!==previous.configSha256)throw Error('Resource changed outside this installer: '+key);current=await api('/ai/resources/'+current.id,'PUT',{...desired,expectedVersion:current.version});}
  if(!current)current=await api('/ai/resources','POST',{...desired,resourceType:type,enterprise:true,idempotencyKey:state[key+'Key']||(state[key+'Key']=randomUUID(),await save(),state[key+'Key'])});
  state.resources[key]={id:current.id,version:current.version,configSha256:wanted};await save();
  if(current.publishedVersion!==current.version)await api(`/ai/resources/${current.id}/activate`,'POST',{version:current.version});
  await share(current.id);return current;
 };
 const original=await api('/ai/resources/'+bindings.assistantId);
 if(!state.originalAssistant){if(original.version!==bindings.expectedAssistantVersion)throw Error('Assistant version changed; reconcile before extending');state.originalAssistant=original;state.resources.assistant={id:original.id,version:original.version,configSha256:hash(original.config)};await save();}
 const definition=JSON.parse(await fs.readFile(new URL('./templates/demo-monthly-rule.json',import.meta.url),'utf8'));
 const rule=await publish('demoRule','TOOL',{name:'虚构示范制造厂 · 两月产废口径 v1',description:'完全虚构功能演示；三车间、D-*演示主数据；不改变原有企业产废口径。',config:definition});
 const bundle=await buildBundle([rule.id]);const skill=await publish('standardSkill','SKILL',bundle);
 const base=state.originalAssistant.config;
 const assistant=await publish('assistant','ASSISTANT',{name:'企业固危废数据专员',description:'原六方法保留，追加产废强度与费用变化分析；保留原ID与原全量月报能力。',config:{...base,skillIds:[...new Set([...base.skillIds,skill.id])],toolIds:[...new Set([...base.toolIds,rule.id])],instruction:`你是企业固危废数据专员（原产废数据分析专家，同一资源ID）。原六类工作及新增两类分析按员工自然语言选择或组合。比较生产量/产废强度/费用变化时，读取已配置追加资料，使用run_enterprise_method的intensity和cost_change方法，按绑定来源复用已核对结果，不重新清洗或运行旧月报。只要一次必要Excel与简短结论，缺分母/条件不补造，不把统计变化当工艺原因。先office_context，再check_enterprise_skill(query=\"${skill.id}\", file=\"SKILL.md\")加载标准包入口；需要时按file加载具体方法参考，完整包已安装而非一次展开全部上游财务工作流，按实际返回资源ID调用run_enterprise_method；不通过Exec/Python/目录扫描代替受控工具。默认答复和必要XLSX，不强制每次Word/PPT。\n虚构示范制造厂的模拟资料使用专用WASTE_MONTHLY口径 ${rule.id}；原合成/真实企业资料仍沿原正式口径，不混用。产废分析用标准包返回analysisInput路径和sheet调用inspect_structured_data及analyze_waste_data；首次有歧义才确认映射，完整统计不得凭预览心算。月报Word/Excel和PPT仅在员工需要时生成。\n个人Skill如果被员工明确选择或点名，优先加载并调用该个人资源ID，读取其保存配置；不能偷偷改回企业标准。未知单位/车次/合同条件不补值，内部提醒不当法律裁决；模拟企业API和申报连接未配置，不调用其他公司测试接口。\n原能力兼容：${base.instruction}`}});
 state.status='published';state.publishedAt=new Date().toISOString();await save();return{assistantId:assistant.id,assistantVersion:assistant.version,skillId:skill.id,skillVersion:skill.version,ruleId:rule.id,ruleVersion:rule.version,packageVersion:bundle.config.source.match(/^version: (.+)$/m)[1]};
}
