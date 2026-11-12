<template>
<div class="app-container p-4">
<header class="heading">
  <h2>模型与授权</h2>
  <div class="heading-actions">
    <el-button v-if="canInspectEmployees" @click="employeeDialog = true">按员工查看</el-button>
    <el-button v-if="canConfigureProviders" type="primary" @click="edit()">新增模型</el-button>
  </div>
</header>
<div v-if="error" class="status-actions" role="alert"><span>{{ error }}</span><el-button link type="primary" @click="load">重试</el-button></div>
<div v-if="defaultState!=='ready'||!defaultModelId" class="default-status" role="status"><span>{{ defaultState==='loading'?'正在确认企业默认模型…':defaultState==='error'?'企业默认模型待确认':'尚未设置企业默认模型' }}</span><el-button v-if="defaultState==='error'" link type="primary" @click="loadOfficeDefault">重试</el-button></div>
<el-skeleton v-if="loading" :rows="6" animated />
<el-table v-else-if="!error" :data="rows" row-key="id" empty-text="尚未登记模型">
  <el-table-column label="显示名称" min-width="190">
    <template #default="{ row }"><div class="model-name"><span>{{ row.name }}</span><el-tag v-if="defaultState==='ready'&&row.id===defaultModelId" type="primary" size="small">企业默认</el-tag></div></template>
  </el-table-column>
  <el-table-column label="服务商" min-width="140">
    <template #default="{ row }"><div class="model-name"><span>{{ row.provider_name }}</span><el-tag v-if="!row.provider_enabled" type="info" size="small">已停用</el-tag></div></template>
  </el-table-column>
  <el-table-column prop="code" label="实际 Model ID" min-width="190" />
  <el-table-column label="模型状态" width="100">
    <template #default="{ row }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '已启用' : '已停用' }}</el-tag></template>
  </el-table-column>
  <el-table-column label="连接验证" width="115">
    <template #default="{ row }"><el-tag :type="row.verified_status === 'VERIFIED' ? 'success' : 'info'">{{ row.verified_status === 'VERIFIED' ? '已验证' : '待验证' }}</el-tag></template>
  </el-table-column>
  <el-table-column label="操作" min-width="282">
    <template #default="{ row }">
      <el-button v-if="canConfigureProviders" link type="primary" @click="edit(row as ModelRow)">编辑</el-button>
      <el-tooltip :disabled="canSetDefault(row)" content="企业默认须启用模型与服务商，且模型支持流式输出和工具调用">
        <span :tabindex="canSetDefault(row) ? undefined : 0"><el-button link type="primary" :disabled="!canSetDefault(row)" @click="setDefault(row as ModelRow)">设为企业默认</el-button></span>
      </el-tooltip>
      <el-button link type="primary" @click="openGrants(row as ModelRow)">授权</el-button>
      <el-button link type="primary" @click="openTests(row as ModelRow)">验证连接</el-button>
    </template>
  </el-table-column>
