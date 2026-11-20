<template>
  <el-table :data="rows" :empty-text="emptyText || '当前没有记录'">
    <el-table-column
      v-for="field in summary"
      :key="field"
      :label="labels[field] || field"
      min-width="145"
      show-overflow-tooltip
    >
      <template #default="{ row }">{{ displayValue(field, row[field]) }}</template>
    </el-table-column>
    <el-table-column label="详情" width="90" fixed="right">
      <template #default="{ row }"><el-button link @click="detail = row">查看</el-button></template>
    </el-table-column>
  </el-table>
  <el-dialog
    :model-value="Boolean(detail)"
    title="记录详情"
    width="min(780px, calc(100vw - 32px))"
    @close="detail = null"
    @update:model-value="
      value => {
        if (!value) detail = null;
      }
    "
  >
    <el-descriptions v-if="detail" :column="1" border>
      <el-descriptions-item v-for="(value, key) in detail" :key="key" :label="labels[String(key)] || String(key)">
        <details v-if="value && typeof value === 'object'" class="record-value">
          <summary>展开结构化字段</summary>
          <pre>{{ JSON.stringify(value, null, 2) }}</pre>
        </details>
        <span v-else class="record-value">{{ displayValue(String(key), value) }}</span>
        <el-button v-if="technical(String(key)) && value" link @click="copy(String(value))">复制</el-button>
      </el-descriptions-item>
    </el-descriptions>
    <template #footer><el-button @click="detail = null">关闭</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, ref, watch } from 'vue';
import { workspaceLabel } from '@/utils/workspacePresentation';
const props = defineProps<{
  rows: Record<string, unknown>[];
  columns: string[];
  labels: Record<string, string>;
  emptyText?: string;
}>();
const detail = ref<Record<string, unknown> | null>(null);
const technical = (field: string) => /(?:^id$|_id$|Id$|hash$|request_id|^sequence$)/.test(field);
const summary = computed(() => {
  const fields = props.columns.filter(field => !technical(field));
  return (fields.length ? fields : props.columns).slice(0, 6);
});
watch(
  () => props.rows,
  () => {
    detail.value = null;
  }
);
function displayValue(field: string, value: unknown) {
  if (
    value == null &&
    /^(?:input_tokens|output_tokens|estimated_cost|provider_ttfb_ms|first_token_ms|duration_ms)$/.test(field)
  )
    return '未采集';
  return workspaceLabel(value);
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败，请选择标识文字手动复制');
  }
}
</script>
<style scoped>
.record-value {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin-right: 12px;
}
.record-value summary {
  cursor: pointer;
}
.record-value pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 360px;
  overflow: auto;
}
</style>
