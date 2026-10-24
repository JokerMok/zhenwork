<template>
  <el-dialog
    :model-value="modelValue"
    title="企业资源共享"
    width="880px"
    class="resource-share-dialog"
    destroy-on-close
    :close-on-click-modal="false"
    :before-close="close"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-descriptions v-if="resource" :column="2" border class="mb-4">
      <el-descriptions-item label="资源名称">{{ resource.name }}</el-descriptions-item>
      <el-descriptions-item label="资源类型">
        {{ types[resource.resourceType] || resource.resourceType }}
      </el-descriptions-item>
      <el-descriptions-item label="资源状态">
        {{
          resource.enabled === false
            ? '已停用'
            : resource.publishedVersion
              ? '已激活 v' + resource.publishedVersion
              : '未激活'
        }}
      </el-descriptions-item>
      <el-descriptions-item label="授权方式">引用当前组织资源，不复制凭据</el-descriptions-item>
    </el-descriptions>
    <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-4">
      <el-button link @click="loadShares">重新加载共享列表</el-button>
    </el-alert>
    <el-form label-position="top" :disabled="saving" @submit.prevent="submit">
      <el-form-item label="共享对象类型" required>
        <el-radio-group v-model="subjectType" @change="changeType">
          <el-radio-button value="DEPARTMENT">部门</el-radio-button>
          <el-radio-button value="ROLE">角色</el-radio-button>
          <el-radio-button value="USER">员工</el-radio-button>
        </el-radio-group>
      </el-form-item>
      <el-form-item :label="'选择' + subjectLabels[subjectType]" required :error="searchError">
        <el-tree-select
          v-if="subjectType === 'DEPARTMENT'"
          v-model="selectedIds"
          :data="departmentTree"
          :props="{ label: 'label', value: 'id', children: 'children' }"
          node-key="id"
          multiple
          show-checkbox
          check-strictly
          filterable
          default-expand-all
          collapse-tags
          collapse-tags-tooltip
          :max-collapse-tags="5"
          :loading="searching"
          :disabled="saving"
          style="width: 100%"
          placeholder="选择部门，可搜索名称"
          @change="clearIssues"
        />
        <el-select
          v-else
          v-model="selectedIds"
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
          :max-collapse-tags="5"
          style="width: 100%"
          :placeholder="
            subjectType === 'USER' ? '输入姓名或账号搜索（至少2个字符）' : '输入角色名称搜索（至少2个字符）'
          "
          @change="clearIssues"
        >
          <el-option v-for="target in options" :key="target.id" :label="targetLabel(target)" :value="target.id" />
          <template #empty>
            <div class="selection-empty">{{ searching ? '正在搜索…' : searchError || searchHint }}</div>
          </template>
        </el-select>
        <el-button
          v-if="searchError"
          link
          @click="subjectType === 'DEPARTMENT' ? loadDepartments() : searchTargets(lastQuery)"
        >
          重试搜索
        </el-button>
      </el-form-item>
      <div v-if="selectedIds.length" class="selected-targets">
        <span>已选 {{ selectedIds.length }} 项</span>
        <el-tag v-for="id in selectedIds" :key="id" closable :disable-transitions="true" @close="remove(id)">
          {{ nameFor(id) }}
        </el-tag>
      </div>
      <el-form-item label="共享权限" required>
        <el-checkbox :model-value="true" disabled>查看</el-checkbox>
        <el-checkbox v-model="allowUse" @change="clearIssues">使用</el-checkbox>
        <el-checkbox v-model="allowEdit" @change="clearIssues">编辑草稿</el-checkbox>
        <div class="field-help">使用和编辑草稿均包含查看；编辑不会自动发布或扩大依赖授权。</div>
      </el-form-item>
    </el-form>
    <el-alert
      v-if="subjectType !== 'USER'"
      type="info"
      :closable="false"
      class="mb-4"
      title="部门按直接归属、角色按实际成员生效。当前成员在提交前核查；未来成员仍须通过执行时权限校验。"
    />
    <el-alert v-if="issues.length" title="共享前检查未通过，尚未提交授权" type="warning" :closable="false" class="mb-4">
      <ul>
        <li v-for="(issue, index) in issues" :key="index">{{ issue }}</li>
      </ul>
      <el-link @click="configuration('/workspace-resources/resources')">前往资源管理</el-link>
      <span class="mx-2">·</span>
      <el-link @click="configuration('/workspace-models/registry')">前往模型与授权</el-link>
    </el-alert>
    <el-divider content-position="left">已有共享</el-divider>
    <el-table v-loading="loading" :data="shares" max-height="280" empty-text="尚未设置共享">
      <el-table-column label="对象类型" width="90">
        <template #default="{ row }">{{ subjectLabels[row.subject_type] || row.subject_type }}</template>
      </el-table-column>
      <el-table-column label="对象名称" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          {{ row.name || '对象已删除' }}
          <span v-if="row.username">（{{ row.username }}）</span>
          <small v-if="row.department" class="object-context">{{ row.department }}</small>
        </template>
      </el-table-column>
      <el-table-column label="权限" min-width="180">
        <template #default="{ row }">
          {{
            actions(row.actions)
              .map(action => permissionLabels[action] || action)
              .join('、')
          }}
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ACTIVE' ? 'success' : 'info'">
            {{ row.status === 'ACTIVE' ? '生效中' : row.status === 'REVOKED' ? '已撤回' : '不可用' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'ACTIVE'">
            <el-button link :disabled="saving" @click="edit(row)">调整</el-button>
            <el-button link type="danger" :disabled="saving" @click="revoke(row)">撤回</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>
    <template #footer>
      <div class="share-footer">
        <span role="status">
          {{ saving ? '正在校验并保存…' : missing || '相同对象再次提交会更新已有授权，不生成重复记录。' }}
        </span>
        <div>
          <el-button :disabled="saving" @click="close()">关闭</el-button>
          <el-button type="primary" :loading="saving" :disabled="Boolean(missing)" @click="submit">
            {{ editing ? '保存权限调整' : '确认共享' }}
          </el-button>
        </div>
      </div>
    </template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import request, { extractErrorMessage } from '@/utils/request';
type Target = {
  id: string;
  name: string;
  parentId?: string;
  username?: string;
  department?: string;
  roleKey?: string;
  label?: string;
  children?: Target[];
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
};
type Resource = { id: string; name: string; resourceType: string; publishedVersion?: number; enabled?: boolean };
const props = defineProps<{ modelValue: boolean; resource?: Resource }>(),
  emit = defineEmits<{ (e: 'update:modelValue', value: boolean): void }>(),
  router = useRouter();
const types: Record<string, string> = {
    ASSISTANT: '助手',
    SKILL: '技能',
    TOOL: '工具',
    MCP: 'MCP 工具',
    KNOWLEDGE: '知识库'
  },
  subjectLabels: Record<string, string> = { USER: '员工', ROLE: '角色', DEPARTMENT: '部门' },
  permissionLabels: Record<string, string> = { VIEW: '查看', USE: '使用', EDIT: '编辑草稿' };
const shares = ref<Share[]>([]),
  subjectType = ref('DEPARTMENT'),
  selectedIds = ref<string[]>([]),
  options = ref<Target[]>([]),
  departments = ref<Target[]>([]),
  known = ref<Record<string, Target>>({}),
  allowUse = ref(true),
  allowEdit = ref(false),
  editing = ref(false),
  loading = ref(false),
  saving = ref(false),
  searching = ref(false),
  error = ref(''),
  searchError = ref(''),
  searchHint = ref('输入至少2个字符搜索'),
  lastQuery = ref(''),
  issues = ref<string[]>([]);
let generation = 0,
  loadGeneration = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  controller: AbortController | undefined;
const missing = computed(() =>
  !props.resource?.publishedVersion
    ? '请先激活资源版本，再设置共享'
    : selectedIds.value.length === 0
      ? '请选择共享对象'
      : selectedIds.value.length > 50
        ? '每次最多选择50个对象'
        : ''
);
const departmentTree = computed(() => {
  const map = new Map(departments.value.map(t => [t.id, { ...t, label: t.name, children: [] as Target[] }]));
  const roots: Target[] = [];
  for (const node of map.values()) {
    const parent = map.get(node.parentId || '');
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  return roots;
});
const actions = (value: string[] | string): string[] => {
  try {
    return Array.isArray(value) ? value : JSON.parse(value);
  } catch {
    return [];
  }
};
const targetLabel = (t: Target) =>
  t.name +
  (t.username ? ' · ' + t.username : '') +
  (t.department ? ' · ' + t.department : '') +
  (t.roleKey ? ' · ' + t.roleKey : '');
const nameFor = (id: string) => (known.value[id] ? targetLabel(known.value[id]) : id);
const clearIssues = () => {
  issues.value = [];
};
const remove = (id: string) => {
  if (!saving.value) selectedIds.value = selectedIds.value.filter(x => x !== id);
};
async function api(path: string, method = 'get', data?: unknown, signal?: AbortSignal) {
  return (await request({ url: path, method, data, signal, headers: { repeatSubmit: false } })).data;
}
async function loadShares() {
  const g = ++loadGeneration;
  loading.value = true;
  error.value = '';
  try {
    const list = await api('/ai/resources/' + props.resource!.id + '/shares');
    if (g === loadGeneration) shares.value = list;
  } catch (e) {
    if (g === loadGeneration) error.value = (await extractErrorMessage(e)) || '共享列表加载失败，请重试';
  } finally {
    if (g === loadGeneration) loading.value = false;
  }
}
function resetSearch() {
  ++generation;
  clearTimeout(timer);
  controller?.abort();
  searching.value = false;
  searchError.value = '';
  lastQuery.value = '';
  options.value = [];
  known.value = {};
  selectedIds.value = [];
  issues.value = [];
  editing.value = false;
}
async function loadDepartments() {
  const g = ++generation;
  searching.value = true;
  searchError.value = '';
  try {
    const list = await api('/ai/share-targets?type=DEPARTMENT&query=');
    if (g !== generation) return;
    departments.value = list;
    for (const t of list) known.value[t.id] = t;
  } catch (e) {
    if (g === generation) searchError.value = (await extractErrorMessage(e)) || '部门加载失败';
  } finally {
    if (g === generation) searching.value = false;
  }
}
function changeType() {
  resetSearch();
  if (subjectType.value === 'DEPARTMENT') void loadDepartments();
}
function searchTargets(query: string) {
  clearTimeout(timer);
  controller?.abort();
  const g = ++generation;
  lastQuery.value = query.trim();
  searchError.value = '';
  if (lastQuery.value.length < 2) {
    searching.value = false;
    options.value = selectedIds.value.map(id => known.value[id]).filter(Boolean);
    searchHint.value = '输入至少2个字符搜索';
    return;
  }
  searching.value = true;
  timer = setTimeout(async () => {
    const current = (controller = new AbortController());
    try {
      const list = await api(
        '/ai/share-targets?type=' + subjectType.value + '&query=' + encodeURIComponent(lastQuery.value),
        'get',
        undefined,
        current.signal
      );
      if (g !== generation) return;
      for (const t of list) known.value[t.id] = t;
      options.value = [
        ...new Map(
          [...selectedIds.value.map(id => known.value[id]).filter(Boolean), ...list].map(t => [t.id, t])
        ).values()
      ];
      searchHint.value = list.length ? '' : '没有匹配的对象，请更换关键词';
    } catch (e) {
      if (g === generation && !current.signal.aborted)
        searchError.value = (await extractErrorMessage(e)) || '搜索失败，请重试';
    } finally {
      if (g === generation) searching.value = false;
    }
  }, 250);
}
async function edit(row: Share) {
  if (saving.value) return;
  subjectType.value = row.subject_type;
  resetSearch();
  known.value[row.subject_id] = {
    id: row.subject_id,
    name: row.name,
    username: row.username,
    department: row.department
  };
  options.value = [known.value[row.subject_id]];
  selectedIds.value = [row.subject_id];
  allowUse.value = actions(row.actions).includes('USE');
  allowEdit.value = actions(row.actions).includes('EDIT');
  editing.value = true;
  if (subjectType.value === 'DEPARTMENT') await loadDepartments();
}
const issueText = (i: { name?: string; type?: string; code: string }) => {
  const message: Record<string, string> = {
    ShareTargetTooLarge: '成员范围超过单次校验上限，请缩小范围',
    NoActiveMembersToVerify: '当前没有活跃成员，无法核实使用权限',
    ModelUnavailable: '模型不可用或尚未授权',
    ModelPermissionDenied: '未获得模型使用权限',
    ModelNotFound: '依赖模型不存在',
    InvalidResourceDependencies: '资源依赖不完整，请先编辑资源配置',
    ResourceNotFound: '未获得该依赖的授权',
    PermissionDenied: '缺少基础使用权限',
    ResourceUnavailable: '依赖未激活或已停用'
  };
  return (
    (i.name || types[i.type || ''] || '依赖') + '：' + (message[i.code] || '权限或运行条件未满足（' + i.code + '）')
  );
};
async function submit() {
  if (saving.value || missing.value) return;
  saving.value = true;
  error.value = '';
  issues.value = [];
  const pending = [...selectedIds.value];
  try {
    const checks = [];
    for (const id of pending) {
      const c = await api(
        '/ai/resources/' +
          props.resource!.id +
          '/shares/preflight?subjectType=' +
          subjectType.value +
          '&subjectId=' +
          id +
          '&use=' +
          allowUse.value
      );
      checks.push({ id, ...c });
    }
    for (const c of checks)
      if (!c.ready)
        issues.value.push(
          ...c.issues.map((i: Parameters<typeof issueText>[0]) => nameFor(c.id) + ' — ' + issueText(i))
        );
    if (issues.value.length) return;
    const requested = ['VIEW', ...(allowUse.value ? ['USE'] : []), ...(allowEdit.value ? ['EDIT'] : [])];
    for (const id of pending) {
      await api('/ai/resources/' + props.resource!.id + '/shares', 'post', {
        subjectType: subjectType.value,
        subjectId: id,
        actions: requested
      });
      selectedIds.value = selectedIds.value.filter(x => x !== id);
    }
    await loadShares();
    editing.value = false;
    ElMessage.success('共享权限已保存；员工执行时仍会复核依赖授权');
  } catch (e) {
    const reason = (await extractErrorMessage(e)) || '保存未完成，未成功对象已保留，请重试';
    await loadShares();
    error.value = reason;
  } finally {
    saving.value = false;
  }
}
async function revoke(row: Share) {
  if (saving.value) return;
  try {
    await ElMessageBox.confirm(
      '撤回“' +
        (row.name || '该对象') +
        '”对“' +
        props.resource!.name +
        '”的这条授权，依赖该授权的任务可能停止。该对象仍可能通过其他角色、部门或公开发布使用资源。',
      '撤回共享',
      { type: 'warning', confirmButtonText: '撤回这条授权', cancelButtonText: '取消' }
    );
  } catch {
    return;
  }
  saving.value = true;
  try {
    await api('/ai/resources/' + props.resource!.id + '/shares/' + row.id, 'delete');
    await loadShares();
    ElMessage.success('此条授权已撤回，其他有效授权仍适用');
  } catch (e) {
    error.value = (await extractErrorMessage(e)) || '撤回失败，请重试';
  } finally {
    saving.value = false;
  }
}
async function close(done?: () => void) {
  if (saving.value) return;
  if (selectedIds.value.length) {
    try {
      await ElMessageBox.confirm('尚未提交的共享对象和权限将不保存。', '关闭共享设置', {
        confirmButtonText: '放弃并关闭',
        cancelButtonText: '继续设置'
      });
    } catch {
      return;
    }
  }
  ++generation;
  controller?.abort();
  clearTimeout(timer);
  done?.();
  emit('update:modelValue', false);
}
async function configuration(path: string) {
  try {
    await ElMessageBox.confirm('离开后，本次尚未提交的设置不保存；不会自动为依赖增加授权。', '前往配置', {
      confirmButtonText: '前往配置',
      cancelButtonText: '继续设置'
    });
  } catch {
    return;
  }
  emit('update:modelValue', false);
  await router.push(path);
}
watch(
  () => props.modelValue,
  async visible => {
    if (!visible) return;
    subjectType.value = 'DEPARTMENT';
    resetSearch();
    allowUse.value = true;
    allowEdit.value = false;
    error.value = '';
    await Promise.all([loadShares(), loadDepartments()]);
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
.selected-targets {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: -8px 0 20px;
}
.field-help {
  width: 100%;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}
.selection-empty {
  padding: 14px;
  text-align: center;
  color: var(--el-text-color-secondary);
}
.object-context {
  display: block;
  color: var(--el-text-color-secondary);
}
.share-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  width: 100%;
}
.share-footer > span {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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
}
</style>
