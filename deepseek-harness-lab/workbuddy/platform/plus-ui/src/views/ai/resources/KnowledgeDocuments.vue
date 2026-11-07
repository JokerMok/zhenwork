<template>
  <el-dialog :model-value="true" title="企业知识文档" width="850px" @update:model-value="close">
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <p><strong>{{ base.name }}</strong> · 支持 Word、Excel、PPT、PDF、图片及 UTF-8 文本，最大 10 MiB。索引成功后新版本生效。</p>
    <input ref="newDocumentInput" hidden type="file" aria-label="上传知识文档" :accept="formats" :disabled="mutating" @change="uploadDocument" />
    <el-button type="primary" :disabled="mutating" @click="newDocumentInput?.click()">上传文档</el-button>
    <el-button :disabled="mutating" @click="loadDocuments()">刷新索引状态</el-button>
    <el-table v-loading="loading" :data="documents">
      <el-table-column prop="title" label="文件" min-width="180" show-overflow-tooltip />
      <el-table-column prop="latest_version" label="最新版本" width="90" />
      <el-table-column prop="indexed_version" label="索引生效版本" width="120" />
      <el-table-column label="索引状态">
        <template #default="{row}">{{ statuses[row.status] || row.status }}</template>
      </el-table-column>
      <el-table-column label="解析失败原因">
        <template #default="{row}">{{ documentIssue(row) || '—' }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="230">
        <template #default="{row}">
          <el-button link :disabled="mutating" @click="previewDocument(row)">预览</el-button>
          <input :ref="(el) => setVersionInput(row.id,el)" hidden type="file" :aria-label="'上传新版本 '+row.title" :accept="formats" :disabled="mutating" @change="uploadDocument($event,row)" />
          <el-button link :disabled="mutating" @click="versionInputs.get(row.id)?.click()">上传新版本</el-button>
          <el-dropdown trigger="click" :disabled="mutating"><el-button link :disabled="mutating" :aria-label="'更多文档操作 '+row.title">更多</el-button><template #dropdown><el-dropdown-menu>
            <el-dropdown-item @click="reindexDocument(row)">重新索引</el-dropdown-item>
            <el-dropdown-item @click="removeDocument(row)">删除</el-dropdown-item>
          </el-dropdown-menu></template></el-dropdown>
        </template>
      </el-table-column>
    </el-table>
    <el-button :disabled="page===1||loading||mutating" @click="loadDocuments(page-1)">上一页文档</el-button>
    <span>第 {{ page }} 页</span>
    <el-button :disabled="documents.length<30||loading||mutating" @click="loadDocuments(page+1)">下一页文档</el-button>
    <div v-if="source || previewLoading" :aria-busy="previewLoading"><el-button link @click="resetPreview">关闭预览</el-button><el-skeleton v-if="previewLoading" :rows="2" animated /><pre v-else class="source">{{ source }}</pre></div>
    <KnowledgeDiagnostics :base-id="base.id" />
  </el-dialog>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessageBox } from 'element-plus';
import KnowledgeDiagnostics from './KnowledgeDiagnostics.vue';
import request, { extractErrorMessage } from '@/utils/request';

type DocumentRow = { id: string; title: string; latest_version: number; indexed_version?: number; status: string };
type IndexJob = { document_id?: string; documentId?: string; version: number; error_code?: string; errorCode?: string };
const props = defineProps<{ base: { id: string; name: string } }>();
const emit = defineEmits<{ close: [] }>();
const formats = '.txt,.md,.csv,.json,.docx,.xlsx,.pptx,.pdf,.png,.jpg,.jpeg,.webp,.bmp,.tif,.tiff';
const statuses: Record<string,string> = { READY:'可使用', QUEUED:'等待索引', RUNNING:'索引中', COMPLETED:'已完成', FAILED:'失败', ERROR:'失败' };
const documents = ref<DocumentRow[]>([]);
const jobs = ref<IndexJob[]>([]);
const page = ref(1);
const newDocumentInput=ref<HTMLInputElement>();
const versionInputs=new Map<string,HTMLInputElement>();
function setVersionInput(id:string,el:unknown){if(el instanceof HTMLInputElement)versionInputs.set(id,el);else versionInputs.delete(id);}
const source = ref('');
const previewLoading = ref(false);
const error = ref('');
const loading = ref(false);
const mutating = ref(false);
let open = true;
let listRequest: AbortController | undefined;
let previewRequest: AbortController | undefined;

