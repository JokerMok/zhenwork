<template>
  <div class="p-2 app-container branding-page">
    <div class="branding-heading">
      <div>
        <span class="panel-kicker">Workspace Branding</span>
        <h2>品牌配置</h2>
        <p>维护登录页和工作区使用的基础品牌信息。</p>
      </div>
      <el-tag v-if="pageStatus === 'success'" type="success" effect="plain">已加载</el-tag>
    </div>

    <section v-if="pageStatus === 'loading'" class="state-card">
      <el-skeleton :rows="7" animated />
    </section>

    <section v-else-if="pageStatus === 'empty'" class="state-card state-card--center">
      <el-empty description="暂无品牌配置">
        <el-button type="primary" @click="loadLatest">重新加载</el-button>
      </el-empty>
    </section>

    <section v-else-if="pageStatus === 'error'" class="state-card state-card--center">
      <el-empty :description="brandState.error || '加载品牌配置失败'">
        <el-button type="primary" @click="loadLatest">重新加载</el-button>
      </el-empty>
    </section>

    <el-card v-else-if="brandState.data" shadow="hover" class="branding-card">
      <template #header>
        <div class="card-heading">
          <div>
            <span class="panel-kicker">Brand Settings</span>
            <h3>站点信息</h3>
          </div>
          <span class="version-label">当前版本 v{{ form.version }}</span>
        </div>
      </template>

      <el-alert
        v-if="saveError"
        class="save-alert"
        :title="saveError"
        :type="conflict ? 'warning' : 'error'"
        :closable="false"
        show-icon
      >
        <template v-if="conflict" #default>
          请先重新加载最新配置，确认无误后再保存。
          <el-button link type="warning" @click="loadLatest">重新加载</el-button>
        </template>
      </el-alert>

      <el-form ref="formRef" :model="form" :rules="rules" label-position="top" class="branding-form">
        <div class="form-grid">
          <el-form-item label="产品名称" prop="productName">
            <el-input v-model="form.productName" maxlength="80" show-word-limit placeholder="请输入产品名称" />
          </el-form-item>
          <el-form-item label="公司名称" prop="companyName">
            <el-input v-model="form.companyName" maxlength="100" show-word-limit placeholder="请输入公司名称" />
          </el-form-item>
          <el-form-item label="登录页标题" prop="loginTitle">
            <el-input v-model="form.loginTitle" maxlength="100" show-word-limit placeholder="请输入登录页标题" />
          </el-form-item>
          <el-form-item label="主色" prop="primaryColor">
            <div class="color-field">
              <el-color-picker v-model="form.primaryColor" :predefine="predefineColors" />
              <el-input v-model="form.primaryColor" placeholder="#409EFF" />
            </div>
          </el-form-item>
          <el-form-item label="登录页副标题" prop="loginSubtitle" class="form-grid__wide">
            <el-input
              v-model="form.loginSubtitle"
              type="textarea"
              :rows="3"
              maxlength="300"
              show-word-limit
              placeholder="请输入登录页副标题"
            />
          </el-form-item>
          <el-form-item label="支持信息" prop="supportText">
            <el-input v-model="form.supportText" maxlength="300" show-word-limit placeholder="请输入支持信息" />
          </el-form-item>
          <el-form-item label="版权信息" prop="copyright">
            <el-input v-model="form.copyright" maxlength="200" show-word-limit placeholder="请输入版权信息" />
          </el-form-item>
        </div>

        <div class="asset-section">
          <div class="section-heading">
            <div>
              <h4>品牌资产</h4>
              
            </div>
            
          </div>
          <div class="asset-grid">
            <div class="asset-item">
              <span class="asset-label">企业标志</span>
              <code>{{ form.logoAssetId ? '已设置' : '未设置' }}</code><input type="file" accept="image/png,image/jpeg" aria-label="上传企业标志" :disabled="saving" @change="uploadAsset($event, 'logoAssetId')" /><el-button :disabled="saving" @click="form.logoAssetId=null">清除</el-button>
            </div>
            <div class="asset-item">
              <span class="asset-label">浏览器图标</span>
              <code>{{ form.faviconAssetId ? '已设置' : '未设置' }}</code><input type="file" accept="image/png,image/jpeg" aria-label="上传浏览器图标" :disabled="saving" @change="uploadAsset($event, 'faviconAssetId')" /><el-button :disabled="saving" @click="form.faviconAssetId=null">清除</el-button>
            </div>
          </div>
        </div>

        <div class="form-actions">
          <span class="actions-hint">修改后会生成新版本，其他管理员的更新会触发版本冲突提示。</span>
          <div class="actions-buttons">
            <el-button :disabled="saving" @click="loadLatest">重新加载</el-button>
            <el-button
              v-hasPermi="['ai:brand:admin']"
              type="primary"
              :loading="saving"
              :disabled="saving || conflict"
              @click="handleSave"
            >
              保存配置
            </el-button>
          </div>
        </div>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import request from '@/utils/request';
import type { FormInstance, FormRules } from 'element-plus';
import { computed, onMounted, reactive, ref, watch } from 'vue';
import {
  brandState,
  getBrandErrorMessage,
  isBrandVersionConflict,
  loadBrand,
  updateBrand,
  type BrandConfig,
  type BrandUpdatePayload
} from '@/features/workspace/brand';

defineOptions({ name: 'AiBrandingPage' });

const formRef = ref<FormInstance>();
const saving = ref(false);
const conflict = ref(false);
const saveError = ref('');

const form = reactive<BrandConfig>({
  productName: '',
  companyName: '',
  loginTitle: '',
  loginSubtitle: '',
  primaryColor: '',
  logoAssetId: null,
  faviconAssetId: null,
  supportText: '',
  copyright: '',
  version: 0
});

