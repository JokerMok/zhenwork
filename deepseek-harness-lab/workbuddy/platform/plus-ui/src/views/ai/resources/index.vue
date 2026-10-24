<template>
  <div class="app-container p-4">
    <h2>AI 资源管理</h2>
    <el-tabs v-model="scope" @tab-change="page=1;load()">
      <el-tab-pane label="企业资源" name="enterprise" />
      <el-tab-pane label="安全治理元数据" name="govern" />
    </el-tabs>
    <p>{{ scope === 'enterprise' ? '独立维护助手、技能、MCP、工具和知识库；助手只组合已授权能力。' : '私人资源只展示运行治理元数据，不显示名称、配置或正文。' }}</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-3" />
    <div v-if="scope === 'enterprise'" class="toolbar">
      <el-select v-model="type" aria-label="资源类型" @change="page=1;load()">
        <el-option v-for="(label,key) in types" :key="key" :label="label" :value="key" />
      </el-select>
      <el-button type="primary" @click="edit()">新建企业{{ types[type] }}</el-button>
    </div>
    <el-table v-loading="loading" :data="rows">
      <el-table-column v-if="scope === 'enterprise'" prop="name" label="名称" />
      <el-table-column v-else prop="id" label="资源 ID" />
      <el-table-column label="类型"><template #default="{row}">{{ types[row.resourceType] }}</template></el-table-column>
      <el-table-column label="归属" min-width="100"><template #default="{row}">{{workspaceLabel(row.ownerType)}}</template></el-table-column>
      <el-table-column v-if="scope === 'enterprise'" label="版本">
        <template #default="{row}">草稿 v{{ row.version }}<span v-if="row.publishedVersion"> · 已激活 v{{ row.publishedVersion }}</span></template>
      </el-table-column>
      <el-table-column v-if="scope === 'enterprise'" label="范围" min-width="100"><template #default="{row}">{{workspaceLabel(row.visibility)}}</template></el-table-column>
      <el-table-column label="状态"><template #default="{row}">{{ row.securityDisabled ? '安全停用' : row.enabled ? '已启用' : '已停用' }}</template></el-table-column>
      <el-table-column label="操作" min-width="430">
        <template #default="{row}">
          <template v-if="scope === 'enterprise'">
            <el-button link @click="edit(row.id)">编辑</el-button>
            <el-button link @click="openVersions(row)">版本</el-button>
            <el-button link :disabled="row.visibility === 'ENTERPRISE_PUBLIC'" @click="activate(row,row.version)">激活最新版</el-button>
            <el-button link @click="publish(row)">提交审核</el-button>
            <el-button link @click="openShares(row)">共享授权</el-button>
            <el-button v-if="row.resourceType === 'KNOWLEDGE'" link @click="openDocuments(row)">文档</el-button>
            <el-button v-if="row.resourceType === 'MCP'" link :disabled="!row.publishedVersion" @click="openConnection(row)">企业连接</el-button>
            <el-button link @click="act(()=>api('/ai/resources/'+row.id+'/enabled',{enabled:!row.enabled},'put'))">{{ row.enabled ? '停用' : '启用' }}</el-button>
            <el-button v-if="row.visibility === 'ENTERPRISE_PUBLIC'" link @click="withdraw(row)">撤回发布</el-button>
          </template>
          <el-button v-else link @click="govern(row)">{{ row.securityDisabled ? '解除安全停用' : '安全停用' }}</el-button>
        </template>
      </el-table-column>
    </el-table>
    <div class="mt-4"><el-button :disabled="page===1||loading" @click="page--;load()">上一页</el-button>第 {{ page }} 页<el-button :disabled="rows.length<30||loading" @click="page++;load()">下一页</el-button></div>

    <el-dialog v-model="dialog" :title="(editing?'编辑':'新建')+'企业'+types[type]" width="860px" :before-close="closeEditor" :close-on-click-modal="false">
      <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-3" />
      <el-form label-position="top">
        <el-form-item label="名称" required><el-input v-model="form.name" maxlength="100" /></el-form-item>
        <el-form-item label="说明"><el-input v-model="form.description" maxlength="500" /></el-form-item>
        <template v-if="type === 'ASSISTANT'">
          <el-form-item label="头像符号"><el-input v-model="form.avatar" maxlength="12" /></el-form-item>
          <el-form-item label="授权模型" required><el-select v-model="form.modelId"><el-option v-for="m in models" :key="m.id" :label="m.name" :value="m.id" /></el-select></el-form-item>
          <el-form-item label="助手指令"><el-input v-model="form.instruction" type="textarea" :rows="5" maxlength="4000" /></el-form-item>
          <el-form-item v-for="kind in dependencyKinds" :key="kind.type" :label="kind.label">
            <el-select v-model="form[kind.key]" multiple :multiple-limit="kind.type==='TOOL'?16:8"><el-option v-for="r in choices[kind.type]||[]" :key="r.id" :label="r.name" :value="r.id" /></el-select>
          </el-form-item>
        </template>
        <template v-else-if="type === 'SKILL'">
          <el-alert title="目录导入会保存 SKILL.md、脚本、二进制模板和依赖清单；不会在导入时执行脚本或安装依赖。" type="info" :closable="false" class="mb-3" />
          <el-form-item label="导入完整 Skill 目录">
            <input type="file" webkitdirectory directory multiple :disabled="busy" @change="importSkillDirectory" />
          </el-form-item>
          <el-form-item label="只替换 SKILL.md"><input type="file" accept=".md" :disabled="busy" @change="importSkillMarkdown" /></el-form-item>
          <el-alert v-if="ignoredFiles.length" :title="'已明确忽略生成文件：'+ignoredFiles.join('、')" type="warning" :closable="false" class="mb-3" />
          <el-form-item label="技能依赖（发布和运行时逐项校验）">
            <el-select v-model="form.skillDependencies" multiple :multiple-limit="8"><el-option v-for="r in skillDependencyChoices" :key="r.id" :label="r.name" :value="r.id" /></el-select>
          </el-form-item>
          <el-form-item label="所需平台工具（发布和运行时逐项校验）">
            <el-select v-model="form.skillRequiredTools" multiple :multiple-limit="8"><el-option v-for="r in choices.TOOL||[]" :key="r.id" :label="r.name" :value="r.id" /></el-select>
          </el-form-item>
          <el-alert v-if="missingSkillDependencies.length" :title="'当前无权使用或未激活的依赖：'+missingSkillDependencies.join('、')" type="error" :closable="false" class="mb-3" />
          <el-alert v-if="packageDependencyFiles.length" :title="'检测到运行环境依赖声明：'+packageDependencyNames+'。保存不会自动安装；在 Core 提供只读依赖诊断前，员工端会明确标为运行环境未验证。'" type="warning" :closable="false" class="mb-3" />
          <el-collapse v-if="packageDependencyFiles.length" class="mb-3">
            <el-collapse-item v-for="file in packageDependencyFiles" :key="file.path" :title="file.path"><pre class="source">{{ file.content }}</pre></el-collapse-item>
          </el-collapse>
          <el-form-item label="技能原文"><el-input v-model="form.source" type="textarea" :rows="12" maxlength="24000" /></el-form-item>
          <div class="package-title">随版本保存的文件（{{ form.files.length }}/200，解码后 {{ formatBytes(packageBytes) }}/30 MiB）</div>
          <el-table :data="form.files" max-height="320">
            <el-table-column prop="path" label="相对路径" min-width="300" />
            <el-table-column label="格式" width="90"><template #default="{row}">{{ row.encoding==='base64'?'二进制':'UTF-8' }}</template></el-table-column>
            <el-table-column label="大小" width="110"><template #default="{row}">{{ formatBytes(fileBytes(row)) }}</template></el-table-column>
            <el-table-column label="可执行" width="100"><template #default="{row}"><el-checkbox v-model="row.executable" :disabled="!row.path.startsWith('scripts/')" /></template></el-table-column>
            <el-table-column label="操作" width="80"><template #default="{$index}"><el-button link type="danger" @click="form.files.splice($index,1)">移除</el-button></template></el-table-column>
          </el-table>
        </template>
        <template v-else-if="type === 'TOOL'">
          <el-form-item label="允许的工具类型"><el-select v-model="form.toolType"><el-option v-for="t in toolTypes" :key="t.code" :value="t.code" :label="t.name" /></el-select></el-form-item>
          <el-form-item v-if="form.toolType === 'CALCULATOR'" label="除法小数位"><el-input-number v-model="form.precision" :min="0" :max="8" /></el-form-item>
        </template>
        <template v-else-if="type === 'MCP'">
          <el-form-item label="服务类型"><el-select v-model="form.managedProfile"><el-option label="公网 HTTPS" value="" /><el-option label="本地验收目录（合成数据）" value="acceptance-catalog" /></el-select></el-form-item>
          <el-form-item v-if="!form.managedProfile" label="MCP HTTPS 地址"><el-input v-model="form.endpoint" /></el-form-item>
          <el-form-item label="认证类型"><el-select v-model="form.authType"><el-option label="Bearer 密钥" value="BEARER" /><el-option v-if="!form.managedProfile" label="无认证" value="NONE" /></el-select></el-form-item>
          <el-form-item label="超时（秒）"><el-input-number v-model="form.timeoutSeconds" :min="5" :max="60" /></el-form-item>
          <div class="package-title">允许调用的工具及影响等级</div>
          <div v-for="(tool,index) in form.mcpTools" :key="index" class="tool-row">
            <el-input v-model="tool.name" placeholder="工具名称" maxlength="64" />
            <el-select v-model="tool.effect"><el-option label="只读" value="READ" /><el-option label="写入" value="WRITE" /><el-option label="对外发送" value="SEND" /><el-option label="必须确认" value="APPROVAL" /></el-select>
            <el-button type="danger" plain @click="form.mcpTools.splice(index,1)">删除</el-button>
          </div>
          <el-button :disabled="form.mcpTools.length>=20" @click="form.mcpTools.push({name:'',effect:'APPROVAL'})">添加工具</el-button>
          <p>未明确标为只读的工具必须经过确认，并由可信代理生成幂等键。公网地址还须列入服务端允许名单。</p>
        </template>
        <p v-else>支持 Word、Excel、PPT、PDF、扫描件、图片和 UTF-8 文本。保存后进入文档管理上传、解析和索引。</p>
      </el-form>
      <template #footer><el-button @click="closeEditor()">取消</el-button><el-button type="primary" :loading="busy" @click="save">保存企业资源</el-button></template>
    </el-dialog>

    <el-dialog v-model="versionsVisible" title="资源版本" width="820px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-3" />
      <p v-if="selected">{{ selected.name }} · 最新 v{{ selected.version }} · 当前激活 {{ selected.publishedVersion ? 'v'+selected.publishedVersion : '无' }}</p>
      <el-table :data="versions">
        <el-table-column prop="version" label="版本" width="90" />
        <el-table-column label="审核状态"><template #default="{row}">{{workspaceLabel(row.review_state)}}</template></el-table-column>
        <el-table-column prop="created_at" label="创建时间" />
        <el-table-column label="操作" width="220"><template #default="{row}"><el-button link @click="previewVersion(row.version)">查看</el-button><el-button v-if="selected?.resourceType==='SKILL'" link :disabled="selected.visibility==='ENTERPRISE_PUBLIC'||selected.publishedVersion===row.version" @click="activate(selected,row.version)">回退/激活</el-button></template></el-table-column>
      </el-table>
      <pre v-if="versionPreview" class="source">{{ versionPreview }}</pre>
    </el-dialog>

    <el-dialog v-model="documentsVisible" title="企业知识文档" width="850px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" />
      <template v-if="selected"><p>{{ selected.name }} · Word/Excel/PPT/PDF/图片/扫描件及 UTF-8 文本，最大 10 MiB。解析失败保留原因；更新后需重新提交发布审核。</p><input type="file" accept=".txt,.md,.csv,.json,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff" :disabled="busy" @change="uploadDocument" /><el-button @click="loadDocuments">刷新索引状态</el-button><el-table :data="documents"><el-table-column prop="title" label="文件" /><el-table-column prop="latest_version" label="版本" /><el-table-column label="索引状态"><template #default="{row}">{{ statuses[row.status]||row.status }}</template></el-table-column><el-table-column label="解析失败原因"><template #default="{row}">{{ documentIssue(row) || "—" }}</template></el-table-column><el-table-column label="操作"><template #default="{row}"><el-button link @click="previewDocument(row)">预览</el-button><input type="file" accept=".txt,.md,.csv,.json,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff" :disabled="busy" @change="uploadDocument($event,row)" /><el-button link @click="reindex(row.id)">重新索引</el-button><el-button link @click="removeDocument(row.id)">删除</el-button></template></el-table-column></el-table><el-button :disabled="documentPage===1" @click="documentPage--;loadDocuments()">上一页文档</el-button><span>第 {{ documentPage }} 页</span><el-button :disabled="documents.length<30" @click="documentPage++;loadDocuments()">下一页文档</el-button><pre class="source">{{ source }}</pre></template>
    </el-dialog>

    <el-dialog v-model="connectionVisible" title="企业 MCP 连接" width="760px">
      <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-3" />
      <el-alert title="凭据只保存在服务端；员工仍需模板 USE 权限。连接测试返回的真实错误会保留。" type="info" :closable="false" />
      <p>{{ statuses[connection?.status]||'尚未配置' }} · {{ connection?.secretConfigured?'已配置密钥':'未配置密钥' }}</p>
      <el-alert v-if="connection?.last_error" :title="'连接错误：'+connection.last_error" type="error" :closable="false" class="mb-3" />
      <el-input v-model="secret" :disabled="clearSecret" type="password" autocomplete="new-password" placeholder="输入新密钥；留空保留已有值" />
      <el-checkbox v-if="connection?.secretConfigured" v-model="clearSecret" @change="clearSecretChanged">清除已保存密钥（连接将停用）</el-checkbox>
      <el-switch v-model="connectionEnabled" active-text="启用连接" />
      <div class="mt-4"><el-button :loading="busy" @click="saveConnection">保存并绑定当前激活版本</el-button><el-button :disabled="!connection?.enabled||busy" @click="testConnection">测试与发现工具</el-button></div>
      <el-table :data="connection?.tools||[]"><el-table-column prop="name" label="工具名称" /><el-table-column prop="description" label="说明" /><el-table-column label="影响"><template #default="{row}">{{ effectLabels[row.effect]||row.effect||'必须确认' }}</template></el-table-column></el-table>
      <el-table v-if="connectionTests.length" :data="connectionTests" class="mt-3"><el-table-column label="测试结果"><template #default="{row}">{{workspaceLabel(row.status)}}</template></el-table-column><el-table-column prop="latency_ms" label="延迟(ms)" /><el-table-column prop="error_code" label="错误" /><el-table-column prop="created_at" label="时间" /></el-table>
    </el-dialog>

    <ResourceShareDialog v-model="sharesVisible" :resource="selected" />

  </div>
