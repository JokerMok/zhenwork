<template><div class="app-container p-4"><h2>工具类型</h2><p>员工可以创建和绑定这里已允许的工具。停用类型会终止相关任务。</p><el-alert v-if="error" :title="error" type="error" :closable="false"/><el-table v-loading="loading" :data="rows"><el-table-column prop="name" label="工具类型"/><el-table-column label="执行方式"><template #default="{row}">{{row.requires_approval?'员工确认后生成文件':'按明确参数直接计算'}}</template></el-table-column><el-table-column label="允许使用"><template #default="{row}"><el-switch :model-value="row.enabled" :loading="busy===row.code" :aria-label="row.name" @change="toggle(row as Row)"/></template></el-table-column></el-table><el-alert title="当前支持精确计算和文本文件生成。不提供 Shell、任意脚本、数据库写入或自定义外部请求。" type="info" :closable="false"/></div></template>
<script setup lang="ts">
import request from '@/utils/request';
import type {AxiosPromise} from '@/utils/api-types';
type Row={code:string;name:string;enabled:boolean;requires_approval:boolean;version:number};
const rows=ref<Row[]>([]),loading=ref(false),error=ref(''),busy=ref('');
async function load(){loading.value=true;try{rows.value=(await(request({url:'/ai/admin/tool-types',method:'get'}) as AxiosPromise<Row[]>)).data;}catch{error.value='加载失败，请刷新重试。';}finally{loading.value=false;}}
async function toggle(row:Row){try{await ElMessageBox.confirm((row.enabled?'停用':'启用')+'“'+row.name+'”将取消正在使用该类型的任务。确认继续？','变更工具类型');}catch{return;}busy.value=row.code;try{await request({url:'/ai/admin/tool-types/'+row.code,method:'put',data:{enabled:!row.enabled,expectedVersion:row.version}});await load();ElMessage.success('工具类型已更新');}catch{error.value='更新失败，配置可能已被修改，请刷新重试。';}finally{busy.value='';}}
onMounted(load);
</script>
