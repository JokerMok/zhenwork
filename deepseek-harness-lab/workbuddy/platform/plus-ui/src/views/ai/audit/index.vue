<template>
  <div class="app-container p-4">
    <header class="audit-heading">
      <h1>AI 审计与用量</h1>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>
    <div class="audit-controls">
      <el-select v-model="category" aria-label="审计分类" class="audit-category" @change="reset">
        <el-option v-for="[value, label] in categories" :key="value" :label="label" :value="value" />
      </el-select>
      <el-form v-if="category === 'core-usage'" class="audit-filters" @submit.prevent="reset">
        <el-input aria-label="员工 ID" clearable v-model="filterUser" placeholder="员工 ID" />
        <el-input aria-label="模型 ID" clearable v-model="filterModel" placeholder="模型 ID" />
        <el-input aria-label="任务或会话 ID" clearable v-model="filterTask" placeholder="任务 / 会话 ID" />
        <el-button type="primary" native-type="submit">查询</el-button>
        <el-button
          v-if="filterUser || filterModel || filterTask || applied.userId || applied.modelId || applied.conversationId"
          @click="clearFilters"
        >
          清空筛选
        </el-button>
      </el-form>
      <label v-if="category === 'usage'">
        近
        <el-input-number aria-label="统计天数" v-model="days" :min="1" :max="90" :precision="0" @change="load" />
        天
      </label>
    </div>
    <p v-if="['usage', 'calls', 'core-usage'].includes(category)" class="audit-note">
      Token 取自供应商回执。费用按调用时费率估算，不同币种分别统计，未采集的费用不计入合计。
    </p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <WorkspaceRecordTable
      v-else
      v-loading="loading"
      :rows="rows"
      :columns="columns"
      :labels="labels"
      :empty-text="
        loading
          ? '正在读取记录'
          : category === 'core-usage' && (applied.userId || applied.modelId || applied.conversationId)
            ? '没有符合筛选条件的记录'
            : '当前没有记录'
      "
    />
    <nav v-if="category !== 'usage' && !error" aria-label="记录分页" class="audit-pager">
      <el-button
        :disabled="page === 1 || loading"
        @click="
          page--;
          load();
        "
      >
        上一页
      </el-button>
      <span aria-live="polite">第 {{ page }} 页</span>
      <el-button
        :disabled="rows.length < 30 || loading"
        @click="
          page++;
          load();
        "
      >
        下一页
      </el-button>
    </nav>
  </div>
</template>
<script setup lang="ts">
import WorkspaceRecordTable from '@/components/WorkspaceRecordTable/index.vue';
import request from '@/utils/request';
const categories = [
  ['core-usage', '员工 / 模型 / 任务用量'],
  ['calls', '模型 / MCP 调用'],
  ['tools', '工具 / 审批'],
  ['knowledge', '知识访问'],
  ['files', '文件访问'],
  ['security', '安全与资源操作'],
  ['usage', '用量汇总'],
  ['legacy-usage', '迁移用量'],
  ['legacy-audit', '迁移审计']
];
const category = ref('core-usage'),
  rows = ref<Record<string, unknown>[]>([]),
  page = ref(1),
  days = ref(30),
  loading = ref(false),
  error = ref('');
const filterUser = ref(''),
  filterModel = ref(''),
  filterTask = ref('');
let generation = 0;
const applied = ref<{ userId?: string; modelId?: string; conversationId?: string }>({});
const labels: Record<string, string> = {
  conversation_id: '任务 / 会话 ID',
  call_id: '调用 ID',
  cost_status: '费用状态',
  sequence: '原序号',
  result: '原结果',
  request_id: '原请求 ID',
  prev_hash: '前序哈希',
  hash: '原签名',
  model_code: '模型代码',
  usage_reported: '供应商已报告用量',
  id: '记录 ID',
  run_id: '任务 ID',
  owner_user_id: '员工 ID',
  actor_user_id: '操作者 ID',
  kind: '调用类型',
  resource_id: '资源 ID',
  model_id: '模型 ID',
  provider_id: 'Provider ID',
  status: '状态',
  input_tokens: '输入 Token',
  output_tokens: '输出 Token',
  estimated_cost: '估算费用',
  currency: '币种',
  duration_ms: '总耗时 ms',
  provider_ttfb_ms: '供应商 TTFB ms',
  first_token_ms: '模型首 Token ms',
  http_status: 'HTTP 状态',
  created_at: '创建时间',
  finished_at: '结束时间',
  action: '操作',
  day: '日期',
  calls: '调用次数',
  incomplete_calls: '回执未完成',
  unknown_token_calls: '用量未知次数',
  unknown_cost_calls: '费用未知次数',
  known_input_tokens: '已知输入 Token',
  known_output_tokens: '已知输出 Token',
  known_estimated_cost: '已知估算费用合计'
};
const columns = computed(() =>
  category.value === 'calls'
    ? [
        'created_at',
        'kind',
        'status',
        'input_tokens',
        'output_tokens',
        'duration_ms',
        'estimated_cost',
        'currency',
        'provider_ttfb_ms',
        'first_token_ms',
        'http_status',
        'owner_user_id',
        'run_id',
        'id',
        'resource_id',
        'model_id',
        'provider_id',
        'finished_at'
      ]
    : rows.value.length
      ? Object.keys(rows.value[0])
      : ['id', 'status', 'created_at']
);
async function load() {
  const g = ++generation;
  loading.value = true;
  error.value = '';
  rows.value = [];
  try {
    const result = await request({
      url:
        category.value === 'usage'
          ? '/ai/admin/usage'
          : category.value === 'core-usage'
            ? '/ai/admin/core-usage'
            : '/ai/admin/audit',
      params:
        category.value === 'usage'
          ? { days: days.value }
          : category.value === 'core-usage'
            ? { page: page.value, ...applied.value }
            : { category: category.value, page: page.value }
    });
    if (g === generation) rows.value = result.data;
  } catch {
    if (g === generation) error.value = '读取失败，请重试。';
  } finally {
    if (g === generation) loading.value = false;
  }
}
function clearFilters() {
  filterUser.value = '';
  filterModel.value = '';
  filterTask.value = '';
  reset();
}
function reset() {
  applied.value = {
    userId: filterUser.value.trim() || undefined,
    modelId: filterModel.value.trim() || undefined,
    conversationId: filterTask.value.trim() || undefined
  };
  page.value = 1;
  void load();
}
onMounted(load);
</script>
<style scoped>
.audit-heading,
.audit-controls,
.audit-filters,
.audit-pager {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.audit-heading {
  justify-content: space-between;
  margin-bottom: 16px;
}
.audit-heading h1 {
  font-size: 24px;
  margin: 0;
}
.audit-category {
  width: 220px;
  max-width: 100%;
}
.audit-filters .el-input {
  width: 165px;
  max-width: 100%;
}
.audit-note {
  color: var(--el-text-color-secondary);
  font-size: 14px;
  line-height: 1.6;
}
.audit-pager {
  margin-top: 16px;
}
</style>
