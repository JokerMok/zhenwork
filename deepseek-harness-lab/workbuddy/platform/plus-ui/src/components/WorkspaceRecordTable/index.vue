<template>
  <el-table :data="rows" empty-text="当前没有记录">
    <el-table-column
      v-for="field in summary"
      :key="field"
      :label="labels[field] || field"
      min-width="145"
      show-overflow-tooltip
    >
      <template #default="{ row }">{{ workspaceLabel(row[field]) }}</template>
    </el-table-column>
    <el-table-column label="详情" width="90" fixed="right">
      <template #default="{ row }"><el-button link @click="detail = row">查看</el-button></template>
    </el-table-column>
  </el-table>
  <el-dialog
    :model-value="Boolean(detail)"
    title="记录详情"
    width="780px"
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
        <span v-else class="record-value">{{ workspaceLabel(value) }}</span>
        <el-button v-if="technical(String(key)) && value" link @click="copy(String(value))">复制</el-button>
      </el-descriptions-item>
    </el-descriptions>
    <template #footer><el-button @click="detail = null">关闭</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import { ElMessage } from 'element-plus';
import { computed, ref } from 'vue';
import { workspaceLabel } from '@/utils/workspacePresentation';
const props = defineProps<{ rows: Record<string, unknown>[]; columns: string[]; labels: Record<string, string> }>();
const detail = ref<Record<string, unknown> | null>(null);
const technical = (field: string) => /(?:^id$|_id$|Id$|hash$|request_id|^sequence$)/.test(field);
const summary = computed(() => props.columns.filter(field => !technical(field)).slice(0, 12));
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