</template>

<script setup lang="ts">
import {useUnsavedDialog} from '@/hooks/dialog/useUnsavedDialog';
import {workspaceLabel} from '@/utils/workspacePresentation';
import ResourceShareDialog from '@/components/ResourceShareDialog/index.vue';
import request, { extractErrorMessage } from '@/utils/request';

type SkillFile={path:string;content:string;encoding:'utf8'|'base64';executable:boolean;sha256?:string};
const statuses:Record<string,string>={READY:'可使用',QUEUED:'等待索引',RUNNING:'索引中',COMPLETED:'已完成',FAILED:'失败',ERROR:'失败',NOT_TESTED:'尚未测试'};
const effectLabels:Record<string,string>={READ:'只读',WRITE:'写入',SEND:'对外发送',APPROVAL:'必须确认'};
const types:Record<string,string>={ASSISTANT:'助手',SKILL:'技能',MCP:'MCP',TOOL:'工具',KNOWLEDGE:'知识库'};
const dependencyKinds=[{type:'SKILL',key:'skillIds',label:'绑定技能'},{type:'MCP',key:'mcpIds',label:'绑定 MCP'},{type:'TOOL',key:'toolIds',label:'绑定工具'},{type:'KNOWLEDGE',key:'knowledgeIds',label:'绑定知识'}];
const allowedRoots=new Set(['scripts','templates','references','examples','assets','docs','tests']);
const allowedRootFiles=new Set(['requirements.txt','requirements.lock','pyproject.toml','uv.lock','package.json','package-lock.json','pnpm-lock.yaml','yarn.lock','README.md','CHANGELOG.md','USAGE.md','VERSION','LICENSE','LICENSE.md']);
const ignoredNames=new Set(['.DS_Store','Thumbs.db']);
const type=ref('ASSISTANT'),scope=ref('enterprise'),rows=ref<any[]>([]),page=ref(1),loading=ref(true),error=ref(''),busy=ref(false),dialog=ref(false),editing=ref<any>(),form=ref<any>({}),models=ref<any[]>([]),choices=ref<Record<string,any[]>>({}),toolTypes=ref<any[]>([]),selected=ref<any>();
const documentsVisible=ref(false),documents=ref<any[]>([]),documentJobs=ref<any[]>([]),source=ref(''),documentPage=ref(1);
const connectionVisible=ref(false),connection=ref<any>(),connectionTests=ref<any[]>([]),secret=ref(''),clearSecret=ref(false),connectionEnabled=ref(true);
const versionsVisible=ref(false),versions=ref<any[]>([]),versionPreview=ref('');
const sharesVisible=ref(false),ignoredFiles=ref<string[]>([]);
const closeEditor=useUnsavedDialog(dialog,()=>form.value,busy);
const skillDependencyChoices=computed(()=> (choices.value.SKILL||[]).filter((r:any)=>r.id!==editing.value?.id));
const knownDependencyIds=computed(()=>new Set([...skillDependencyChoices.value,...(choices.value.TOOL||[])].map((r:any)=>r.id)));
const missingSkillDependencies=computed(()=>[...(form.value.skillDependencies||[]),...(form.value.skillRequiredTools||[])].filter((id:string)=>!knownDependencyIds.value.has(id)));
const packageBytes=computed(()=> (form.value.files||[]).reduce((sum:number,file:SkillFile)=>sum+fileBytes(file),0));
const packageDependencyFiles=computed<SkillFile[]>(()=> (form.value.files||[]).filter((file:SkillFile)=>allowedRootFiles.has(file.path)&&/^(?:requirements(?:\.lock|\.txt)|pyproject\.toml|uv\.lock|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock)$/.test(file.path)&&file.encoding==='utf8'));
const packageDependencyNames=computed(()=>packageDependencyFiles.value.map(file=>file.path).join('、'));