</el-table>
<div v-if="!error" class="paging"><el-button :disabled="page===1||loading" @click="page--;load()">上一页</el-button><span>第 {{ page }} 页</span><el-button :disabled="rows.length<30||loading" @click="page++;load()">下一页</el-button></div>
<el-dialog v-model="dialog" :title="editing?'编辑模型':'新增模型'" width="640px" destroy-on-close :before-close="closeEditor" :close-on-click-modal="false"><el-form label-position="top" :disabled="saving">
<el-form-item label="服务商" required :error="fieldErrors.providerId"><el-select v-model="form.providerId" placeholder="选择服务商" filterable><el-option v-for="p in providers" :key="p.id" :label="p.enabled ? p.name : p.name + '（已停用）'" :value="p.id" /></el-select></el-form-item>
<el-form-item label="实际 Model ID" required :error="fieldErrors.code"><el-input v-model="form.code" placeholder="服务商的模型 ID 或推理接入点 ID" /></el-form-item><el-form-item label="显示名称" required :error="fieldErrors.name"><el-input v-model="form.name" placeholder="员工看到的模型名称" /></el-form-item>
<div class="grid"><el-form-item label="上下文窗口（Token）"><el-input-number v-model="form.contextWindow" :min="1024" :max="2000000" /></el-form-item><el-form-item label="最大输出 Token" :error="fieldErrors.maxOutputTokens"><el-input-number v-model="form.maxOutputTokens" :min="1" :max="32768" /></el-form-item><el-form-item label="流式输出"><el-switch v-model="form.streaming" /></el-form-item><el-form-item label="Tool Calling 能力"><el-switch v-model="form.tools" /></el-form-item><el-form-item label="Temperature（可选）" :error="fieldErrors.temperature"><el-input v-model="form.temperature" placeholder="留空使用默认值" /></el-form-item><el-form-item label="Top P（可选）" :error="fieldErrors.topP"><el-input v-model="form.topP" placeholder="0–1；留空使用默认值" /></el-form-item><el-form-item label="计费币种"><el-select v-model="form.currency"><el-option label="人民币 CNY" value="CNY" /><el-option label="美元 USD" value="USD" /></el-select></el-form-item><el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item><el-form-item label="每百万输入 Token 价格（可选）" :error="fieldErrors.inputPrice"><el-input v-model="form.inputPrice" placeholder="未设置" /></el-form-item><el-form-item label="每百万输出 Token 价格（可选）" :error="fieldErrors.outputPrice"><el-input v-model="form.outputPrice" placeholder="未设置" /></el-form-item></div>
<el-alert v-if="saveError" :title="saveError" type="error" :closable="false" /></el-form><template #footer><div class="editor-footer"><el-alert v-if="editing" title="保存修改会终止该模型的在途任务，并重置验证状态。" type="warning" :closable="false" /><div class="editor-actions"><el-button :disabled="saving" @click="closeEditor()">取消</el-button><el-button type="primary" :loading="saving" @click="save">保存模型</el-button></div></div></template></el-dialog>
<el-dialog v-model="employeeDialog" title="按员工查看模型" width="min(840px, 94vw)" destroy-on-close>
  <EmployeeModelAccess v-if="employeeDialog" :revision="accessRevision" />
</el-dialog>
<el-dialog v-model="grantDialog" :title="'模型授权 · ' + grantModel?.name" width="min(760px, 94vw)"
  :close-on-click-modal="!grantSaving" :close-on-press-escape="!grantSaving" :show-close="!grantSaving" destroy-on-close>
  <el-form label-position="top" class="grant-form" :disabled="grantSaving" @submit.prevent="grant">
    <el-form-item label="授权范围">
      <el-select v-model="subjectType" @change="changeTargetType">
        <el-option v-for="(label, type) in grantScopes" :key="type" :label="label" :value="type" />
      </el-select>
    </el-form-item>
    <el-form-item v-if="subjectType !== 'ALL'" :label="'选择' + grantScopes[subjectType]" :error="targetError" required>
      <el-tree-select v-if="subjectType === 'DEPARTMENT'" v-model="subjectId" :data="departmentOptions"
        node-key="id" :props="{ value: 'id', label: 'name', children: 'children' }" filterable check-strictly placeholder="选择部门" />
      <el-select v-else v-model="subjectId" filterable remote :remote-method="searchTargets" :loading="searching"
        :placeholder="subjectType === 'USER' ? '按姓名或账号搜索' : '按角色名称搜索'" @change="rememberSubject">
        <el-option v-for="target in targets" :key="target.id" :label="target.name" :value="target.id" />
        <template #empty><div class="p-3">{{ targetQuery ? '未找到匹配对象' : '请输入关键词' }}</div></template>
      </el-select>
    </el-form-item>
    <div class="status-actions">
      <span v-if="subjectName">授权「{{ grantModel?.name }}」给{{ subjectType === 'ALL' ? '' : grantScopes[subjectType] + ' ' }}{{ subjectName }}</span>
      <el-button type="primary" native-type="submit" :disabled="!subjectName" :loading="grantSaving">添加授权</el-button>
    </div>
  </el-form>
  <el-alert v-if="grantResult" :title="grantResult" type="success" :closable="false" class="grant-feedback" />
  <el-alert v-if="grantMutationError" :title="grantMutationError" type="error" :closable="false" class="grant-feedback" />
  <el-skeleton v-if="grantLoading" :rows="3" animated />
  <div v-else-if="grantError" class="status-actions" role="alert">
    <span>{{ grantError }}</span><el-button link type="primary" @click="loadGrants">重试</el-button>
  </div>
  <el-table v-else :data="grants" row-key="id" empty-text="此模型尚无直接授权">
    <el-table-column label="范围"><template #default="{ row }">{{ grantScopes[row.subject_type as GrantSubject] || workspaceLabel(row.subject_type) }}</template></el-table-column>
    <el-table-column label="对象"><template #default="{ row }">{{ row.name || row.subject_id }}</template></el-table-column>
    <el-table-column label="操作" width="90"><template #default="{ row }"><el-button link type="danger" :disabled="grantSaving" @click="revoke(row as GrantRow)">撤销</el-button></template></el-table-column>
  </el-table>
  <template v-if="canInspectEmployees && grantDialog && grantModel">
    <el-divider />
    <EmployeeModelAccess :key="grantModel.id" :model-id="grantModel.id" :revision="accessRevision" :affected-employee="affectedEmployee" />
  </template>
