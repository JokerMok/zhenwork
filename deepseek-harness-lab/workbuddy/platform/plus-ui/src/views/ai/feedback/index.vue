<template>
  <div class="app-container p-4">
    <div class="toolbar">
      <h2>反馈与 Badcase</h2>
      <div class="filters">
        <el-select v-model="status" clearable placeholder="处理状态" @change="reset">
          <el-option v-for="value in statuses" :key="value" :label="label(value)" :value="value" />
        </el-select>
        <el-select v-model="category" clearable placeholder="反馈分类" @change="reset">
          <el-option v-for="value in categories" :key="value" :label="label(value)" :value="value" />
        </el-select>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <el-table v-loading="loading" :data="rows" empty-text="当前没有反馈记录">
      <el-table-column prop="created_at" label="提交时间" min-width="170" />
      <el-table-column prop="owner_user_id" label="员工 ID" min-width="110" />
      <el-table-column label="任务 / 会话" min-width="180">
        <template #default="{ row }">
          <el-link :href="row.conversation_path" target="_blank" rel="noopener noreferrer" type="primary">
            {{ row.task_id }}
          </el-link>
        </template>
      </el-table-column>
      <el-table-column label="分类" min-width="120"><template #default="{ row }">{{ label(row.category) }}</template></el-table-column>
      <el-table-column label="状态" min-width="110"><template #default="{ row }"><el-tag>{{ label(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="任务结果" min-width="100"><template #default="{ row }">{{ taskState(row.actual_task_state) }}</template></el-table-column>
      <el-table-column label="执行版本" min-width="180">
        <template #default="{ row }">
          {{ row.assistant_version == null ? '未知' : `助手 v${row.assistant_version}` }} ·
          {{ row.model_version == null ? '模型未知' : `模型 v${row.model_version}` }}
        </template>
      </el-table-column>
      <el-table-column label="操作" width="90" fixed="right">
        <template #default="{ row }"><el-button link type="primary" @click="open(row.id)">处理</el-button></template>
      </el-table-column>
    </el-table>
    <div class="paging">
      <el-button :disabled="page === 1 || loading" @click="page--; load()">上一页</el-button>
      <span>第 {{ page }} 页</span>
      <el-button :disabled="rows.length < 30 || loading" @click="page++; load()">下一页</el-button>
    </div>

    <el-dialog v-model="dialog" title="反馈处理" width="920px" :close-on-click-modal="false">
      <el-skeleton v-if="detailLoading" :rows="8" animated />
      <template v-else-if="detail">
        <el-descriptions :column="2" border>
          <el-descriptions-item label="任务 / 会话">
            <el-link :href="detail.conversation_path" target="_blank" rel="noopener noreferrer" type="primary">
              {{ detail.task_id }}
            </el-link>
          </el-descriptions-item>
          <el-descriptions-item label="员工 ID">{{ detail.owner_user_id }}</el-descriptions-item>
          <el-descriptions-item label="反馈分类">{{ label(detail.category) }}</el-descriptions-item>
          <el-descriptions-item label="员工说明">{{ detail.note || '未补充' }}</el-descriptions-item>
          <el-descriptions-item label="任务结果">{{ taskState(detail.actual_task_state) }}</el-descriptions-item>
          <el-descriptions-item label="实际工具">{{ values(detail.actual_tools) }}</el-descriptions-item>
          <el-descriptions-item label="成果版本">{{ values(detail.artifact_version_ids) }}</el-descriptions-item>
        </el-descriptions>

        <h3>执行版本</h3>
        <el-alert v-if="!detail.provenance" title="该历史任务没有执行时版本快照，相关版本保持未知。" type="info" :closable="false" />
        <el-descriptions v-else :column="2" border>
          <el-descriptions-item label="助手">{{ version(detail.provenance.assistant_id, detail.provenance.assistant_version) }}</el-descriptions-item>
          <el-descriptions-item label="模型">{{ version(detail.provenance.model_id, detail.provenance.model_version) }}</el-descriptions-item>
          <el-descriptions-item label="Provider">{{ version(detail.provenance.provider_id, detail.provenance.provider_version) }}</el-descriptions-item>
          <el-descriptions-item label="Skill">{{ versions(detail.provenance.skills) }}</el-descriptions-item>
          <el-descriptions-item label="MCP">{{ versions(detail.provenance.mcps) }}</el-descriptions-item>
          <el-descriptions-item label="工具">{{ versions(detail.provenance.tools) }}</el-descriptions-item>
        </el-descriptions>

        <el-form label-position="top" class="case-form">
          <el-form-item label="处理状态"><el-select v-model="form.status"><el-option v-for="value in statuses" :key="value" :label="label(value)" :value="value" /></el-select></el-form-item>
          <el-form-item label="Badcase 描述"><el-input v-model="form.badcaseDescription" type="textarea" :rows="2" maxlength="2000" show-word-limit /></el-form-item>
          <el-form-item label="人工确认原因"><el-input v-model="form.rootCause" type="textarea" :rows="2" maxlength="2000" show-word-limit /></el-form-item>
          <el-form-item label="原因证据引用"><el-input v-model="form.causeEvidence" maxlength="1000" placeholder="测试记录、工单或日志标识；不要粘贴敏感原文" /></el-form-item>
          <el-form-item label="预期结果"><el-input v-model="form.expectedResult" type="textarea" :rows="2" maxlength="2000" show-word-limit /></el-form-item>
          <el-form-item label="处理结果"><el-input v-model="form.resolution" type="textarea" :rows="2" maxlength="2000" show-word-limit /></el-form-item>
          <el-button type="primary" :loading="saving" @click="save">保存处理记录</el-button>
        </el-form>

        <h3>定向复核</h3>
        <el-table :data="detail.rechecks" empty-text="尚无定向复核记录">
          <el-table-column prop="checked_at" label="时间" min-width="170" />
          <el-table-column prop="check_description" label="检查项" min-width="170" />
          <el-table-column prop="actual_result" label="实际结果" min-width="200" />
          <el-table-column prop="evidence" label="证据" min-width="160" />
          <el-table-column label="结论" width="90"><template #default="{ row }">{{ label(row.result) }}</template></el-table-column>
        </el-table>
        <el-form v-if="detail.status === 'RESOLVED'" label-position="top" class="recheck-form">
          <el-form-item label="检查项"><el-input v-model="check.checkDescription" maxlength="500" /></el-form-item>
          <el-form-item label="预期"><el-input v-model="check.expectedResult" maxlength="1000" /></el-form-item>
          <el-form-item label="实际结果"><el-input v-model="check.actualResult" maxlength="1000" /></el-form-item>
          <el-form-item label="证据引用"><el-input v-model="check.evidence" maxlength="1000" /></el-form-item>
          <el-form-item label="结论"><el-radio-group v-model="check.result"><el-radio value="PASSED">通过</el-radio><el-radio value="FAILED">未通过</el-radio></el-radio-group></el-form-item>
          <el-button :loading="saving" :disabled="!checkReady" @click="addRecheck">记录复核</el-button>
        </el-form>
      </template>
      <template #footer>
        <el-button @click="dialog = false">关闭</el-button>
        <el-button v-if="detail?.status === 'RESOLVED'" type="primary" :disabled="!canClose" :loading="saving" @click="closeCase">复核通过并关闭</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import request from '@/utils/request';

