<template>
  <el-dialog v-model="visible" title="从 GitHub 维护技能" width="760px" :close-on-click-modal="false">
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-3" />
    <el-form label-position="top">
      <div class="source-grid">
        <el-form-item label="仓库" required><el-input v-model.trim="source.repository" :disabled="saving" placeholder="owner/repository" /></el-form-item>
        <el-form-item label="分支、标签或提交" required><el-input v-model.trim="source.ref" :disabled="saving" /></el-form-item>
      </div>
      <el-form-item label="技能目录" required><el-input v-model.trim="source.path" :disabled="saving" placeholder="skills/example" /></el-form-item>
      <el-button :loading="previewing" :disabled="saving" @click="loadPreview">检查来源</el-button>

      <el-descriptions v-if="existingOrigin&&!preview" :column="1" border class="preview">
        <el-descriptions-item label="当前仓库">{{ existingOrigin.repository }}</el-descriptions-item>
        <el-descriptions-item label="当前固定提交"><code>{{ existingOrigin.commit }}</code></el-descriptions-item>
        <el-descriptions-item label="当前版本">{{ existingOrigin.version }}</el-descriptions-item>
        <el-descriptions-item label="当前许可">{{ licenseLabel(existingOrigin.license) }}</el-descriptions-item>
        <el-descriptions-item label="当前包 SHA-256"><code>{{ existingOrigin.packageSha256 }}</code></el-descriptions-item>
      </el-descriptions>

      <template v-if="preview">
        <el-descriptions :column="1" border class="preview">
          <el-descriptions-item label="固定提交"><code>{{ preview.origin.commit }}</code></el-descriptions-item>
          <el-descriptions-item label="版本">{{ preview.origin.version }}</el-descriptions-item>
          <el-descriptions-item label="许可">{{ licenseLabel(preview.origin.license) }}</el-descriptions-item>
          <el-descriptions-item label="包 SHA-256"><code>{{ preview.origin.packageSha256 }}</code></el-descriptions-item>
          <el-descriptions-item label="文件">{{ preview.files.length }} 个</el-descriptions-item>
        </el-descriptions>
        <el-form-item label="名称" required><el-input v-model.trim="form.name" maxlength="100" /></el-form-item>
        <el-form-item label="说明"><el-input v-model.trim="form.description" maxlength="500" /></el-form-item>
        <el-table v-if="preview.dependencyFiles.length" :data="preview.dependencyFiles.map(path=>({path}))" size="small">
          <el-table-column prop="path" label="运行环境依赖清单" />
          <el-table-column label="状态" width="120"><template #default>等待 Core 预检</template></el-table-column>
        </el-table>
      </template>
    </el-form>

    <el-table v-if="runtimeIssues.length" :data="runtimeIssues" size="small" class="preview">
      <el-table-column prop="id" label="资源" min-width="220" />
      <el-table-column label="检测结果" min-width="180"><template #default="{row}">{{ failureLabel(row.code) }}</template></el-table-column>
    </el-table>
    <el-alert v-if="currentProbe" :title="`Core 依赖预检：${failureLabel('DEPENDENCY_'+currentProbe.state)}`"
      :type="currentProbe.state==='READY'?'success':'warning'" :closable="false" class="preview" />
    <el-descriptions v-if="currentProbe" :column="1" border class="preview">
      <el-descriptions-item label="Core 镜像"><code>{{ currentProbe.runtimeFingerprint }}</code></el-descriptions-item>
      <el-descriptions-item v-if="currentProbe.checkedAt" label="检测时间">{{ currentProbe.checkedAt }}</el-descriptions-item>
    </el-descriptions>

    <template #footer>
      <el-button @click="visible=false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!preview||previewing||saving" @click="save">
        {{ resource ? '更新为固定提交' : '导入固定提交' }}
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import request, { extractErrorMessage } from '@/utils/request';

type Origin = { repository:string;commit:string;tree:string;path:string;version:string;
  packageSha256:string;license:{status:string;declared?:string;path?:string;sha256?:string} };
type Preview = { name:string;description:string;origin:Origin;
  files:Array<{path:string;sha256:string;size:number}>;dependencyFiles:string[] };
type RuntimeIssue = { id:string;code:string };
type DependencyProbe = {resourceId:string;resourceVersion:number;packageSha256:string;runtimeFingerprint:string;
  checkedAt?:string;state:'READY'|'MISSING'|'INCOMPATIBLE'|'UNVERIFIED'};
type SkillResource = {id:string;version:number;name?:string;description?:string;
  config?:{packageSha256?:string;origin?:Origin}};