</el-dialog>
<el-dialog v-model="testDialog" :title="'连接验证 · ' + testModel?.name" width="min(1000px, 94vw)" destroy-on-close>
  <p v-if="testModel">{{ testModel.provider_name }} · {{ testModel.code }}</p>
  <p>向服务商发送一条短文本请求。员工可用状态可在「按员工查看」中核对。</p>
  <el-alert v-if="testBlockReason" :title="testBlockReason" type="info" :closable="false" />
  <el-button v-if="canConfigureProviders" type="primary" :loading="testing" :disabled="Boolean(testBlockReason)" @click="runTest">发起真实测试</el-button>
  <el-alert v-if="testError" :title="testError" type="error" :closable="false" />
  <el-skeleton v-if="testsLoading" :rows="3" animated />
  <div v-else-if="testLoadError" class="status-actions" role="alert"><span>{{ testLoadError }}</span><el-button link type="primary" @click="loadTests">重试</el-button></div>
  <el-table v-else :data="tests" empty-text="尚无测试记录">
    <el-table-column label="结果" width="80"><template #default="{ row }">{{ workspaceLabel(row.status) }}</template></el-table-column>
    <el-table-column prop="model_code" label="实际 Model ID" min-width="180" />
    <el-table-column prop="request_id" label="Request ID" min-width="165" />
    <el-table-column prop="latency_ms" label="耗时 ms" width="100" />
    <el-table-column prop="error_code" label="错误" min-width="120" />
    <el-table-column prop="created_at" label="时间" min-width="165" />
  </el-table>
</el-dialog>
</div>
</template>
<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import {useUnsavedDialog} from '@/hooks/dialog/useUnsavedDialog';
import {workspaceLabel} from '@/utils/workspacePresentation';
import {modelApi,searchModelEmployees,type ModelRow,type ProviderRow,type GrantRow,type TestRow} from '@/features/workspace/models';
import auth from '@/plugins/auth';
import request, {extractErrorMessage} from '@/utils/request';
import EmployeeModelAccess from './EmployeeModelAccess.vue';