type Row = Record<string, any>;
type VersionItem = { id?: string; version?: number; type?: string };
type Detail = Row & {
  provenance: null | {
    assistant_id?: string;
    assistant_version?: number;
    model_id?: string;
    model_version?: number;
    provider_id?: string;
    provider_version?: number;
    skills: VersionItem[];
    mcps: VersionItem[];
    tools: VersionItem[];
  };
  rechecks: Row[];
};

const statuses = ['NEW', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'];
const categories = ['correct', 'data_calculation', 'citation', 'tool', 'artifact', 'other'];
const labels: Record<string, string> = {
  NEW: '待处理', IN_PROGRESS: '处理中', RESOLVED: '待复核', CLOSED: '已关闭',
  PASSED: '通过', FAILED: '未通过', correct: '回答正确性', data_calculation: '数据计算',
  citation: '引用', tool: '工具', artifact: '成果文件', other: '其他',
};
const label = (value: unknown) => labels[String(value)] || String(value || '未知');
const taskState = (value: unknown) => ({ completed: '已完成', partial: '部分完成' }[String(value)] || '未知');
const values = (items?: unknown[]) => items?.length ? items.join('；') : '无';
const version = (id?: string, value?: number) => id && value != null ? `${id} · v${value}` : '未知';
const versions = (items?: VersionItem[]) => items?.length
  ? items.map(item => version(item.id, item.version)).join('；')
  : '无记录';

const rows = ref<Row[]>([]);
const page = ref(1);
const status = ref('');
const category = ref('');
const loading = ref(false);
const error = ref('');
const dialog = ref(false);
const detailLoading = ref(false);
const saving = ref(false);
const detail = ref<Detail>();
const form = reactive({ status: 'NEW', badcaseDescription: '', rootCause: '', causeEvidence: '', expectedResult: '', resolution: '' });
const check = reactive({ checkDescription: '', expectedResult: '', actualResult: '', evidence: '', result: 'PASSED' });
let generation = 0;

const checkReady = computed(() => Boolean(check.checkDescription.trim() && check.expectedResult.trim()
  && check.actualResult.trim() && check.evidence.trim() && check.result));
const canClose = computed(() => detail.value?.rechecks?.some(item =>
  item.result === 'PASSED' && item.resolution_revision === detail.value?.resolution_revision));

async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const result = await request({ url: '/ai/admin/feedback', params: {
      page: page.value, status: status.value || undefined, category: category.value || undefined,
    } });
    if (current === generation) rows.value = result.data;
  } catch {
    if (current === generation) error.value = '读取失败，请重试。';
  } finally {
    if (current === generation) loading.value = false;
  }
}