const props = withDefaults(defineProps<{
  modelValue:boolean;
  resource?:SkillResource;
  runtimeIssues?:RuntimeIssue[];
}>(), { resource:undefined, runtimeIssues:()=>[] });
const emit = defineEmits<{(event:'update:modelValue',value:boolean):void;(event:'saved',value:unknown):void}>();
const visible = computed({get:()=>props.modelValue,set:(value:boolean)=>emit('update:modelValue',value)});
const source = reactive({repository:'',ref:'main',path:''});
const form = reactive({name:'',description:''});
const preview = ref<Preview>();
const previewing = ref(false), saving = ref(false), error = ref('');
const previewGeneration=ref(0);const previewAbort=ref<AbortController>();
const loadedProbe=ref<DependencyProbe>();const probeGeneration=ref(0);
const existingOrigin=computed(()=>props.resource?.config?.origin);
const currentProbe=computed(()=>{
  const probe=loadedProbe.value,resource=props.resource,hash=resource?.config?.packageSha256;
  return probe&&resource&&hash&&probe.resourceId===resource.id&&probe.resourceVersion===resource.version&&
    probe.packageSha256===hash?probe:undefined;
});

watch(()=>[source.repository,source.ref,source.path],()=>{previewGeneration.value++;previewAbort.value?.abort();previewing.value=false;preview.value=undefined;error.value='';});
watch(()=>[visible.value,props.resource?.id,props.resource?.version],async()=>{
  const generation=++probeGeneration.value;loadedProbe.value=undefined;
  if(!visible.value)return;
  const origin=existingOrigin.value;
  source.repository=origin?.repository||'';source.ref=origin?.commit||'main';source.path=origin?.path||'';
  form.name=props.resource?.name||'';form.description=props.resource?.description||'';
  if(!props.resource)return;
  try{
    const response=await request({url:`/ai/skills/${props.resource.id}/dependency-checks`,method:'get'});
    if(generation===probeGeneration.value&&response.data)loadedProbe.value=response.data as DependencyProbe;
  }catch(e){if(generation===probeGeneration.value)error.value=(await extractErrorMessage(e))||'无法读取当前依赖检测结果。';}
},{immediate:true});
onBeforeUnmount(()=>previewAbort.value?.abort());

async function loadPreview(){
  if(saving.value)return;const input={...source};const generation=++previewGeneration.value;
  previewAbort.value?.abort();const controller=new AbortController();previewAbort.value=controller;
  previewing.value=true;error.value='';
  try{
    const response=await request({url:'/ai/skills/import/github/preview',method:'post',data:input,signal:controller.signal});
    const result=response.data as Preview;
    if(generation!==previewGeneration.value||result.origin.repository!==input.repository||result.origin.path!==input.path)return;
    preview.value=result;
    form.name=props.resource?.name||preview.value.name;
    form.description=props.resource?.description||preview.value.description||'';
  }catch(e){if(generation===previewGeneration.value&&!controller.signal.aborted)error.value=(await extractErrorMessage(e))||'无法读取该 GitHub 来源。';}
  finally{if(generation===previewGeneration.value)previewing.value=false;}
}

async function save(){
  const pinned=preview.value;
  if(!pinned||previewing.value||saving.value||!form.name||pinned.origin.repository!==source.repository||pinned.origin.path!==source.path){error.value='请先检查当前来源并填写名称。';return;}
  saving.value=true;error.value='';
  try{
    const data={repository:pinned.origin.repository,commit:pinned.origin.commit,path:pinned.origin.path,
      name:form.name,description:form.description,...(props.resource?{expectedVersion:props.resource.version}:{idempotencyKey:crypto.randomUUID()})};
    const response=await request({url:props.resource?`/ai/skills/${props.resource.id}/import/github`:'/ai/skills/import/github',method:'post',data});
    loadedProbe.value=undefined;emit('saved',response.data);visible.value=false;ElMessage.success(props.resource?'技能版本已更新':'技能已导入');
  }catch(e){error.value=(await extractErrorMessage(e))||'技能导入未完成。';}
  finally{saving.value=false;}
}

function licenseLabel(value:Origin['license']){
  const declared=value.declared||'未声明';
  return value.path?`${declared} · ${value.path} · ${value.sha256}`:declared;
}

const failureLabels:Record<string,string>={
  DEPENDENCY_READY:'依赖版本匹配',
  DEPENDENCY_MISSING:'Core 缺少依赖',DEPENDENCY_INCOMPATIBLE:'Core 依赖版本不兼容',
  DEPENDENCY_UNVERIFIED:'Core 无法确认依赖版本',RESOURCE_UNAVAILABLE:'MCP 资源不可用',
  CONNECTION_NOT_READY:'MCP 连接未就绪',CONNECTION_UNAUTHORIZED:'MCP 连接授权失效',
  PROXY_START_FAILED:'MCP 代理启动失败',PROXY_ROUTE_FAILED:'MCP 代理路由失败',
  CORE_REGISTRATION_FAILED:'Core 注册 MCP 失败',CORE_REGISTRATION_INVALID:'Core 返回的 MCP 身份不匹配',
  CORE_ENABLE_FAILED:'Core 启用 MCP 失败',REVOCATION_FAILED:'MCP 撤销失败'
};
function failureLabel(code:string){return failureLabels[code]||code;}
</script>

<style scoped>
.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.preview{margin-top:16px}code{overflow-wrap:anywhere}
</style>