const canConfigureProviders = computed(() => auth.hasPermi('ai:provider:admin'));
const canInspectEmployees = computed(() => auth.hasPermi('system:user:list'));
const employeeDialog = ref(false);
const accessRevision = ref(0);
type ProviderOption = Pick<ProviderRow, 'id' | 'name' | 'enabled'>;
const rows=ref<ModelRow[]>([]),providers=ref<ProviderOption[]>([]),loading=ref(true),error=ref(''),page=ref(1),dialog=ref(false),saving=ref(false),saveError=ref(''),editing=ref<string>();
const defaultModelId=ref<string|null>(null),defaultState=ref<'loading'|'ready'|'error'>('loading');
let defaultGeneration=0;
async function loadOfficeDefault(){
  const generation=++defaultGeneration;
  defaultState.value='loading';defaultModelId.value=null;
  try{
    const {data}=await request({url:'/ai/admin/office-defaults'});
    if(data?.model_id!==null&&typeof data?.model_id!=='string')throw new Error('Invalid office default');
    if(generation!==defaultGeneration)return;
    defaultModelId.value=data.model_id;defaultState.value='ready';
  }catch{if(generation===defaultGeneration)defaultState.value='error';}
}

const defaults=()=>({providerId:'',code:'',name:'',enabled:true,streaming:true,tools:true,vision:false,
  contextWindow:32000,maxOutputTokens:2048,expectedVersion:undefined as number|undefined,
  temperature:'',topP:'',currency:'CNY',inputPrice:'',outputPrice:''});
const form=reactive(defaults());
const fieldErrors = ref<Partial<Record<keyof typeof form, string>>>({});
const closeEditor=useUnsavedDialog(dialog,()=>form,saving);
let listGeneration = 0;
async function load() {
  const generation = ++listGeneration;
  void loadOfficeDefault();
  loading.value = true;
  error.value = '';
  try {
    const { data } = await modelApi.models(page.value);
    if (generation === listGeneration) rows.value = data;
  } catch {
    if (generation === listGeneration) error.value = '模型加载失败';
  } finally {
    if (generation === listGeneration) loading.value = false;
  }
}

async function loadProviders(row?:ModelRow) {
  const options=new Map<string,ProviderOption>();
  for(let page=1;page<=1000;page++){
    const {data}=await modelApi.providers(page);
    for(const provider of data)options.set(provider.id,{id:provider.id,name:provider.name,enabled:provider.enabled});
    if(data.length<30)break;
    if(page===1000)throw new Error('Provider 目录超过可加载范围。');
  }
  // A current binding remains readable even if a concurrent catalog edit moves it between pages.
  if(row&&!options.has(row.provider_id))options.set(row.provider_id,{id:row.provider_id,name:row.provider_name,enabled:row.provider_enabled});
  return [...options.values()];
}

let opening=false;
async function edit(row?:ModelRow){
  if(opening)return;
  opening=true;
  try{
    providers.value=await loadProviders(row);
    const parameters=JSON.parse(row?.default_parameters||'{}'),cost=JSON.parse(row?.cost_config||'{}');
    editing.value=row?.id;
    Object.assign(form,defaults(),row?{
      providerId:row.provider_id,code:row.code,name:row.name,enabled:row.enabled,streaming:row.streaming,
      tools:row.tools,vision:row.vision,contextWindow:row.context_window,maxOutputTokens:row.max_output_tokens,
      expectedVersion:row.version,temperature:String(parameters.temperature??''),topP:String(parameters.top_p??''),
      currency:cost.currency||'CNY',inputPrice:String(cost.inputPerMillion??''),outputPrice:String(cost.outputPerMillion??'')
    }:{});
    saveError.value='';
    fieldErrors.value={};
    dialog.value=true;
  }catch{
    ElMessage.error('无法加载模型或 Provider。');
  }finally{
    opening=false;
  }
}