function reset() { page.value = 1; void load(); }

function setDetail(value: Detail) {
  detail.value = value;
  Object.assign(form, {
    status: value.status,
    badcaseDescription: value.badcase_description || '',
    rootCause: value.root_cause || '',
    causeEvidence: value.cause_evidence || '',
    expectedResult: value.expected_result || '',
    resolution: value.resolution || '',
  });
  Object.assign(check, { checkDescription: '', expectedResult: '', actualResult: '', evidence: '', result: 'PASSED' });
}

async function open(id: string) {
  dialog.value = true;
  detailLoading.value = true;
  try {
    const result = await request({ url: `/ai/admin/feedback/${id}` });
    setDetail(result.data);
  } catch {
    ElMessage.error('反馈详情加载失败');
    dialog.value = false;
  } finally {
    detailLoading.value = false;
  }
}

async function save() {
  if (!detail.value || saving.value) return;
  saving.value = true;
  try {
    const result = await request({ url: `/ai/admin/feedback/${detail.value.id}`, method: 'patch', data: {
      ...form, expectedVersion: detail.value.record_version,
    } });
    setDetail(result.data);
    ElMessage.success('处理记录已保存');
    await load();
  } catch {
    ElMessage.error('保存失败，请检查状态顺序和必填记录');
  } finally {
    saving.value = false;
  }
}

async function addRecheck() {
  if (!detail.value || !checkReady.value || saving.value) return;
  saving.value = true;
  try {
    const result = await request({ url: `/ai/admin/feedback/${detail.value.id}/rechecks`, method: 'post', data: check });
    setDetail(result.data);
    ElMessage.success('定向复核已记录');
  } catch {
    ElMessage.error('复核记录失败');
  } finally {
    saving.value = false;
  }
}

async function closeCase() {
  if (!detail.value || !canClose.value) return;
  form.status = 'CLOSED';
  await save();
}

onMounted(load);
</script>

<style scoped>
.toolbar,.filters,.paging{display:flex;align-items:center;gap:12px}.toolbar{justify-content:space-between;margin-bottom:18px}.toolbar h2{margin:0}.filters .el-select{width:150px}.paging{justify-content:flex-end;margin-top:18px}.case-form,.recheck-form{margin-top:18px}.recheck-form{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}.recheck-form .el-button{justify-self:start}h3{margin:22px 0 12px}
</style>
