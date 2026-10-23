<template>
  <div class="usage-home">
    <header class="usage-heading">
      <div><h1>用户使用统计</h1><p>查看用户的模型调用与用量</p></div>
      <div class="usage-actions" v-if="canView">
        <el-radio-group v-model="days" @change="load">
          <el-radio-button :value="7">近7天</el-radio-button>
          <el-radio-button :value="30">近30天</el-radio-button>
          <el-radio-button :value="90">近90天</el-radio-button>
        </el-radio-group>
        <el-button :loading="loading" @click="load">刷新</el-button>
      </div>
    </header>
    <el-empty v-if="!canView" description="当前账号无权查看使用统计" />
    <template v-else>
      <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" />
      <el-skeleton v-if="!data && loading" :rows="8" animated />
      <el-empty v-else-if="!data && !error" description="暂无可显示的使用统计" />
      <template v-if="data">
        <section class="usage-overview" v-loading="loading" aria-label="使用概况">
          <dl class="usage-summary">
            <div><dt>启用用户</dt><dd>{{ number(data.summary.enabledUsers) }}<small>人</small></dd></div>
            <div><dt>期间活跃用户</dt><dd>{{ number(data.summary.activeUsers) }}<small>人</small></dd></div>
            <div><dt>模型调用</dt><dd>{{ number(data.summary.requests) }}<small>次</small></dd></div>
            <div><dt>已报告 Token</dt><dd>{{ data.summary.reportedRequests ? number(data.summary.inputTokens + data.summary.outputTokens) : '—' }}</dd></div>
          </dl>
          <div class="usage-status">
            <span>完成 <b>{{ number(data.summary.completed) }}</b></span>
            <span>失败 <b>{{ number(data.summary.failed) }}</b></span>
            <span>已取消 <b>{{ number(data.summary.cancelled) }}</b></span>
            <span>进行中 <b>{{ number(data.summary.inflight) }}</b></span>
            <span>回执未完成 <b>{{ number(data.summary.incomplete) }}</b></span>
          </div>
        </section>
        <section class="usage-section" v-loading="loading">
          <div class="usage-section-heading"><h2>每日模型调用</h2><span>{{ data.period.from }} — {{ data.period.to }} · 北京时间</span></div>
          <div v-if="data.summary.requests" class="usage-chart">
            <svg viewBox="0 0 1000 214" role="img" aria-label="每日模型调用次数趋势">
              <g v-for="tick in [0, 1, 2]" :key="tick">
                <line x1="45" x2="985" :y1="170 - tick * 75" :y2="170 - tick * 75" class="chart-line" />
                <text x="35" :y="174 - tick * 75" text-anchor="end" class="chart-label">{{ number(Math.round(chartMax * tick / 2)) }}</text>
              </g>
              <g v-for="(day, index) in data.daily" :key="day.day">
                <rect :x="50 + index * barStep" :y="170 - 150 * day.requests / chartMax" :width="Math.max(2, barStep * .6)" :height="150 * day.requests / chartMax" rx="2" class="chart-bar">
                  <title>{{ day.day }}：{{ day.requests }}次调用</title>
                </rect>
                <text v-if="index % Math.max(1, Math.ceil(data.daily.length / 7)) === 0 || index === data.daily.length - 1" :x="50 + index * barStep + barStep * .3" y="198" text-anchor="middle" class="chart-label">{{ day.day.slice(5) }}</text>
              </g>
            </svg>
          </div>
          <el-empty v-else description="这段时间暂无模型调用" :image-size="72" />
          <details v-if="data.summary.requests" class="usage-details">
            <summary>查看每日明细</summary>
            <el-table :data="data.daily" size="small" max-height="320">
              <el-table-column prop="day" label="日期" min-width="120" />
              <el-table-column prop="requests" label="模型调用" align="right" />
              <el-table-column prop="completed" label="完成" align="right" />
              <el-table-column prop="failed" label="失败" align="right" />
              <el-table-column prop="cancelled" label="取消" align="right" />
            </el-table>
          </details>
        </section>
        <section class="usage-section" v-loading="loading">
          <div class="usage-section-heading"><h2>用户使用明细</h2><span>按模型调用次数排序</span></div>
          <el-table :data="data.users" empty-text="这段时间暂无用户使用记录" table-layout="auto">
            <el-table-column prop="nickName" label="用户" min-width="140" />
            <el-table-column prop="requests" label="模型调用" min-width="100" align="right" />
            <el-table-column prop="completed" label="完成" min-width="80" align="right" />
            <el-table-column prop="failed" label="失败" min-width="80" align="right" />
            <el-table-column label="已报告输入 Token" min-width="165" align="right"><template #default="{ row }">{{ row.requests === row.unknownTokenRequests ? '—' : number(row.inputTokens) }}</template></el-table-column>
            <el-table-column label="已报告输出 Token" min-width="165" align="right"><template #default="{ row }">{{ row.requests === row.unknownTokenRequests ? '—' : number(row.outputTokens) }}</template></el-table-column>
            <el-table-column prop="unknownTokenRequests" label="用量未报告" min-width="115" align="right" />
            <el-table-column label="最近使用" min-width="175"><template #default="{ row }">{{ dateTime(row.lastUsedAt) }}</template></el-table-column>
          </el-table>
          <p class="usage-note">展示调用最多的前100位用户。活跃用户指期间发起过模型调用的用户；一次办公任务可能调用模型多次。</p>
        </section>
        <footer class="usage-notes">
          <p>模型调用统计来自工作台模型中继回执，与外部数据连接是否配置无关。</p>
          <p>Token 仅累计供应商已返回的用量，另有 {{ number(data.summary.unknownTokenRequests) }} 次调用未报告用量，不按零计算。另有 {{ number(data.summary.unknownCostRequests) }} 次调用未报告可核对费用，本页不做费用估算。</p>
          <p>最近更新 {{ updatedAt }} · 数据范围 {{ data.period.from }} 至 {{ data.period.to }}</p>
        </footer>
      </template>
      <el-button v-if="error" class="usage-retry" @click="load">重新读取</el-button>
    </template>
  </div>