const predefineColors = ['#409EFF', '#1677FF', '#13C2C2', '#52C41A', '#FA8C16', '#F5222D'];

const rules: FormRules = {
  productName: [{ required: true, message: '产品名称不能为空', trigger: 'blur' }],
  primaryColor: [{ required: true, message: '主色不能为空', trigger: 'change' }]
};

const pageStatus = computed(() => (brandState.status === 'idle' ? 'loading' : brandState.status));

function syncForm(config: BrandConfig | null): void {
  if (!config) {
    return;
  }

  Object.assign(form, config);
  conflict.value = false;
  saveError.value = '';
}

watch(
  () => brandState.data,
  value => {
    if (brandState.status === 'success') {
      syncForm(value);
    }
  }
);

async function loadLatest(): Promise<void> {
  if (saving.value) {
    return;
  }

  conflict.value = false;
  saveError.value = '';
  const latest = await loadBrand({ force: true });
  if (latest) {
    syncForm(latest);
  }
}

async function uploadAsset(event: Event, field: 'logoAssetId' | 'faviconAssetId'): Promise<void> {
  const input=event.target as HTMLInputElement; const file=input.files?.[0]; if(!file)return;
  saving.value=true; saveError.value='';
  try {const data=new FormData();data.set('file',file);const response=await request({url:'/ai/admin/brand/assets',method:'post',headers:{repeatSubmit:false},data});form[field]=response.data.id;ElMessage.success('已上传，保存配置后生效');}
  catch {saveError.value='上传失败。请选择 16–1024 像素、1 MiB 以内的 PNG 或 JPEG 图片。';}
  finally {saving.value=false;input.value='';}
}

async function handleSave(): Promise<void> {
  if (saving.value || conflict.value || !brandState.data) {
    return;
  }

  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) {
    return;
  }

  const current = brandState.data;
  const payload: BrandUpdatePayload = {
    productName: form.productName.trim(),
    companyName: form.companyName.trim(),
    loginTitle: form.loginTitle.trim(),
    loginSubtitle: form.loginSubtitle.trim(),
    primaryColor: form.primaryColor.trim(),
    logoAssetId: form.logoAssetId,
    faviconAssetId: form.faviconAssetId,
    supportText: form.supportText.trim(),
    copyright: form.copyright.trim(),
    expectedVersion: current.version
  };

  saving.value = true;
  saveError.value = '';
  try {
    const saved = await updateBrand(payload);
    syncForm(saved);
    ElMessage.success('品牌配置已保存');
  } catch (error) {
    if (isBrandVersionConflict(error)) {
      conflict.value = true;
      saveError.value = '当前配置已被其他管理员更新，请重新加载最新配置后再保存。';
    } else {
      saveError.value = await getBrandErrorMessage(error, '保存品牌配置失败，请稍后重试');
    }
  } finally {
    saving.value = false;
  }
}

onMounted(async () => {
  const loaded = await loadBrand();
  if (loaded) {
    syncForm(loaded);
  }
});
</script>

<style scoped lang="scss">
.branding-page {
  min-height: calc(100vh - 123px);
  background: var(--app-surface-bg);
}

.branding-heading,
.card-heading,
.section-heading,
.form-actions {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.branding-heading {
  padding: 8px 4px 18px;
}

.branding-heading h2,
.card-heading h3,
.section-heading h4 {
  margin: 0;
  color: var(--app-text-title);
}

.branding-heading h2 {
  font-size: 22px;
}

.branding-heading p,
.section-heading p {
  margin: 6px 0 0;
  color: var(--app-text-muted);
  font-size: 13px;
}

.card-heading h3 {
  font-size: 16px;
}

.version-label {
  color: var(--app-text-muted);
  font-size: 12px;
}

.state-card {
  min-height: 320px;
  padding: 32px;
  border: 1px solid var(--app-surface-border);
  border-radius: var(--app-radius-base);
  background: var(--app-surface-bg);
}

.state-card--center {
  display: grid;
  place-items: center;
}

.branding-card {
  max-width: 1120px;
}

.save-alert {
  margin-bottom: 20px;
}

.branding-form {
  padding: 4px 8px 0;
}

.form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 2px 24px;
}

.form-grid__wide {
  grid-column: 1 / -1;
}

.color-field {
  display: flex;
  align-items: center;
  gap: 10px;
}

.color-field .el-input {
  flex: 1;
}

.asset-section {
  margin-top: 12px;
  padding: 18px;
  border: 1px solid var(--app-surface-border);
  border-radius: 12px;
  background: color-mix(in srgb, var(--app-surface-bg) 86%, var(--el-color-primary-light-9));
}

.asset-section h4 {
  font-size: 14px;
}

.asset-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin-top: 16px;
}

.asset-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.asset-label {
  color: var(--app-text-muted);
  font-size: 12px;
}

.asset-item code {
  overflow: hidden;
  color: var(--app-text-title);
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.form-actions {
  align-items: center;
  margin-top: 24px;
  padding-top: 20px;
  border-top: 1px solid var(--app-surface-border);
}

.actions-hint {
  color: var(--app-text-muted);
  font-size: 12px;
  line-height: 1.5;
}

.actions-buttons {
  display: flex;
  flex-shrink: 0;
  gap: 8px;
}

@media (max-width: 768px) {
  .branding-page {
    min-height: calc(100vh - 88px);
  }

  .form-grid,
  .asset-grid {
    grid-template-columns: 1fr;
  }

  .form-grid__wide {
    grid-column: auto;
  }

  .form-actions {
    align-items: flex-start;
    flex-direction: column;
  }

  .actions-buttons {
    width: 100%;
  }

  .actions-buttons .el-button {
    flex: 1;
  }
}
</style>