async function save(){
  if(saving.value)return;
  const {temperature,topP,currency,inputPrice,outputPrice,...model}=form;
  saveError.value = '';
  fieldErrors.value = {};
  if (!model.providerId) fieldErrors.value.providerId = '请选择服务商';
  if (!/^[a-zA-Z0-9._:/-]{1,160}$/.test(model.code)) fieldErrors.value.code = '填写 1–160 个字母、数字或 . _ : / -';
  if (!model.name.trim() || model.name.length > 100) fieldErrors.value.name = '填写 1–100 个字符';
  if (model.maxOutputTokens > model.contextWindow) fieldErrors.value.maxOutputTokens = '最大输出不能超过上下文窗口';
  for (const [field, value, max] of [
    ['temperature', temperature, 2], ['topP', topP, 1], ['inputPrice', inputPrice, 100000], ['outputPrice', outputPrice, 100000]
  ] as const) {
    if (value && (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > max)) {
      fieldErrors.value[field] = '填写 0–' + max + ' 之间的数字';
    }
  }
  if (Object.keys(fieldErrors.value).length) return;
  const parameters:Record<string,number>={},cost:Record<string,string|number>={currency};
  if(temperature)parameters.temperature=Number(temperature);
  if(topP)parameters.top_p=Number(topP);
  if(inputPrice)cost.inputPerMillion=Number(inputPrice);
  if(outputPrice)cost.outputPerMillion=Number(outputPrice);
  saving.value=true;
  try{
    await modelApi.saveModel(editing.value,{...model,defaultParameters:parameters,costConfig:cost});
    closeEditor.markSaved();
    dialog.value=false;
    ElMessage.success('模型已保存');
    accessRevision.value++;
    await load();
  }catch (err) {
    const code = await extractErrorMessage(err);
    if (code === 'ModelVersionConflict') saveError.value = '模型已被其他操作更新。请关闭编辑后重新打开最新版本。';
    else if (code === 'ProviderNotFound') fieldErrors.value.providerId = '服务商已不存在，请重新选择';
    else saveError.value = '模型保存失败，请检查配置后重试。';
  }finally{
    saving.value=false;
  }
}
const grantScopes = { USER: '员工', DEPARTMENT: '部门', ROLE: '角色', ALL: '全体员工' } as const;
type GrantSubject = keyof typeof grantScopes;
type Option = { id: string; name: string };
type DepartmentOption = Option & { parentId: string; children: DepartmentOption[] };
const grantDialog = ref(false), grantModel = ref<ModelRow>();
const grantLoading = ref(false), grantSaving = ref(false), grants = ref<GrantRow[]>([]);
const grantError = ref(''), grantResult = ref(''), grantMutationError = ref('');
const subjectType = ref<GrantSubject>('USER'), subjectId = ref(''), targetQuery = ref('');
const targets = ref<Option[]>([]), targetError = ref(''), searching = ref(false);
const pickedSubject = ref<Option>();
const departmentOptions = ref<DepartmentOption[]>([]);
const departmentNames = ref(new Map<string, string>());
const affectedEmployee = ref<Option>();
let grantRequest: AbortController | undefined;
let targetRequest: AbortController | undefined;
const subjectName = computed(() => {
  if (subjectType.value === 'ALL') return grantScopes.ALL;
  if (subjectType.value === 'DEPARTMENT') return departmentNames.value.get(subjectId.value);
  return pickedSubject.value?.id === subjectId.value ? pickedSubject.value?.name : undefined;
});

function resetTarget() {
  targetRequest?.abort();
  subjectId.value = '';
  pickedSubject.value = undefined;
  targetQuery.value = '';
  targets.value = [];
  targetError.value = '';
  searching.value = false;
}

function openGrants(row: ModelRow) {
  resetTarget();
  subjectType.value = 'USER';
  affectedEmployee.value = undefined;
  grantModel.value = row;
  grantResult.value = '';
  grantMutationError.value = '';
  grantDialog.value = true;
  void loadGrants();
}

async function loadGrants() {
  grantRequest?.abort();
  grants.value = [];
  grantError.value = '';
  const model = grantModel.value;
  if (!model || !grantDialog.value) return;
  const current = new AbortController();
  grantRequest = current;
  grantLoading.value = true;
  try {
    const { data } = await modelApi.grants(model.id, current.signal);
    if (!current.signal.aborted) grants.value = data;
  } catch {
    if (!current.signal.aborted) grantError.value = '授权列表读取失败';
  } finally {
    if (!current.signal.aborted) grantLoading.value = false;
  }
}

