<template>
  <div class="p-2 app-container monitor-page">
    <div class="monitor-page__inner">
      <iframe
        v-if="frameSrc"
        :key="attempt"
        class="monitor-page__frame"
        :class="{ 'is-ready': phase === 'ready' }"
        :src="frameSrc"
        title="ZhenWork 服务监控"
        @load="onFrameLoad"
        @error="onFrameError"
      />
      <div v-if="phase !== 'ready'" v-loading="phase === 'checking' || phase === 'loading'" class="monitor-page__status">
        <el-result v-if="phase === 'error'" icon="error" title="服务监控加载失败" :sub-title="errorMessage">
          <template #extra>
            <el-button type="primary" @click="loadMonitor">重试</el-button>
          </template>
        </el-result>
        <p v-else>{{ phase === 'checking' ? '正在校验监控权限与服务状态…' : '正在加载实时服务状态…' }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
type Phase = 'checking' | 'loading' | 'ready' | 'error';

const monitorUrl = String(import.meta.env.VITE_APP_MONITOR_ADMIN || '/monitor/').replace(/\/*$/, '/');
const phase = ref<Phase>('checking');
const frameSrc = ref('');
const errorMessage = ref('');
const attempt = ref(0);
let frameTimer: ReturnType<typeof setTimeout> | undefined;
let probeController: AbortController | undefined;
let loadGeneration = 0;

function clearPending() {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = undefined;
  probeController?.abort();
  probeController = undefined;
}

function fail(message: string) {
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = undefined;
  phase.value = 'error';
  errorMessage.value = message;
}

function probeError(status: number) {
  if (status === 401 || status === 403) return '当前登录已失效或账号没有服务监控权限。';
  if (status === 502 || status === 503 || status === 504) return '监控服务尚未就绪，请稍后重试。';
  return `监控服务探测失败（HTTP ${status}）。`;
}

async function loadMonitor() {
  clearPending();
  const generation = ++loadGeneration;
  attempt.value += 1;
  frameSrc.value = '';
  errorMessage.value = '';
  phase.value = 'checking';
  const controller = new AbortController();
  probeController = controller;
  const probeTimer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${monitorUrl}?probe=${Date.now()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'follow',
      signal: controller.signal
    });
    if (generation !== loadGeneration) return;
    if (!response.ok) {
      fail(probeError(response.status));
      return;
    }
    if (new URL(response.url, window.location.href).pathname.endsWith('/login')) {
      fail('监控鉴权未生效，请刷新登录状态后重试。');
      return;
    }
    phase.value = 'loading';
    frameSrc.value = monitorUrl;
    frameTimer = setTimeout(() => {
      if (generation === loadGeneration) fail('监控服务页面加载超时，请重试。');
    }, 15000);
  } catch (error) {
    if (generation !== loadGeneration) return;
    fail(error instanceof DOMException && error.name === 'AbortError'
      ? '监控服务探测超时，请稍后重试。'
      : '无法连接监控服务，请检查服务状态后重试。');
  } finally {
    clearTimeout(probeTimer);
    if (probeController === controller) probeController = undefined;
  }
}

function onFrameLoad() {
  if (phase.value !== 'loading') return;
  if (frameTimer) clearTimeout(frameTimer);
  frameTimer = undefined;
  phase.value = 'ready';
}

function onFrameError() {
  fail('监控服务页面加载失败，请重试。');
}

onMounted(loadMonitor);
onBeforeUnmount(() => {
  loadGeneration += 1;
  clearPending();
});
</script>

<style lang="scss" scoped>
.monitor-page__inner { position: relative; overflow: hidden; min-height: calc(100vh - 126px); border-radius: 14px; background: var(--app-surface-bg); box-shadow: var(--app-shadow-sm); }
.monitor-page__frame { display: block; width: 100%; height: calc(100vh - 126px); border: 0; opacity: 0; }
.monitor-page__frame.is-ready { opacity: 1; }
.monitor-page__status { position: absolute; inset: 0; display: grid; min-height: 360px; place-items: center; color: var(--app-text-muted); background: var(--app-surface-bg); }
.monitor-page__status p { margin: 0; font-size: 14px; }
@media (max-width: 768px) {
  .monitor-page__inner, .monitor-page__frame { min-height: calc(100vh - 92px); height: calc(100vh - 92px); }
}
</style>
