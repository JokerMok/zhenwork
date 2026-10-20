<template>
  <div class="app-container p-4">
    <header class="heading"><div><h2>Provider 配置</h2><p>管理企业模型服务、连接参数和 API Key。</p></div><el-button type="primary" @click="edit()">新增 Provider</el-button></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-skeleton v-if="loading" :rows="6" animated />
    <el-table v-else :data="rows" empty-text="尚未配置 Provider">
      <el-table-column prop="name" label="名称" min-width="150" /><el-table-column prop="provider_type" label="类型" width="160" />
      <el-table-column prop="base_url" label="服务地址" min-width="280" />
      <el-table-column label="API Key" width="130"><template #default="{row}">{{ row.configured ? '•••••••• 已配置' : '未配置' }}</template></el-table-column>
      <el-table-column prop="secret_updated_at" label="密钥更新时间" min-width="180" />
      <el-table-column label="状态" width="80"><template #default="{row}"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template></el-table-column>
      <el-table-column label="操作" width="220"><template #default="{row}"><el-button link type="primary" @click="edit(row as ProviderRow)">编辑</el-button><el-button link type="danger" :disabled="!row.configured" @click="clearSecret(row as ProviderRow)">清空密钥并停用</el-button></template></el-table-column>
    </el-table>
    <div class="paging"><el-button :disabled="page === 1 || loading" @click="page--; load()">上一页</el-button><span>第 {{ page }} 页</span><el-button :disabled="rows.length < 30 || loading" @click="page++; load()">下一页</el-button></div>
    <el-dialog v-model="dialog" :title="editing ? '编辑 Provider' : '新增 Provider'" width="600px" destroy-on-close @closed="form.secret = ''">
      <el-form label-position="top" @submit.prevent="save">
        <el-form-item label="Provider 名称"><el-input v-model="form.name" placeholder="例如：企业 Ark" maxlength="100" /></el-form-item>
        <el-form-item label="服务类型"><el-select v-model="form.providerType" @change="setEndpoint"><el-option v-for="(name,key) in types" :key="key" :label="name" :value="key" /></el-select></el-form-item>
        <el-form-item label="Base URL"><el-input v-model="form.baseUrl" placeholder="https://provider.example/v1" /></el-form-item>
        <el-form-item label="API Key"><el-input v-model="form.secret" type="password" autocomplete="new-password" :placeholder="editing ? '留空保留已有密钥；输入新值以替换' : '输入 API Key'" /></el-form-item>
        <p class="muted">保存后仅显示配置状态。连接验证请前往“模型与授权”选择模型发起测试。</p>
        <el-form-item label="超时（秒）"><el-input-number v-model="form.timeoutSeconds" :min="5" :max="120" /></el-form-item>
        <el-form-item label="临时服务错误重试次数"><el-input-number v-model="form.retryCount" :min="0" :max="2" /></el-form-item>
        <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
        <el-alert title="保存修改会终止正在使用此 Provider 的任务，新任务使用更新后的配置。" type="warning" :closable="false" />
        <el-alert v-if="saveError" :title="saveError" type="error" :closable="false" />
      </el-form>
      <template #footer><el-button :disabled="saving" @click="dialog=false">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存 Provider</el-button></template>
    </el-dialog>
  </div>
</template>
<script setup lang="ts">
import request from '@/utils/request';
import {modelApi,type ProviderRow} from '@/features/workspace/models';
const rows=ref<ProviderRow[]>([]),loading=ref(true),error=ref(''),page=ref(1),dialog=ref(false),saving=ref(false),saveError=ref(''),editing=ref<string>();
const types={ARK:'Volcengine Ark',OPENAI:'OpenAI Compatible',DEEPSEEK:'DeepSeek Compatible',CUSTOM_OPENAI:'Custom OpenAI-Compatible'};
const defaults=()=>({name:'',providerType:'ARK',baseUrl:'https://ark.cn-beijing.volces.com/api/v3',protocol:'OPENAI_CHAT',secret:'',enabled:true,timeoutSeconds:120,retryCount:0,expectedVersion:undefined as number|undefined});
const form=reactive(defaults());
function setEndpoint(){const urls:Record<string,string>={ARK:'https://ark.cn-beijing.volces.com/api/v3',OPENAI:'https://api.openai.com/v1',DEEPSEEK:'https://api.deepseek.com/v1',CUSTOM_OPENAI:''};form.baseUrl=urls[form.providerType];}
async function load(){loading.value=true;error.value='';try{rows.value=(await modelApi.providers(page.value)).data;}catch{error.value='Provider 加载失败，请重试。';}finally{loading.value=false;}}
function edit(row?:ProviderRow){editing.value=row?.id;Object.assign(form,row?{name:row.name,providerType:row.provider_type,baseUrl:row.base_url,protocol:row.protocol,secret:'',enabled:row.enabled,timeoutSeconds:row.timeout_seconds,retryCount:row.retry_count,expectedVersion:row.version}:defaults());saveError.value='';dialog.value=true;}
async function save(){if(!form.name.trim()||!form.baseUrl||(!editing.value&&!form.secret)){saveError.value='请填写名称、服务地址和 API Key。';return;}saving.value=true;saveError.value='';try{await modelApi.saveProvider(editing.value,{...form});form.secret='';dialog.value=false;ElMessage.success('Provider 已保存');await load();}catch{saveError.value='保存失败，请检查服务地址；若配置已被他人修改，请关闭后重新编辑。';}finally{saving.value=false;}}
async function clearSecret(row:ProviderRow){await ElMessageBox.confirm('清空此服务的密钥并停用？重新启用时需填写新密钥。','清空密钥',{type:'warning'});try{await request({url:'/ai/admin/providers/'+row.id+'/secret',method:'delete',params:{expectedVersion:row.version}});ElMessage.success('密钥已清空，服务已停用');await load();}catch{ElMessage.error('操作失败，请重新加载后重试');}}
onMounted(load);
</script>
<style scoped>.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.heading h2{margin:0 0 8px}.heading p,.muted{color:var(--el-text-color-secondary)}.paging{display:flex;align-items:center;justify-content:flex-end;gap:14px;margin-top:20px}</style>
