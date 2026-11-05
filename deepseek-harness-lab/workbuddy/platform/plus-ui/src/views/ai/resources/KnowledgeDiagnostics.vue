<template>
  <section class="diagnostics">
    <h3>检索诊断</h3>
    <el-form :inline="true" @submit.prevent>
      <el-form-item label="查询"><el-input v-model="query" maxlength="200" clearable @keyup.enter="run" /></el-form-item>
      <el-form-item label="范围"><el-select v-model="mode"><el-option label="当前索引版本" value="current" /><el-option label="指定文档版本" value="version" /></el-select></el-form-item>
      <template v-if="mode==='version'">
        <el-form-item label="文档 ID"><el-input v-model="documentId" /></el-form-item>
        <el-form-item label="版本"><el-input-number v-model="version" :min="1" /></el-form-item>
      </template>
      <el-button type="primary" :loading="loading" :disabled="!query.trim()||mode==='version'&&(!documentId||!version)" @click="run">运行诊断</el-button>
    </el-form>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <template v-if="result">
      <div class="summary">
        <el-tag :type="result.outcome==='HIT'?'success':result.outcome==='NOT_INDEXED'?'warning':'info'">{{ outcome[result.outcome]||result.outcome }}</el-tag>
        <span>{{ result.scope.mode==='CURRENT_INDEXED'?'当前索引版本':'版本历史' }}</span>
        <span>候选 {{ result.summary.matchedCandidates }} · 返回 {{ result.summary.returnedHits }} · 截断 {{ result.summary.filteredByTopK }}</span>
        <span>PostgreSQL 词法 · Top {{ result.config.topK }} · Trigram 阈值 {{ result.config.trigramCandidateThreshold }}</span>
        <span>匹配 FTS / Trigram / 包含 · 权重 4 / 2 / 1 · 二级排序 ts_rank_cd + similarity · 无重排、元数据过滤或去重</span>
      </div>
      <el-table :data="result.scope.versions" size="small">
        <el-table-column prop="documentId" label="文档" min-width="260" />
        <el-table-column prop="version" label="检索版本" width="90" />
        <el-table-column prop="latestVersion" label="最新版本" width="90" />
        <el-table-column prop="indexedVersion" label="索引版本" width="90" />
        <el-table-column prop="status" label="状态" width="90" />
        <el-table-column prop="chunkCount" label="分块" width="70" />
        <el-table-column label="索引判定" min-width="150"><template #default="{row}">{{ reasons[row.reason]||row.reason }}</template></el-table-column>
      </el-table>
      <el-empty v-if="!result.candidates.length" :description="result.outcome==='NOT_INDEXED'?'范围内没有可检索索引':'可检索范围内没有命中'" />
      <article v-for="item in result.candidates" :key="item.documentId+':'+item.version+':'+item.chunkIndex" class="candidate">
        <div class="candidate-head"><strong>#{{ item.rank }} · {{ item.title }} · v{{ item.version }}</strong><el-tag size="small" type="success">已返回</el-tag></div>
        <p>{{ item.locationLabel }} · 行 {{ item.lineStart }}–{{ item.lineEnd }} · 标题/正文权重 {{ item.lexicalScore }} · FTS {{ formatScore(item.textRank) }} · Trigram {{ formatScore(item.trigramSimilarity) }}</p>
        <p>匹配：{{ matchLabels(item.matchedBy) }}</p>
        <pre>{{ item.content }}</pre>
        <el-button link @click="openSource(item)">查看授权原文</el-button>
      </article>
    </template>
    <el-dialog v-model="sourceVisible" :title="source?.filename||'授权原文'" width="760px" append-to-body><p v-if="source">v{{ source.version }} · {{ source.status }}</p><pre class="source">{{ source?.content }}</pre></el-dialog>
  </section>
</template>

<script setup lang="ts">
import request, {extractErrorMessage} from '@/utils/request';
const props=defineProps<{baseId:string}>();
const query=ref(''),mode=ref<'current'|'version'>('current'),documentId=ref(''),version=ref<number>(),loading=ref(false),error=ref(''),result=ref<any>(),source=ref<any>(),sourceVisible=ref(false);
const outcome:Record<string,string>={HIT:'已命中',NO_HIT:'无命中',NOT_INDEXED:'未建立可用索引'};
const reasons:Record<string,string>={NOT_INDEXED:'未建立索引',INDEX_VERSION_NOT_READY:'索引版本未就绪',VERSION_NOT_READY:'版本未就绪',INDEX_EMPTY:'索引无分块',CURRENT_INDEXED:'当前索引版本',HISTORY_INDEXED:'历史版本索引'};
async function api(url:string,data?:unknown,method=data?'post':'get'){return(await request({url,method,data})).data;}
async function problem(e:unknown,fallback:string){const code=await extractErrorMessage(e);return ({ResourceNotFound:'无权访问或对象不存在。',DocumentNotFound:'无权访问或文档不存在。',DocumentVersionNotFound:'无权访问或版本不存在。'} as Record<string,string>)[code]||code||fallback;}
async function run(){loading.value=true;error.value='';result.value=undefined;try{const body:any={query:query.value.trim()};if(mode.value==='version'){body.documentId=documentId.value.trim();body.version=version.value;}result.value=await api('/ai/knowledge/'+props.baseId+'/retrieval-diagnostics',body);}catch(e){error.value=await problem(e,'检索诊断失败。');}finally{loading.value=false;}}
async function openSource(item:any){error.value='';try{source.value=await api('/ai/knowledge/documents/'+item.documentId+'/versions/'+item.version);sourceVisible.value=true;}catch(e){error.value=await problem(e,'原文不可访问。');}}
function formatScore(value:unknown){return typeof value==='number'?value.toFixed(4):String(value??'—');}
function matchLabels(value:any){return [['fullText','全文'],['trigram','Trigram'],['termContains','包含']].filter(([key])=>value?.[key]).map(([,label])=>label).join('、')||'—';}
watch(()=>props.baseId,()=>{result.value=undefined;source.value=undefined;sourceVisible.value=false;});
</script>

<style scoped>
.diagnostics{margin-top:20px;border-top:1px solid var(--el-border-color);padding-top:16px}.diagnostics h3{margin:0 0 14px}.summary{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin:12px 0}.candidate{margin-top:12px;padding:14px;border:1px solid var(--el-border-color);border-radius:6px}.candidate-head{display:flex;justify-content:space-between;gap:12px}.candidate p{margin:8px 0;color:var(--el-text-color-secondary);font-size:13px}.candidate pre,.source{white-space:pre-wrap;overflow-wrap:anywhere;max-height:300px;overflow:auto;background:var(--el-fill-color-light);padding:12px}
</style>