async function api(url:string,data?:unknown,method=data?'post':'get'){return(await request({url,method,data,headers:data instanceof FormData?{repeatSubmit:false}:{}})).data;}
async function fail(e:unknown,fallback:string){error.value=(await extractErrorMessage(e))||fallback;}
let listGeneration=0;
async function load(){const g=++listGeneration;loading.value=true;error.value='';try{const result=await api(scope.value==='govern'?'/ai/govern/resources?page='+page.value:'/ai/resources?scope=enterprise&type='+type.value+'&page='+page.value);if(g===listGeneration)rows.value=result;}catch(e){if(g===listGeneration)await fail(e,'资源加载失败，请刷新重试。');}finally{if(g===listGeneration)loading.value=false;}}
async function act(fn:()=>Promise<unknown>,reload=true){busy.value=true;error.value='';try{await fn();if(reload)await load();return true;}catch(e){await fail(e,'操作未完成，请核对资源版本、状态及权限。');return false;}finally{busy.value=false;}}
async function loadChoices(kinds:string[]){for(const kind of kinds){const groups=await Promise.all(['enterprise','public'].map(s=>api('/ai/resources?scope='+s+'&type='+kind+'&page=1')));choices.value[kind]=[...new Map(groups.flat().filter((r:any)=>r.actions?.includes('USE')).map((r:any)=>[r.id,r])).values()];}}
function defaultSkill(){return '---\nname: enterprise-method\ndescription: 企业工作方法\nversion: 1.0.0\nrequiredTools: []\ndependencies: []\n---\n请清晰区分结论和依据。';}
async function edit(id?:string){await act(async()=>{editing.value=id?await api('/ai/resources/'+id):null;const c=editing.value?.config||{};const effects=c.toolEffects||{};form.value={name:editing.value?.name||'',description:editing.value?.description||'',avatar:c.avatar||'✦',instruction:c.instruction||'根据已授权资料和工具完成任务。',modelId:c.modelId||'',skillIds:c.skillIds||[],mcpIds:c.mcpIds||[],toolIds:c.toolIds||[],knowledgeIds:c.knowledgeIds||[],source:c.source||defaultSkill(),files:(c.files||[]).map((f:any)=>({...f,encoding:f.encoding||'utf8',executable:f.executable===true})),skillDependencies:c.manifest?.dependencies||[],skillRequiredTools:c.manifest?.requiredTools||[],toolType:c.toolType||'CALCULATOR',precision:c.precision??4,managedProfile:c.managedProfile||'',endpoint:c.endpoint||'',authType:c.authType||'BEARER',timeoutSeconds:c.timeoutSeconds||30,mcpTools:(c.allowedTools||['search']).map((name:string)=>({name,effect:effects[name]||(c.managedProfile==='acceptance-catalog'&&name==='search'?'READ':'APPROVAL')}))};ignoredFiles.value=[];if(type.value==='ASSISTANT'){models.value=await api('/ai/models/available');await loadChoices(dependencyKinds.map(k=>k.type));}if(type.value==='SKILL')await loadChoices(['SKILL','TOOL']);if(type.value==='TOOL')toolTypes.value=await api('/ai/tool-types');dialog.value=true;},false);}
function setManifestList(sourceText:string,key:string,ids:string[]){const lines=sourceText.replace(/\r\n/g,'\n').split('\n');if(lines[0]!=='---')throw new Error('SkillFrontmatterRequired');const end=lines.indexOf('---',1);if(end<0)throw new Error('SkillFrontmatterRequired');const next=`${key}: [${ids.join(', ')}]`;const index=lines.slice(1,end).findIndex(line=>new RegExp(`^${key}\\s*:`).test(line));if(index>=0)lines[index+1]=next;else lines.splice(end,0,next);return lines.join('\n');}
async function save(){if(busy.value)return;if(!form.value.name?.trim()){error.value='请填写名称。';return;}if(type.value==='SKILL'&&missingSkillDependencies.value.length){error.value='请先解决无权使用或未激活的依赖。';return;}await act(async()=>{const f=form.value;let config:any;if(type.value==='ASSISTANT')config={avatar:f.avatar,instruction:f.instruction,modelId:f.modelId,skillIds:f.skillIds,mcpIds:f.mcpIds,toolIds:f.toolIds,knowledgeIds:f.knowledgeIds};else if(type.value==='SKILL'){let skillSource=setManifestList(f.source,'dependencies',f.skillDependencies);skillSource=setManifestList(skillSource,'requiredTools',f.skillRequiredTools);config={source:skillSource,files:f.files.map(({sha256,...file}:SkillFile)=>file)};}else if(type.value==='TOOL')config={toolType:f.toolType,precision:f.precision};else if(type.value==='KNOWLEDGE')config={format:'TEXT_V1'};else{const tools=f.mcpTools.map((item:any)=>({name:item.name.trim(),effect:item.effect}));if(!tools.length||tools.some((item:any)=>!/^[a-zA-Z0-9_-]{1,64}$/.test(item.name))||new Set(tools.map((item:any)=>item.name)).size!==tools.length)throw new Error('请填写不重复的合法 MCP 工具名称。');config={transport:'STREAMABLE_HTTP',...(f.managedProfile?{managedProfile:f.managedProfile}:{endpoint:f.endpoint}),authType:f.authType,allowedTools:tools.map((item:any)=>item.name),toolEffects:Object.fromEntries(tools.map((item:any)=>[item.name,item.effect])),timeoutSeconds:f.timeoutSeconds};}await api('/ai/resources'+(editing.value?'/'+editing.value.id:''),{name:f.name.trim(),description:f.description.trim(),config,...(editing.value?{expectedVersion:editing.value.version}:{resourceType:type.value,enterprise:true,idempotencyKey:crypto.randomUUID()})},editing.value?'put':'post');dialog.value=false;});}
function validPackagePath(path:string){if(!path||path.length>400||path.startsWith('/')||path.endsWith('/')||path.includes('\\')||[...path].some(character=>character.charCodeAt(0)<32||character.charCodeAt(0)===127))return false;const parts=path.split('/');if(parts.some(p=>!p||p==='.'||p==='..'||/[<>:"|?*]/.test(p)||p.endsWith('.')||p.endsWith(' ')))return false;return parts.length===1?allowedRootFiles.has(path):allowedRoots.has(parts[0]);}
function ignoredPackagePath(path:string){return path.split('/').some(part=>ignoredNames.has(part)||part==='.git'||part==='node_modules'||part==='__pycache__'||part.endsWith('.pyc'));}
async function utf8(file:File){const bytes=await file.arrayBuffer();return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
async function base64(file:File){return await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onerror=()=>reject(reader.error);reader.onload=()=>resolve(String(reader.result).split(',',2)[1]||'');reader.readAsDataURL(file);});}
async function importSkillMarkdown(event:Event){const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;try{if(file.size>24000)throw new Error('SKILL.md 超过 24 KiB。');const text=await utf8(file);if(text.includes('\0'))throw new Error('SKILL.md 必须是 UTF-8 文本。');form.value.source=text;}catch(e){await fail(e,'技能文件不可读取。');}finally{input.value='';}}
async function importSkillDirectory(event:Event){const input=event.target as HTMLInputElement,files=[...(input.files||[])];if(!files.length)return;busy.value=true;error.value='';try{const manifests=files.filter(file=>(file.webkitRelativePath||file.name).split('/').at(-1)==='SKILL.md');if(manifests.length!==1)throw new Error('目录中必须且只能有一个 SKILL.md。');const manifestPath=manifests[0].webkitRelativePath||manifests[0].name;const prefix=manifestPath.slice(0,-'SKILL.md'.length);const companions:SkillFile[]=[];const ignored:string[]=[];let total=0;for(const file of files){const full=file.webkitRelativePath||file.name;if(!full.startsWith(prefix))throw new Error('目录结构不一致。');const relative=full.slice(prefix.length);if(relative==='SKILL.md')continue;if(ignoredPackagePath(relative)){ignored.push(relative);continue;}if(!validPackagePath(relative))throw new Error('不支持或不安全的包路径：'+relative);if(file.size>20*1024*1024)throw new Error('单个文件超过 20 MiB：'+relative);total+=file.size;if(total>30*1024*1024)throw new Error('Skill companion 文件总大小超过 30 MiB。');if(companions.length>=200)throw new Error('Skill companion 文件超过 200 个。');let content:string,encoding:'utf8'|'base64';try{content=await utf8(file);if(content.includes('\0'))throw new Error();encoding='utf8';}catch{if(relative.startsWith('scripts/')||!relative.includes('/'))throw new Error('脚本和根目录依赖/说明文件必须是 UTF-8 文本：'+relative);content=await base64(file);encoding='base64';}companions.push({path:relative,content,encoding,executable:relative.startsWith('scripts/')&&/\.(?:sh|bash|py|js|mjs|cjs|ts)$/.test(relative)});}if(manifests[0].size>24000)throw new Error('SKILL.md 超过 24 KiB。');form.value.source=await utf8(manifests[0]);form.value.files=companions.toSorted((a,b)=>a.path.localeCompare(b.path));ignoredFiles.value=ignored;if(ignored.length)ElMessage.warning('已忽略缓存或依赖目录，清单已显示；其余文件已完整装入当前版本。');else ElMessage.success('完整 Skill 目录已装入当前版本。');}catch(e){await fail(e,'Skill 目录导入失败。');}finally{busy.value=false;input.value='';}}
function fileBytes(file:SkillFile){if(file.encoding==='utf8')return new TextEncoder().encode(file.content).byteLength;return Math.floor(file.content.length*3/4)-(file.content.endsWith('==')?2:file.content.endsWith('=')?1:0);}
function formatBytes(bytes:number){if(bytes<1024)return bytes+' B';if(bytes<1024*1024)return(bytes/1024).toFixed(1)+' KiB';return(bytes/1024/1024).toFixed(1)+' MiB';}
async function activate(row:any,version:number){const ok=await act(async()=>{await api('/ai/resources/'+row.id+'/activate',{version});row.publishedVersion=version;selected.value=await api('/ai/resources/'+row.id);versions.value=await api('/ai/resources/'+row.id+'/versions');},true);if(ok)ElMessage.success('已激活 v'+version);}
async function openVersions(row:any){selected.value=row;versionPreview.value='';await act(async()=>{versions.value=await api('/ai/resources/'+row.id+'/versions');versionsVisible.value=true;},false);}
async function previewVersion(version:number){await act(async()=>{const detail=await api('/ai/resources/'+selected.value.id+'/versions/'+version);const config={...detail.config};if(Array.isArray(config.files))config.files=config.files.map((file:SkillFile)=>({path:file.path,encoding:file.encoding,executable:file.executable,sha256:file.sha256,size:formatBytes(fileBytes(file))}));versionPreview.value=JSON.stringify({name:detail.name,description:detail.description,version:detail.version,config},null,2);},false);}
async function publish(row:any){error.value='';try{const check=await api('/ai/resources/'+row.id+'/publication-check?version='+row.version);if(!check.ready){error.value='暂不能提交：'+check.issues.map((item:any)=>item.type+' '+item.id+' '+item.code).join('；');return;}}catch(e){await fail(e,'发布校验失败。');return;}try{await ElMessageBox.confirm('将当前资源版本及知识文档快照提交审核。依赖权限不会自动扩展。','提交企业发布');}catch{return;}await act(()=>api('/ai/resources/'+row.id+'/publication',{version:row.version}));}
async function withdraw(row:any){try{await ElMessageBox.confirm('撤回公开发布将停止相关任务，并撤回待审申请。','撤回发布');}catch{return;}await act(()=>api('/ai/resources/'+row.id+'/publication',undefined,'delete'));}
async function govern(row:any){let reason;try{reason=(await ElMessageBox.prompt('填写治理原因。此操作不授予私人内容访问权限。','资源安全治理')).value;}catch{return;}await act(()=>api('/ai/govern/resources/'+row.id+'/enabled',{enabled:row.securityDisabled,reason},'put'));}
async function openDocuments(row:any){selected.value=row;documentPage.value=1;source.value='';documentsVisible.value=true;await loadDocuments();}
async function loadDocuments(){await act(async()=>{documents.value=await api('/ai/knowledge/'+selected.value.id+'/documents?page='+documentPage.value);documentJobs.value=await api('/ai/knowledge/'+selected.value.id+'/jobs').catch(()=>[]);},false);}
function documentIssue(row:any){const job=documentJobs.value.find((item:any)=>String(item.document_id||item.documentId)===String(row.id)&&item.version===row.latest_version);return job?.error_code||job?.errorCode||'';}
async function uploadDocument(event:Event,doc?:any){const input=event.target as HTMLInputElement,file=input.files?.[0];if(!file)return;if(file.size>10*1024*1024){await fail(new Error('文件超过10 MiB限制'),'文件超过10 MiB限制');input.value='';return;}await act(async()=>{const data=new FormData();data.set('file',file);data.set('idempotencyKey',crypto.randomUUID());if(doc){data.set('documentId',doc.id);data.set('expectedVersion',String(doc.latest_version));}await api('/ai/knowledge/'+selected.value.id+'/documents',data);await loadDocuments();},false);input.value='';}
async function previewDocument(row:any){await act(async()=>{source.value=(await api('/ai/knowledge/documents/'+row.id+'/versions/'+(row.latest_version||row.version))).content;},false);}
async function reindex(id:string){await act(()=>api('/ai/knowledge/documents/'+id+'/reindex',{}),false);await loadDocuments();}
async function removeDocument(id:string){try{await ElMessageBox.confirm('删除文档会取消相关任务并使旧引用失效。','删除文档');}catch{return;}await act(()=>api('/ai/knowledge/documents/'+id,undefined,'delete'),false);await loadDocuments();}
async function openConnection(row:any){selected.value=row;secret.value='';clearSecret.value=false;connectionTests.value=[];await act(async()=>{const list=await api('/ai/mcp/connections?resourceId='+row.id);connection.value=list.find((c:any)=>c.scope==='ENTERPRISE');connectionEnabled.value=connection.value?.enabled??true;if(connection.value)connectionTests.value=await api('/ai/mcp/connections/'+connection.value.id+'/tests');connectionVisible.value=true;},false);}
function clearSecretChanged(value:unknown){if(value){secret.value='';connectionEnabled.value=false;}}
async function saveConnection(){await act(async()=>{connection.value=await api('/ai/mcp/connections'+(connection.value?'/'+connection.value.id:''),{resourceId:selected.value.id,scope:'ENTERPRISE',templateVersion:selected.value.publishedVersion,secret:secret.value||null,clearSecret:clearSecret.value,enabled:connectionEnabled.value,...(connection.value?{expectedVersion:connection.value.version}:{})},connection.value?'put':'post');secret.value='';clearSecret.value=false;connectionTests.value=await api('/ai/mcp/connections/'+connection.value.id+'/tests');},false);}
async function testConnection(){await act(async()=>{await api('/ai/mcp/connections/'+connection.value.id+'/tests',{});const list=await api('/ai/mcp/connections?resourceId='+selected.value.id);connection.value=list.find((c:any)=>c.scope==='ENTERPRISE');connectionTests.value=await api('/ai/mcp/connections/'+connection.value.id+'/tests');if(connection.value?.status==='READY')ElMessage.success('企业 MCP 已验证，可供授权员工使用。');else throw new Error(connection.value?.last_error||'连接测试失败');},false);}
function openShares(row:any){selected.value=row;sharesVisible.value=true;}
onMounted(load);
</script>

<style scoped>
.toolbar{display:flex;gap:16px;margin:16px 0}.toolbar .el-select{width:200px}.source{white-space:pre-wrap;max-height:360px;overflow:auto;padding:16px;background:#f5f7fa}.package-title{font-weight:600;margin:14px 0 8px}.tool-row{display:grid;grid-template-columns:1fr 170px auto;gap:10px;margin-bottom:10px}.mb-3{margin-bottom:12px}
</style>
