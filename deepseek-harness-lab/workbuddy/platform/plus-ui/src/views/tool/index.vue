<template>
  <div class="p-2 app-container system-tools-page">
    <section class="tools-heading">
      <div>
        <span class="tools-kicker">System Tools</span>
        <h1>系统工具</h1>
        <p>这里只显示当前账号已获授权、已启用的运维工具。</p>
      </div>
    </section>

    <div v-if="availableTools.length" class="tools-grid">
      <button v-for="tool in availableTools" :key="tool.path" class="tool-card" type="button" @click="open(tool.path)">
        <span class="tool-card__icon"><svg-icon :icon-class="tool.icon" /></span>
        <span class="tool-card__body">
          <strong>{{ tool.title }}</strong>
          <small>{{ tool.description }}</small>
        </span>
        <el-icon class="tool-card__arrow"><ArrowRight /></el-icon>
      </button>
    </div>
    <el-empty v-else description="当前账号暂无已启用的系统工具" />
  </div>
</template>

<script setup name="SystemTools" lang="ts">
import auth from '@/plugins/auth';

const router = useRouter();
const tools = [
  { permission: 'monitor:admin:list', title: '服务监控', description: '查看已注册服务的健康、资源与 Actuator 指标。', path: '/monitor/Admin', icon: 'dashboard' },
  { permission: 'monitor:cache:list', title: '缓存监控', description: '查看 Redis 运行状态、内存与命令统计。', path: '/monitor/cache', icon: 'redis' },
  { permission: 'monitor:online:list', title: '在线用户', description: '查看当前登录会话与在线状态。', path: '/monitor/online', icon: 'online' }
];
const availableTools = computed(() => tools.filter(tool => auth.hasPermiOr([tool.permission])));
const open = (path: string) => router.push(path);
</script>

<style lang="scss" scoped>
.system-tools-page { display: grid; gap: 20px; }
.tools-heading { padding: 24px; border: 1px solid var(--app-surface-border); border-radius: 14px; background: var(--app-surface-bg); }
.tools-kicker { display: block; margin-bottom: 8px; color: var(--el-color-primary); font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
.tools-heading h1 { margin: 0 0 8px; color: var(--app-text-title); font-size: 26px; font-weight: 650; }
.tools-heading p { margin: 0; color: var(--app-text-muted); font-size: 13px; line-height: 1.7; }
.tools-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.tool-card { display: flex; align-items: center; gap: 14px; min-height: 112px; padding: 20px; border: 1px solid var(--app-surface-border); border-radius: 14px; background: var(--app-surface-bg); color: inherit; text-align: left; cursor: pointer; transition: border-color .16s ease, transform .16s ease, box-shadow .16s ease; }
.tool-card:hover { border-color: var(--el-color-primary-light-5); box-shadow: var(--app-shadow-sm); transform: translateY(-1px); }
.tool-card:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; }
.tool-card__icon { display: grid; flex: 0 0 42px; height: 42px; place-items: center; border-radius: 12px; background: var(--el-color-primary-light-9); color: var(--el-color-primary); font-size: 20px; }
.tool-card__body { display: grid; min-width: 0; gap: 7px; }
.tool-card__body strong { color: var(--app-text-title); font-size: 16px; font-weight: 650; }
.tool-card__body small { color: var(--app-text-muted); font-size: 12px; line-height: 1.55; }
.tool-card__arrow { margin-left: auto; color: var(--app-text-muted); }
@media (prefers-reduced-motion: reduce) { .tool-card { transition: none; } }
</style>