async function api(url: string, data?: unknown, method = data ? 'post' : 'get', signal?: AbortSignal) {
  return (await request({ url, method, data, signal, headers: data instanceof FormData ? { repeatSubmit: false } : {} })).data;
}

function resetPreview() {
  previewRequest?.abort();
  previewLoading.value = false;
  source.value = '';
}

function invalidate() {
  open = false;
  listRequest?.abort();
  resetPreview();
}

function close() {
  invalidate();
  emit('close');
}

async function loadDocuments(nextPage = page.value) {
  listRequest?.abort();
  resetPreview();
  const controller = new AbortController();
  listRequest = controller;
  const baseUrl = '/ai/knowledge/' + props.base.id;
  page.value = nextPage;
  documents.value = [];
  jobs.value = [];
  error.value = '';
  loading.value = true;
  try {
    const [rows, indexJobs] = await Promise.all([
      api(baseUrl + '/documents?page=' + nextPage, undefined, 'get', controller.signal),
      api(baseUrl + '/jobs', undefined, 'get', controller.signal).catch(() => [])
    ]);
    if (open && !controller.signal.aborted) {
      documents.value = rows;
      jobs.value = indexJobs;
    }
  } catch (e) {
    const message = await extractErrorMessage(e);
    if (open && !controller.signal.aborted) error.value = message || '文档加载失败，请刷新重试。';
  } finally {
    if (open && !controller.signal.aborted) loading.value = false;
  }
}

function documentUrl(row: DocumentRow) {
  return '/ai/knowledge/documents/' + row.id;
}

function documentIssue(row: DocumentRow) {
  const job = jobs.value.find(item => (item.document_id || item.documentId) === row.id && item.version === row.latest_version);
  return job?.error_code || job?.errorCode || '';
}

async function previewDocument(row: DocumentRow) {
  if (!documents.value.includes(row)) return;
  resetPreview();
  const controller = new AbortController();
  previewRequest = controller;
  previewLoading.value = true;
  error.value = '';
  try {
    const version = await api(documentUrl(row) + '/versions/' + row.latest_version, undefined, 'get', controller.signal);
    if (open && !controller.signal.aborted) source.value = version.content;
  } catch (e) {
    const message = await extractErrorMessage(e);
    if (open && !controller.signal.aborted) error.value = message || '文档预览失败。';
  } finally {
    if (open && previewRequest === controller && !controller.signal.aborted) previewLoading.value = false;
  }
}

async function mutate(action: () => Promise<unknown>, row?: DocumentRow) {
  if (!open || mutating.value) return;
  if (row && !documents.value.includes(row)) {
    error.value = '文档列表已更新，请重新选择文档。';
    return;
  }
  const baseId=props.base.id;
  mutating.value = true;
  error.value = '';
  try {
    await action();
    if (open && baseId===props.base.id) await loadDocuments();
  } catch (e) {
    const message = await extractErrorMessage(e);
    if (open && baseId===props.base.id) error.value = message || '文档操作未完成，请重试。';
  } finally {
    if (open) mutating.value = false;
  }
}

async function uploadDocument(event: Event, row?: DocumentRow) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    error.value = '文件超过 10 MiB 限制。';
    return;
  }
  const data = new FormData();
  data.set('file', file);
  data.set('idempotencyKey', crypto.randomUUID());
  if (row) {
    data.set('documentId', row.id);
    data.set('expectedVersion', String(row.latest_version));
  }
  await mutate(() => api('/ai/knowledge/' + props.base.id + '/documents', data), row);
}

async function reindexDocument(row:DocumentRow){
  try{await ElMessageBox.confirm('重新解析并索引「'+row.title+'」的最新版本。索引成功后新版本生效。','重新索引文档',{type:'warning',confirmButtonText:'重新索引',cancelButtonText:'取消'});}catch{return;}
  await mutate(()=>api(documentUrl(row)+'/reindex',{}),row);
}

async function removeDocument(row: DocumentRow) {
  try {
    await ElMessageBox.confirm(
      '将删除知识库「' + props.base.name + '」中的文档「' + row.title + '」。相关任务会被取消，旧引用会失效。',
      '删除文档',
      { type: 'warning' }
    );
  } catch {
    return;
  }
  await mutate(() => api(documentUrl(row), undefined, 'delete'), row);
}

watch(()=>props.base.id,()=>{void loadDocuments(1)});
onMounted(() => loadDocuments());
onBeforeUnmount(invalidate);
</script>

<style scoped>
.source { max-height: 350px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