</template>

<script setup name="Index" lang="ts">
import request, { extractErrorMessage } from '@/utils/request';
import auth from '@/plugins/auth';

type UsageCounts = { requests: number; completed: number; failed: number; cancelled: number; inputTokens: number; outputTokens: number };
interface Dashboard {
  period: { from: string; to: string; timezone: string };
  summary: UsageCounts & { enabledUsers: number; activeUsers: number; inflight: number; incomplete: number; reportedRequests: number; unknownTokenRequests: number; unknownCostRequests: number };
  daily: (UsageCounts & { day: string })[];
  users: (UsageCounts & { userId: string; nickName: string; unknownTokenRequests: number; lastUsedAt: string })[];
}
const canView = computed(() => auth.hasPermiOr(['ai:audit:view']));
const days = ref(7);
const data = ref<Dashboard>();
const loading = ref(false);
const error = ref('');
const updatedAt = ref('');
let generation = 0;
let activeController: AbortController | undefined;
const number = (value: number) => new Intl.NumberFormat('zh-CN').format(value);
const dateTime = (value: string) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(value)) : '—';
const chartMax = computed(() => Math.max(2, Math.ceil(Math.max(0, ...(data.value?.daily.map(day => day.requests) || [])) / 2) * 2));
const barStep = computed(() => 930 / Math.max(1, data.value?.daily.length || 1));
async function load() {
  if (!canView.value) return;
  const current = ++generation;
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  loading.value = true; error.value = '';
  try {
    const result = await request({ url: '/ai/admin/dashboard', params: { days: days.value }, signal: controller.signal, timeout: 15000 });
    if (current !== generation) return;
    if (!result?.data?.period || !result?.data?.summary || !Array.isArray(result?.data?.daily) || !Array.isArray(result?.data?.users)) throw new Error('使用统计返回格式不完整');
    data.value = result.data as Dashboard;
    updatedAt.value = dateTime(new Date().toISOString());
  } catch (cause: any) {
    if (current !== generation) return;
    const message = await extractErrorMessage(cause);
    if (current !== generation) return;
    if (cause?.code === 'ERR_CANCELED') error.value = '使用统计读取已取消，请重新读取。';
    else if (cause?.code === 'ETIMEDOUT' || cause?.code === 'ECONNABORTED' || message?.includes('超时')) error.value = '使用统计读取超时，请重新读取。';
    else error.value = message ? `使用统计读取失败：${message}` : '使用统计读取失败，请重新读取。';
  } finally {
    if (current === generation) { activeController = undefined; loading.value = false; }
  }
}
onMounted(load);
onBeforeUnmount(() => { generation++; activeController?.abort(); activeController = undefined; loading.value = false; });
</script>

<style lang="scss" scoped>
.usage-home, .usage-section, .usage-overview { min-width: 0; }
.usage-home { display: grid; gap: 20px; color: var(--app-text-title); font-variant-numeric: tabular-nums; }
.usage-heading, .usage-section-heading { display: flex; align-items: center; justify-content: space-between; gap: 20px; }
.usage-heading h1 { margin: 0 0 8px; font-size: 26px; line-height: 1.35; font-weight: 650; }
.usage-heading p, .usage-notes p, .usage-note { color: var(--app-text-muted); font-size: 13px; line-height: 1.7; margin: 0; }
.usage-actions { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.usage-overview, .usage-section { background: var(--app-surface-bg); border: 1px solid var(--app-surface-border); border-radius: 14px; padding: 24px; }
.usage-summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 24px; margin: 0; }
.usage-summary dt { font-size: 13px; color: var(--app-text-muted); margin-bottom: 10px; }
.usage-summary dd { margin: 0; font-size: clamp(24px, 2.5vw, 32px); font-weight: 650; line-height: 1.3; overflow-wrap: anywhere; }
.usage-summary small { font-size: 13px; font-weight: 400; color: var(--app-text-muted); margin-left: 8px; }
.usage-status { display: flex; flex-wrap: wrap; gap: 12px 28px; border-top: 1px solid var(--app-surface-border); margin-top: 22px; padding-top: 18px; font-size: 13px; color: var(--app-text-muted); }
.usage-status b { margin-left: 6px; color: var(--app-text-title); font-weight: 600; }
.usage-section-heading { margin-bottom: 22px; }
.usage-section h2 { margin: 0; font-size: 17px; font-weight: 650; }
.usage-section-heading > span { font-size: 12px; color: var(--app-text-muted); }
.usage-chart svg { width: 100%; min-height: 150px; display: block; }
.chart-line { stroke: var(--app-surface-border); stroke-width: 1; }
.chart-label { fill: var(--app-text-muted); font-size: 12px; }
.chart-bar { fill: var(--el-color-primary); }
.usage-details { margin-top: 12px; }
.usage-details summary { color: var(--el-color-primary); cursor: pointer; font-size: 13px; padding: 8px 0; }
.usage-details summary:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.usage-note { margin-top: 18px; }
.usage-notes { display: grid; gap: 6px; }
.usage-retry { justify-self: start; }
@media (max-width: 860px) {
  .usage-heading, .usage-section-heading { align-items: flex-start; flex-direction: column; gap: 12px; }
  .usage-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 22px; }
  .usage-overview, .usage-section { padding: 18px; }
}
@media (prefers-reduced-motion: reduce) { .usage-home * { transition: none !important; } }
</style>
