<template>
  <section class="employee-access" aria-label="员工模型权限">
    <el-form label-position="top" @submit.prevent>
      <el-form-item label="查询员工">
        <el-select v-model="employeeId" filterable remote clearable aria-label="查询员工"
          :remote-method="search" :loading="searching" @change="rememberEmployee" placeholder="按姓名或账号搜索">
          <el-option v-for="option in employeeOptions" :key="option.id" :label="option.name" :value="option.id" />
          <template #empty>
            <div class="p-3">{{ searchError || (query ? '未找到匹配员工' : '请输入姓名或账号') }}</div>
          </template>
        </el-select>
      </el-form-item>
    </el-form>
    <template v-if="employeeId">
      <div v-if="loading" role="status">正在读取员工模型权限…</div>
      <div v-else-if="error" class="employee-actions" role="alert">
        <span>{{ error }}</span>
        <el-button link type="primary" @click="load">重试</el-button>
      </div>
      <template v-else>
        <el-table :data="models" row-key="id" :empty-text="modelId ? '该模型或员工已不可查询' : '没有可查询的模型'">
          <el-table-column v-if="!modelId" label="模型" min-width="160">
            <template #default="{ row }">
              <div>{{ row.name }}</div>
              <small class="model-code">{{ row.code }}</small>
            </template>
          </el-table-column>
          <el-table-column label="桌面会话可用状态" min-width="150">
            <template #default="{ row }: { row: EmployeeModelRow }">
              <el-tag :type="row.status === 'AVAILABLE' ? 'success' : 'info'">{{ statusLabels[row.status] }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="匹配的授权来源" min-width="200">
            <template #default="{ row }: { row: EmployeeModelRow }">
              <div v-if="row.sources.length" class="employee-sources">
                <el-tag v-for="source in row.sources" :key="source.type + (source.label ?? '')" effect="plain" size="small">
                  {{ sourceLabels[source.type] ?? source.type }}{{ source.label ? ' · ' + source.label : '' }}
                </el-tag>
              </div>
              <span v-else>—</span>
            </template>
          </el-table-column>
        </el-table>
        <div class="employee-actions">
          <el-button link type="primary" @click="load">刷新状态</el-button>
          <template v-if="!modelId && (page > 1 || hasMore)">
            <el-button :disabled="page === 1" @click="page--">上一页</el-button>
            <span>第 {{ page }} 页</span>
            <el-button :disabled="!hasMore" @click="page++">下一页</el-button>
          </template>
        </div>
      </template>
    </template>
  </section>
</template>

<script setup lang="ts">
import { modelApi, searchModelEmployees, type EmployeeModelRow, type EmployeeModelStatus } from '@/features/workspace/models';

type EmployeeOption = { id: string; name: string };
const props = defineProps<{ modelId?: string; revision?: number; affectedEmployee?: EmployeeOption }>();
const employeeId = ref('');
const employees = ref<EmployeeOption[]>([]);
const pinnedEmployee = ref<EmployeeOption>();
const employeeOptions = computed(() => pinnedEmployee.value && !query.value && !employees.value.some(item => item.id === pinnedEmployee.value?.id)
  ? [pinnedEmployee.value, ...employees.value] : employees.value);
const models = ref<EmployeeModelRow[]>([]);
const page = ref(1);
const hasMore = ref(false);
const loading = ref(false);
const error = ref('');
const query = ref('');
const searching = ref(false);
const searchError = ref('');
let searchRequest: AbortController | undefined;
let accessRequest: AbortController | undefined;

const statusLabels: Record<EmployeeModelStatus, string> = {
  AVAILABLE: '可用',
  MODEL_DISABLED: '模型已停用',
  PROVIDER_DISABLED: '服务商已停用',
  NO_GRANT: '缺少有效授权',
  EMPLOYEE_INACTIVE: '账号未启用',
  PASSWORD_CHANGE_REQUIRED: '员工须先修改密码',
  EMPLOYEE_PERMISSION_REQUIRED: '缺少模型或会话权限',
  STREAMING_REQUIRED: '会话要求支持流式输出',
  OUTSIDE_CATALOG: '超出会话模型列表 100 项上限'
};
const sourceLabels: Record<string, string> = {
  ORGANIZATION_DEFAULT: '企业默认',
  USER: '个人授权',
  DEPARTMENT: '部门授权',
  ROLE: '角色授权',
  ALL: '全体授权',
  LINKED_USER: '共享依赖 · 个人',
  LINKED_DEPARTMENT: '共享依赖 · 部门',
  LINKED_ROLE: '共享依赖 · 角色',
  LINKED_ALL: '共享依赖 · 全体'
};

function rememberEmployee(id: string) {
  pinnedEmployee.value = employeeOptions.value.find(employee => employee.id === id);
  query.value = '';
}

async function search(input: string) {
  searchRequest?.abort();
  query.value = input.trim();
  searchError.value = '';
  employees.value = [];
  searching.value = Boolean(query.value);
  if (!query.value) return;
  const current = new AbortController();
  searchRequest = current;
  try {
    const matches = await searchModelEmployees(query.value, current.signal);
    if (!current.signal.aborted) employees.value = matches;
  } catch {
    if (!current.signal.aborted) searchError.value = '员工查询失败，请重新输入关键词';
  } finally {
    if (!current.signal.aborted) searching.value = false;
  }
}

async function load() {
  accessRequest?.abort();
  models.value = [];
  hasMore.value = false;
  error.value = '';
  loading.value = Boolean(employeeId.value);
  if (!employeeId.value) return;
  const current = new AbortController();
  accessRequest = current;
  try {
    const { data } = await modelApi.employeeModels(employeeId.value, props.modelId, page.value, current.signal);
    if (current.signal.aborted) return;
    models.value = data.items;
    hasMore.value = data.hasMore;
  } catch {
    if (!current.signal.aborted) error.value = '员工模型权限读取失败';
  } finally {
    if (!current.signal.aborted) loading.value = false;
  }
}

watch(() => props.affectedEmployee, employee => {
  if (employee && !employeeId.value) {
    pinnedEmployee.value = employee;
    employeeId.value = employee.id;
  }
});
watch([employeeId, () => props.modelId], () => {
  page.value = 1;
}, { flush: 'sync' });
watch([employeeId, () => props.modelId, () => props.revision, page], load);
onBeforeUnmount(() => {
  searchRequest?.abort();
  accessRequest?.abort();
});
</script>

<style scoped>
.employee-access .el-select { width: 100%; }
.employee-sources, .employee-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.employee-actions { margin-top: 10px; }
.model-code { color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
</style>
