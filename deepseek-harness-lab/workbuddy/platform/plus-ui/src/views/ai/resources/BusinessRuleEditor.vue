<template>
  <el-form-item label="指标含义" required><el-input v-model="rule.meaning" maxlength="1000" placeholder="例如：按业务日期、产生节点汇总有效记录的重量" /></el-form-item>
  <el-form-item label="适用业务及数据范围" required><el-input v-model="rule.scope" maxlength="1000" /></el-form-item>
  <el-form-item label="统计节点" required><el-select v-model="rule.includeNodes" multiple><el-option v-for="value in nodeValues" :key="value" :value="value" /></el-select></el-form-item>
  <el-form-item label="重复编号"><el-select v-model="rule.duplicateRule"><el-option value="identical_first" label="同编号同内容保留首条；内容冲突阻断" /><el-option value="block" label="发现重复即阻断" /></el-select></el-form-item>
  <el-form-item label="重量小数位"><el-input-number v-model="rule.precision" :min="0" :max="6" /></el-form-item>
  <el-alert title="记录粒度为业务编号，统计按业务日期的自然月（上海时区）。逐条换算 kg 并四舍五入后汇总；合计/重复表头明确排除，负数、冲销及未知对象阻断。" type="info" :closable="false" class="mb-3" />
  <el-form-item v-for="item in maps" :key="item.key" :label="item.label" :required="item.required">
    <el-input :model-value="text(item.key)" type="textarea" :rows="3" :placeholder="item.placeholder" @change="update(item.key,$event)" />
  </el-form-item>
  <el-form-item label="允许的业务单位"><el-select v-model="rule.allowedOrganizations" multiple clearable><el-option v-for="value in orgValues" :key="value" :value="value" /></el-select><div class="text-gray-500">留空表示仅按当前员工已授权的输入文件；选择后，逐行校验业务单位字段，范围之外阻断。</div></el-form-item>
  <el-alert v-if="error" :title="error" type="error" :closable="false" />
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
type Rule={kind:string;meaning:string;scope:string;grain:string;timeField:string;period:string;duplicateRule:string;precision:number;unitFactors:Record<string,string>;nodeAliases:Record<string,string>;sourceAliases:Record<string,string>;categoryAliases:Record<string,string>;organizationAliases:Record<string,string>;statusAliases:Record<string,string>;includeNodes:string[];allowedOrganizations:string[];summaryRows:string;reversal:string;negative:string};
const emit=defineEmits<{valid:[value:boolean]}>();
const rule=defineModel<Rule>({required:true});const error=ref('');
const maps=[{key:'unitFactors',label:'单位 → kg 换算系数',required:true,placeholder:'kg=1\n吨=1000'},{key:'nodeAliases',label:'业务节点映射',required:true,placeholder:'原始值=规范名称'},{key:'sourceAliases',label:'部门/车间映射',required:true,placeholder:'原始值=规范名称'},{key:'categoryAliases',label:'废物类别映射',required:true,placeholder:'原始值=规范类别'},{key:'organizationAliases',label:'业务单位映射',required:false,placeholder:'原始值=规范单位'},{key:'statusAliases',label:'记录状态映射',required:false,placeholder:'有效=active\n撤销=cancelled\n冲销=reversal'}];
const nodeValues=computed(()=>[...new Set(Object.values(rule.value.nodeAliases))]);const orgValues=computed(()=>[...new Set(Object.values(rule.value.organizationAliases))]);
function text(key:string){return Object.entries(rule.value[key as keyof Rule] as Record<string,string>).map(([k,v])=>k+'='+v).join('\n');}
function update(key:string,value:string){try{const entries=value.split(/\r?\n/).filter(x=>x.trim()).map(line=>{const at=line.indexOf('=');if(at<1||!line.slice(at+1).trim())throw new Error('每行填写「原始值=目标值」，名称不能重复。');return [line.slice(0,at).trim(),line.slice(at+1).trim()];});if(new Set(entries.map(x=>x[0])).size!==entries.length)throw new Error('映射名称重复。');Object.assign(rule.value,{[key]:Object.fromEntries(entries)});error.value='';emit('valid',true);}catch(e){error.value=(e as Error).message;emit('valid',false);}}
</script>