async function changeTargetType() {
  resetTarget();
  if (subjectType.value !== 'DEPARTMENT') return;
  departmentOptions.value = [];
  departmentNames.value = new Map();
  const current = new AbortController();
  targetRequest = current;
  try {
    const { data } = await request({ url: '/system/dept/list', signal: current.signal });
    if (current.signal.aborted) return;
    const departments = new Map<string, DepartmentOption>();
    for (const item of data) {
      const id = String(item.deptId);
      departments.set(id, { id, parentId: String(item.parentId), name: item.deptName, children: [] });
    }
    const roots: DepartmentOption[] = [];
    for (const item of departments.values()) {
      const parent = departments.get(item.parentId);
      if (parent) parent.children.push(item);
      else roots.push(item);
    }
    departmentOptions.value = roots;
    departmentNames.value = new Map([...departments].map(([id, department]) => [id, department.name]));
  } catch {
    if (!current.signal.aborted) targetError.value = '部门加载失败，请重新选择授权范围';
  }
}

function rememberSubject(id: string) {
  pickedSubject.value = targets.value.find(item => item.id === id);
}

async function searchTargets(input: string) {
  targetRequest?.abort();
  const query = input.trim();
  targetQuery.value = query;
  targetError.value = '';
  targets.value = [];
  searching.value = Boolean(query);
  if (!query) return;
  const current = new AbortController();
  targetRequest = current;
  try {
    if (subjectType.value === 'USER') {
      const employees = await searchModelEmployees(query, current.signal, true);
      if (!current.signal.aborted) targets.value = employees;
    } else {
      const response = await request({ url: '/system/role/list', params: { pageNum: 1, pageSize: 30, roleName: query, status: '0' }, signal: current.signal });
      if (!current.signal.aborted) targets.value = (response.rows ?? response.data?.rows ?? []).map((role: {roleId: string; roleName: string; roleKey: string}) =>
        ({ id: String(role.roleId), name: role.roleName + ' · ' + role.roleKey }));
    }
  } catch {
    if (!current.signal.aborted) targetError.value = '对象查询失败，请重新输入关键词';
  } finally {
    if (!current.signal.aborted) searching.value = false;
  }
}

async function grant() {
  const model = grantModel.value;
  if (!model || !subjectName.value || grantSaving.value) return;
  const type = subjectType.value;
  const id = type === 'ALL' ? '0' : subjectId.value;
  const name = subjectName.value;
  grantSaving.value = true;
  grantResult.value = '';
  grantMutationError.value = '';
  try {
    await modelApi.grant(model.id, { subjectType: type, subjectId: id });
    grantResult.value = '授权已保存 · ' + name;
    if (type === 'USER') affectedEmployee.value = { id, name };
    accessRevision.value++;
    resetTarget();
    void loadGrants();
  } catch (err) {
    grantMutationError.value = (await extractErrorMessage(err)) === 'GrantSubjectUnavailable'
      ? '该授权对象已不可用，请重新选择。' : '授权保存失败，请重试。';
  } finally {
    grantSaving.value = false;
  }
}

async function revoke(row: GrantRow) {
  const model = grantModel.value;
  if (!model || grantSaving.value) return;
  const name = row.name || row.subject_id;
  try {
    await ElMessageBox.confirm('撤销「' + model.name + '」给「' + name + '」的此条授权？撤销会取消该模型的在途任务。',
      '撤销模型授权', { type: 'warning', confirmButtonText: '撤销授权', cancelButtonText: '取消' });
  } catch {
    return;
  }
  if (!grantDialog.value || grantModel.value?.id !== model.id || grantSaving.value) return;
  grantSaving.value = true;
  grantResult.value = '';
  grantMutationError.value = '';
  try {
    await modelApi.revoke(model.id, row.id);
    grantResult.value = '授权已撤销 · ' + name;
    if (row.subject_type === 'USER') affectedEmployee.value = { id: row.subject_id, name };
    accessRevision.value++;
    void loadGrants();
  } catch {
    grantMutationError.value = '撤销授权失败，请重试。';
  } finally {
    grantSaving.value = false;
  }
}

