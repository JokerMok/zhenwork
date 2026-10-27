<template>
  <el-dialog
    :model-value="modelValue"
    :title="'共享：' + (resource?.name || '')"
    width="760px"
    align-center
    append-to-body
    :close-on-click-modal="false"
    :before-close="close"
    class="resource-share-dialog"
    @opened="targetSelect?.focus()"
  >
    <div class="resource-line">
      <span>
        {{ types[resource?.resourceType || ''] || resource?.resourceType }} ·
        {{ resource?.publishedVersion ? 'v' + resource.publishedVersion : '未激活' }}
      </span>
      <el-tag :type="resource?.enabled === false ? 'info' : 'success'">
        {{ resource?.enabled === false ? '已停用' : '已激活' }}
      </el-tag>
      <el-tooltip content="使用组织资源引用，凭据保留在服务端。部门按直接归属、角色按有效成员生效；不包含子部门。依赖变更后重新校验授权。">
        <el-button link>授权说明</el-button>
      </el-tooltip>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-4" />
    <el-form label-position="top" :disabled="saving" @submit.prevent="submit">
      <el-form-item label="共享给" required :error="searchError">
        <div class="target-search">
          <el-select v-model="filter" aria-label="对象类型筛选" class="target-filter" @change="changeFilter">
            <el-option label="全部类型" value="ALL" />
            <el-option label="员工" value="USER" />
            <el-option label="部门" value="DEPARTMENT" />
            <el-option label="角色" value="ROLE" />
          </el-select>
          <el-select
            ref="targetSelect"
            v-model="selected"
            multiple
            filterable
            remote
            remote-show-suffix
            reserve-keyword
            :remote-method="searchTargets"
            :loading="searching"
            :multiple-limit="50"
            collapse-tags
            collapse-tags-tooltip
            :max-collapse-tags="4"
            placeholder="搜索姓名、账号、部门或角色"
            class="target-picker"
            @change="clearPlan"
          >
            <el-option
              v-for="target in options"
              :key="target.key"
              :label="subjectLabels[target.subjectType] + ' · ' + targetLabel(target)"
              :value="target.key"
            >
              <span>{{ subjectLabels[target.subjectType] }} · {{ targetLabel(target) }}</span>
            </el-option>
            <template #empty>
              <div class="selection-empty">{{ searching ? '正在搜索…' : searchError || searchHint }}</div>
            </template>
          </el-select>
        </div>
        <el-button v-if="searchError" link @mousedown.prevent @click="searchTargets(lastQuery)">重试搜索</el-button>
      </el-form-item>
      <el-form-item label="权限">
        <el-checkbox v-model="allowUse" @change="clearPlan">允许使用</el-checkbox>
        <span class="field-help">包含查看</span>
      </el-form-item>
      <el-collapse v-model="panels">
        <el-collapse-item title="高级权限" name="advanced">
          <el-checkbox v-model="allowEdit" @change="clearPlan">编辑草稿</el-checkbox>
          <div class="field-help">编辑不包含发布、转授或凭据访问。</div>
        </el-collapse-item>
      </el-collapse>
    </el-form>
    <el-alert
      v-if="plan?.issues.length"
      title="暂时无法共享，尚未增加任何授权"
      type="warning"
      :closable="false"
      class="mt-4"
    >
      <ul>
        <li v-for="(issue, i) in plan.issues" :key="i">{{ issueText(issue) }}</li>
      </ul>
      <span>请由资源所有者处理停用、连接验证或转授权限后重试。</span>
    </el-alert>
    <div v-if="plan?.ready && sensitive.length" class="dependency-confirm">
      <h4>需要追加的权限</h4>
      <p class="field-help">
        当前连接权限不能仅限于本专家。以下最小授权将与专家共享一同保存；不复制凭据，不开放任意数据源。
      </p>
      <div v-for="grant in sensitive" :key="grant.subjectType + grant.subjectId + grant.key" class="dependency-row">
        <strong>{{ grant.subjectName }} → {{ grant.name }}</strong>
        <div>{{ grant.scope }}</div>
      </div>
      <el-checkbox v-model="confirmSensitive">我有权授予以上范围，并确认追加授权</el-checkbox>
    </div>
    <div v-if="plan?.ready && automatic.length" class="field-help mt-3">
      将自动补齐：{{ [...new Set(automatic.map(g => g.name))].join('、') }}（仅查看和使用）。
    </div>
    <el-collapse v-model="panels" class="mt-4">
      <el-collapse-item :title="'已有共享（' + shares.filter(s => s.status === 'ACTIVE').length + '）'" name="existing">
        <el-input v-model="shareQuery" placeholder="搜索已有共享" clearable aria-label="搜索已有共享" class="mb-3" />
        <el-alert v-if="listError" :title="listError" type="error" :closable="false">
          <el-button link @click="loadShares">重试</el-button>
        </el-alert>
        <el-table v-loading="loading" :data="visibleShares" max-height="260" empty-text="没有匹配的共享">
          <el-table-column label="对象" min-width="210" show-overflow-tooltip>
            <template #default="{ row }">
              {{ subjectLabels[row.subject_type] }} · {{ row.name || '对象已删除' }}
              <small class="object-context">
                {{ [row.username, row.department, row.roleKey].filter(Boolean).join(' · ') }}
                <span v-if="row.linked">· 来自：{{ row.sourceResourceName }}</span>
              </small>
            </template>
          </el-table-column>
          <el-table-column label="权限" min-width="110">
            <template #default="{ row }">
              {{ actions(row.actions).includes('USE') ? '允许使用' : '查看'
              }}{{ actions(row.actions).includes('EDIT') ? '、编辑草稿' : '' }}
            </template>
          </el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">
                {{ row.status === 'ACTIVE' ? '已授权' : '已撤回' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="120" fixed="right">
            <template #default="{ row }">
              <template v-if="row.status === 'ACTIVE' && (!row.linked || row.canManageSource)">
                <el-button v-if="!row.linked" link :disabled="saving" @click="edit(row)">调整</el-button>
                <el-button link type="danger" :disabled="saving" @click="revoke(row)">
                  {{ row.linked ? '撤回来源共享' : '撤回' }}
                </el-button>
              </template>
            </template>
          </el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>
    <template #footer>
      <div class="share-footer">
        <span role="status">{{ saving ? '正在校验并保存…' : feedback || missing }}</span>
        <div>
          <el-button :disabled="saving" @click="close()">关闭</el-button>
          <el-button
            type="primary"
            :loading="saving"
            :disabled="Boolean(missing) || (plan?.ready && sensitive.length > 0 && !confirmSensitive)"
            @click="submit"
          >
            {{ plan?.ready && sensitive.length ? '确认并完成共享' : editing ? '保存调整' : '完成共享' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import request, { extractErrorMessage } from '@/utils/request';
type Target = {
  id: string;
  name: string;
  subjectType: string;
  key: string;
  username?: string;
  department?: string;
  roleKey?: string;
};
type Share = {
  id: string;
  subject_type: string;
  subject_id: string;
  name: string;
  actions: string[] | string;
  status: string;
  username?: string;
  department?: string;
  roleKey?: string;
  linked?: boolean;
  canManageSource?: boolean;
  sourceResourceId?: string;
  sourceResourceName?: string;
};
type Issue = { name?: string; code: string };
type Addition = {
  key: string;
  name: string;
  subjectType: string;
  subjectId: string;
  subjectName: string;
  sensitive: boolean;
  scope: string;
};
type Plan = { fingerprint: string; ready: boolean; issues: Issue[]; additions: Addition[] };
type Resource = { id: string; name: string; resourceType: string; publishedVersion?: number; enabled?: boolean };
const props = defineProps<{ modelValue: boolean; resource?: Resource }>(),
  emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>();
const types: Record<string, string> = {
    ASSISTANT: '专家',
    SKILL: '技能',
    TOOL: '工具',
    MCP: 'MCP 工具',
    KNOWLEDGE: '知识库'
  },
  subjectLabels: Record<string, string> = { USER: '员工', ROLE: '角色', DEPARTMENT: '部门' };
const targetSelect = ref<{ focus: () => void }>(),
  filter = ref('ALL'),
  selected = ref<string[]>([]),
  options = ref<Target[]>([]),
  known = ref<Record<string, Target>>({}),
  shares = ref<Share[]>([]),
  allowUse = ref(true),
  allowEdit = ref(false),
  editing = ref(false),
  saving = ref(false),
  loading = ref(false),
  searching = ref(false),
  error = ref(''),
  listError = ref(''),
  searchError = ref(''),
  searchHint = ref('输入至少2个字符搜索'),
  lastQuery = ref(''),
  feedback = ref(''),
  panels = ref<string[]>([]),
  shareQuery = ref(''),
  plan = ref<Plan>(),
  confirmSensitive = ref(false);
let commandKey = crypto.randomUUID();
let generation = 0,
  loadGeneration = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined;
const missing = computed(() =>
  props.resource?.enabled === false
    ? '资源已停用，请先启用'
    : !props.resource?.publishedVersion
      ? '请先激活资源'
      : !selected.value.length
        ? '请选择共享对象'
        : selected.value.length > 50
          ? '每次最多50个对象'
          : ''
);
const sensitive = computed(() => plan.value?.additions.filter(g => g.sensitive) || []),
  automatic = computed(() => plan.value?.additions.filter(g => !g.sensitive) || []);
const visibleShares = computed(() =>
  shares.value.filter(s =>
    [s.name, s.username, s.department, s.roleKey, subjectLabels[s.subject_type]]
      .join(' ')
      .toLowerCase()
      .includes(shareQuery.value.toLowerCase())
  )
);
const actions = (v: string[] | string): string[] => {
  try {
    return Array.isArray(v) ? v : JSON.parse(v);
  } catch {
    return [];
  }
};
const targetLabel = (t?: Partial<Target>) =>
  t ? [t.name, t.username, t.department, t.roleKey].filter(Boolean).join(' · ') : '';
const clearPlan = () => {
  commandKey = crypto.randomUUID();
  plan.value = undefined;
  confirmSensitive.value = false;
  feedback.value = '';
  error.value = '';
};
async function api(path: string, method = 'get', data?: unknown, signal?: AbortSignal) {
  return (await request({ url: path, method, data, signal, headers: { repeatSubmit: false } })).data;
}
async function loadShares() {
  const g = ++loadGeneration;
  loading.value = true;
  listError.value = '';
  try {
    const list = await api('/ai/resources/' + props.resource!.id + '/shares');
    if (g === loadGeneration) shares.value = list;
  } catch (e) {
    if (g === loadGeneration) {
      listError.value = (await extractErrorMessage(e)) || '共享列表加载失败';
      if (!panels.value.includes('existing')) panels.value.push('existing');
    }
  } finally {
    if (g === loadGeneration) loading.value = false;
  }
}
function changeFilter() {
  searchTargets(lastQuery.value);
}
function searchTargets(query: string) {
  clearTimeout(timer);
  controller?.abort();
  const g = ++generation;
  lastQuery.value = query.trim();
  searchError.value = '';
  const retained = selected.value.map(k => known.value[k]).filter(Boolean);
  if (query.trim().length < 2) {
    options.value = retained;
    searching.value = false;
    searchHint.value = '输入至少2个字符搜索';
    return;
  }
  searching.value = true;
  timer = setTimeout(async () => {
    const current = (controller = new AbortController());
    try {
      let list = await api(
        '/ai/share-targets?type=' + filter.value + '&query=' + encodeURIComponent(query.trim()),
        'get',
        undefined,
        current.signal
      );
      if (g !== generation) return;
      if (filter.value === 'DEPARTMENT')
        list = list.filter((t: Target) => t.name.toLowerCase().includes(query.trim().toLowerCase()));
      const found: Target[] = list.map((t: Target) => ({
        ...t,
        subjectType: t.subjectType || filter.value,
        key: (t.subjectType || filter.value) + ':' + t.id
      }));
      for (const t of found) known.value[t.key] = t;
      options.value = [...new Map([...retained, ...found].map(t => [t.key, t])).values()];
      searchHint.value = found.length ? '' : '没有匹配的对象';
    } catch (e) {
      if (g === generation && !current.signal.aborted)
        searchError.value = (await extractErrorMessage(e)) || '搜索失败，请重试';
    } finally {
      if (g === generation) searching.value = false;
    }
  }, 250);
}
function edit(row: Share) {
  if (saving.value) return;
  clearPlan();
  const key = row.subject_type + ':' + row.subject_id;
  const target = { ...row, id: row.subject_id, subjectType: row.subject_type, key };
  known.value[key] = target;
  options.value = [target];
  selected.value = [key];
  allowUse.value = actions(row.actions).includes('USE');
  allowEdit.value = actions(row.actions).includes('EDIT');
  if (allowEdit.value && !panels.value.includes('advanced')) panels.value.push('advanced');
  editing.value = true;
  targetSelect.value?.focus();
}
function issueText(i: Issue) {
  const labels: Record<string, string> = {
    NoActiveMembersToVerify: '当前没有活跃成员，无法核实使用权限',
    ShareTargetTooLarge: '成员超过单次校验上限，请缩小范围',
    PermissionDenied: '缺少基础使用或转授权限',
    DependencyDelegationDenied: '当前管理员无权转授，请联系资源所有者',
    ResourceNotFound: '依赖不可见或无权转授',
    ResourceUnavailable: '依赖停用或未激活',
    McpConnectionNotReady: '连接尚未就绪，请先验证连接',
    McpConnectionRequired: '缺少可用的企业连接，请先完成连接配置',
    McpTemplateReconnectionRequired: '连接模板已更新，请重新验证连接',
    ToolTypeDisabled: '工具类型已停用，请联系工具管理员',
    KnowledgeIndexNotReady: '知识资料尚未完成索引，请先处理解析或索引错误',
    ExternalConnectionNotReady: '业务连接尚未验证通过',
    EnterpriseMcpConnectionRequired: '缺少可转授的企业连接，请先完成企业连接配置',
    DataScopeUnverified: '业务单位或凭证归属未确认，请先核对连接',
    McpDelegationRequiresReadOnlyScope: '该工具包含未明确的写入/发送权限，不能自动转授',
    ModelPermissionDenied: '模型未授权或不可用',
    ModelUnavailable: '模型不可用'
  };
  return (i.name || '依赖') + '：' + (labels[i.code] || '当前依赖不可用，请联系资源管理员核对配置');
}
async function submit() {
  if (saving.value || missing.value) return;
  saving.value = true;
  error.value = '';
  feedback.value = '';
  const targets = selected.value.map(key => ({
    subjectType: known.value[key].subjectType,
    subjectId: known.value[key].id
  }));
  const requested = ['VIEW', ...(allowUse.value ? ['USE'] : []), ...(allowEdit.value ? ['EDIT'] : [])];
  const labels = selected.value.map(key => targetLabel(known.value[key]));
  try {
    const checked: Plan = await api('/ai/resources/' + props.resource!.id + '/shares/plan', 'post', {
      targets,
      actions: requested
    });
    const previous = plan.value;
    plan.value = checked;
    if (!checked.ready) {
      confirmSensitive.value = false;
      return;
    }
    if (
      checked.additions.some(g => g.sensitive) &&
      (!confirmSensitive.value || previous?.fingerprint !== checked.fingerprint)
    ) {
      confirmSensitive.value = false;
      return;
    }
    await api('/ai/resources/' + props.resource!.id + '/shares/batch', 'post', {
      targets,
      actions: requested,
      fingerprint: checked.fingerprint,
      idempotencyKey: commandKey,
      confirmedDependencies: [...new Set(checked.additions.filter(g => g.sensitive).map(g => g.key))]
    });
    selected.value = [];
    editing.value = false;
    plan.value = undefined;
    confirmSensitive.value = false;
    feedback.value = '已生效：' + labels.join('、');
    ElMessage.success(feedback.value);
    await loadShares();
  } catch (e) {
    const reason = await extractErrorMessage(e);
    const errors: Record<string, string> = {
      SharePlanChanged: '配置或权限刚刚变更，请重新检查并确认',
      ShareDependenciesUnavailable: '依赖条件已变化，整组授权未保存，请重试',
      SensitiveDependencyConfirmationRequired: '请确认所需追加权限后重试'
    };
    error.value = errors[reason || ''] || reason || '未完成共享，输入已保留，请重试';
    plan.value = undefined;
    confirmSensitive.value = false;
  } finally {
    saving.value = false;
  }
}
async function revoke(row: Share) {
  if (saving.value) return;
  try {
    await ElMessageBox.confirm(
      '撤回“' +
        row.name +
        '”对“' +
        (row.linked ? row.sourceResourceName : props.resource!.name) +
        '”的这条授权，随此共享追加的依赖授权也将停止生效。独立授权及其他角色、部门或公开发布的权限保留，该对象可能仍可使用。',
      '撤回共享',
      { type: 'warning', confirmButtonText: '撤回这条授权', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    await api(
      '/ai/resources/' + (row.linked ? row.sourceResourceId : props.resource!.id) + '/shares/' + row.id,
      'delete'
    );
    await loadShares();
    clearPlan();
    ElMessage.success('已撤回此条共享，其他独立授权保留');
  } catch (e) {
    error.value = (await extractErrorMessage(e)) || '撤回失败，请重试';
  } finally {
    saving.value = false;
  }
}
async function close(done?: () => void) {
  if (saving.value) return;
  if (selected.value.length) {
    try {
      await ElMessageBox.confirm('尚未提交的共享设置将不保存。', '关闭共享', {
        confirmButtonText: '放弃并关闭',
        cancelButtonText: '继续设置'
      });
    } catch {
      return;
    }
  }
  ++generation;
  ++loadGeneration;
  controller?.abort();
  clearTimeout(timer);
  done?.();
  emit('update:modelValue', false);
}
watch(
  () => props.modelValue,
  visible => {
    if (!visible) return;
    ++generation;
    controller?.abort();
    clearTimeout(timer);
    filter.value = 'ALL';
    selected.value = [];
    options.value = [];
    known.value = {};
    allowUse.value = true;
    allowEdit.value = false;
    editing.value = false;
    searching.value = false;
    searchError.value = '';
    searchHint.value = '输入至少2个字符搜索';
    shareQuery.value = '';
    lastQuery.value = '';
    panels.value = [];
    clearPlan();
    void loadShares();
  }
);
onBeforeUnmount(() => {
  ++generation;
  ++loadGeneration;
  controller?.abort();
  clearTimeout(timer);
});
</script>
<style scoped>
.resource-line,
.selected-targets,
.target-search,
.share-footer {
  display: flex;
  align-items: center;
  gap: 10px;
}
.resource-line {
  margin-bottom: 20px;
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.selected-targets {
  flex-wrap: wrap;
  margin: -8px 0 18px;
}
.target-search {
  width: 100%;
  align-items: flex-start;
}
.target-filter {
  width: 110px;
  flex-shrink: 0;
}
.target-picker {
  flex: 1;
  min-width: 0;
}
.field-help,
.object-context {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.field-help {
  line-height: 1.7;
}
.object-context {
  display: block;
}
.selection-empty {
  padding: 14px;
  text-align: center;
  color: var(--el-text-color-secondary);
}
.dependency-confirm {
  padding: 14px;
  margin-top: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
.dependency-confirm h4 {
  margin: 0 0 8px;
}
.dependency-row {
  margin: 10px 0;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.dependency-row > div {
  margin-top: 5px;
  line-height: 1.6;
  color: var(--el-text-color-secondary);
}
.share-footer {
  justify-content: space-between;
  width: 100%;
  align-items: center;
}
.share-footer > span {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  overflow-wrap: anywhere;
  max-height: 54px;
  overflow-y: auto;
}
.share-footer > div {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}
@media (max-width: 760px) {
  .share-footer {
    align-items: flex-start;
    flex-direction: column;
  }
  .share-footer > div {
    align-self: flex-end;
  }
  .target-filter {
    width: 95px;
  }
}
</style>
