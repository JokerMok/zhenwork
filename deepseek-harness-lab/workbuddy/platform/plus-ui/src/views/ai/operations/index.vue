<template>
  <div class="app-container p-4">
    <header class="operations-heading">
      <h1>运行管理</h1>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </header>
    <p>运行与审批仅展示元数据。员工在自己的会话中查看内容并作出审批决定。</p>
    <el-radio-group aria-label="运行记录分类" v-model="category" @change="reset">
      <el-radio-button value="runs">执行任务</el-radio-button>
      <el-radio-button value="sessions">会话</el-radio-button>
      <el-radio-button value="approvals">审批</el-radio-button>
      <el-radio-button value="health">运行环境与服务</el-radio-button>
    </el-radio-group>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="category === 'health' && !error">
      <el-descriptions v-loading="loading" :column="3" border>
        <el-descriptions-item label="数据库">
          {{ health.database ? workspaceLabel(health.database) : loading ? '正在检查' : '未采集' }}
        </el-descriptions-item>
        <el-descriptions-item label="执行服务">
          {{ health.execution ? workspaceLabel(health.execution) : loading ? '正在检查' : '未采集' }}
        </el-descriptions-item>
        <el-descriptions-item label="Gateway">
          {{ health.gateway ? workspaceLabel(health.gateway) : '未知' }}
        </el-descriptions-item>
      </el-descriptions>
      <p>检查时间：{{ health.checkedAt || '—' }}；Runtime 列表表示当前 Manager 管理的实例。</p>
    </template>
    <WorkspaceRecordTable
      v-if="!error"
      v-loading="loading"
      :empty-text="loading ? '正在读取记录' : '当前没有记录'"
      :rows="rows"
      :columns="columns"
      :labels="labels"
    />
    <div v-if="category !== 'health' && !error" aria-label="运行记录分页" class="operations-pager">
      <el-button
        :disabled="page === 1 || loading"
        @click="
          page--;
          load();
        "
      >
        上一页
      </el-button>
      <span>第 {{ page }} 页</span>
      <el-button
        :disabled="rows.length < 30 || loading"
        @click="
          page++;
          load();
        "
      >
        下一页
      </el-button>
    </div>
  </div>
</template>
<script setup lang="ts">
import WorkspaceRecordTable from '@/components/WorkspaceRecordTable/index.vue';
import request from '@/utils/request';
import { workspaceLabel } from '@/utils/workspacePresentation';
const category = ref('runs'),
  page = ref(1),
  loading = ref(false),
  error = ref(''),
  rows = ref<Record<string, unknown>[]>([]),
  health = ref<Record<string, unknown>>({});
let generation = 0;
const labels: Record<string, string> = {
  id: 'ID',
  session_id: '会话 ID',
  run_id: '任务 ID',
  owner_user_id: '员工 ID',
  resource_id: '资源 ID',
  model_id: '模型 ID',
  status: '状态',
  error_code: '错误类别',
  created_at: '创建时间',
  finished_at: '结束时间',
  updated_at: '更新时间',
  deleted_at: '删除时间',
  runtime_initialized: 'Runtime 已初始化',
  expires_at: '审批到期时间',
  decided_at: '决定时间',
  ownerUserId: '员工 ID',
  instanceId: '实例 ID',
  state: '状态',
  lastActive: '最近活动'
};
const columns = computed(() => (rows.value.length ? Object.keys(rows.value[0]) : ['id', 'status']));
async function load() {
  const g = ++generation;
  loading.value = true;
  error.value = '';
  rows.value = [];
  health.value = {};
  try {
    const result = await request({
      url: category.value === 'health' ? '/ai/admin/health' : '/ai/admin/operations',
      params: category.value === 'health' ? {} : { category: category.value, page: page.value }
    });
    if (g === generation) {
      if (category.value === 'health') {
        health.value = result.data;
        rows.value = result.data.runtimes || [];
      } else rows.value = result.data;
    }
  } catch {
    if (g === generation) error.value = '读取失败，请重试。';
  } finally {
    if (g === generation) loading.value = false;
  }
}
function reset() {
  page.value = 1;
  void load();
}
onMounted(load);
</script>
<style scoped>
.operations-heading,
.operations-pager {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.operations-heading {
  justify-content: space-between;
}
.operations-heading h1 {
  font-size: 24px;
  margin: 0;
}
.operations-pager {
  margin-top: 16px;
}
</style>