const testModel = ref<ModelRow>(), testDialog = ref(false), testsLoading = ref(false);
const testingModels = reactive(new Set<string>());
const testing = computed(() => Boolean(testModel.value && testingModels.has(testModel.value.id)));
const tests = ref<TestRow[]>([]), testError = ref(''), testLoadError = ref('');
let testsRequest: AbortController | undefined;
const testBlockReason = computed(() => {
  if (!testModel.value?.enabled) return '模型已停用，启用后可验证连接。';
  if (!testModel.value.provider_enabled) return '服务商已停用，启用后可验证连接。';
  return '';
});

function openTests(row: ModelRow) {
  testModel.value = row;
  testError.value = '';
  testDialog.value = true;
  void loadTests();
}

async function loadTests() {
  testsRequest?.abort();
  tests.value = [];
  testLoadError.value = '';
  const model = testModel.value;
  if (!model || !testDialog.value) return;
  const current = new AbortController();
  testsRequest = current;
  testsLoading.value = true;
  try {
    const { data } = await modelApi.tests(model.id, current.signal);
    if (!current.signal.aborted) tests.value = data;
  } catch {
    if (!current.signal.aborted) testLoadError.value = '验证记录读取失败';
  } finally {
    if (!current.signal.aborted) testsLoading.value = false;
  }
}

async function runTest() {
  const model = testModel.value;
  if (!model || testing.value || testBlockReason.value) return;
  testingModels.add(model.id);
  testError.value = '';
  try {
    const { data } = await modelApi.test(model.id);
    if (testDialog.value && testModel.value?.id === model.id) {
      if (data.status === 'PASS') ElMessage.success('连接验证通过');
      else testError.value = '连接验证失败。请核对服务商配置与实际 Model ID。';
      void loadTests();
    }
    await load();
  } catch {
    if (testDialog.value && testModel.value?.id === model.id) testError.value = '无法完成连接验证，请确认模型和服务商仍处于启用状态后重试。';
  } finally {
    testingModels.delete(model.id);
  }
}

function canSetDefault(row: ModelRow) {
  return row.enabled && row.provider_enabled && row.streaming && row.tools;
}

async function setDefault(row: ModelRow) {
  try {
    await ElMessageBox.confirm('将「' + row.name + '」设为企业默认模型？具备员工角色的成员将自动继承此模型。', '设置企业默认模型', {
      confirmButtonText: '设为默认', cancelButtonText: '取消'
    });
  } catch {
    return;
  }
  try {
    const { data } = await request({ url: '/ai/admin/office-defaults' });
    await request({ url: '/ai/admin/office-defaults', method: 'put', data: { modelId: row.id, expectedVersion: data.version } });
    accessRevision.value++;
    ElMessage.success('已设为企业默认模型');
    await loadOfficeDefault();
  } catch {
    ElMessage.error('设置失败，请确认模型和服务商已启用、支持流式输出及工具调用，或刷新后重试。');
  }
}

watch(grantDialog, visible => {
  if (!visible) {
    grantRequest?.abort();
    resetTarget();
  }
});
watch(testDialog, visible => { if (!visible) testsRequest?.abort(); });
onBeforeUnmount(() => {
  grantRequest?.abort();
  targetRequest?.abort();
  testsRequest?.abort();
  ++defaultGeneration;
  ++listGeneration;
});
onMounted(load);
</script>
<style scoped>.default-status{display:flex;align-items:center;gap:12px;margin-bottom:12px;color:var(--el-text-color-secondary)}.model-name{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.model-name span{overflow-wrap:anywhere}.editor-footer{display:flex;flex-direction:column;gap:12px}.editor-footer :deep(.el-alert){text-align:left}.editor-actions{display:flex;justify-content:flex-end}.heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:24px}.heading h2{margin:0}.heading-actions,.status-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px}.grant-feedback{margin-bottom:12px}.paging{display:flex;align-items:center;justify-content:flex-end;gap:14px;margin-top:20px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.grant-form{margin:20px 0}.el-select{width:100%}</style>
