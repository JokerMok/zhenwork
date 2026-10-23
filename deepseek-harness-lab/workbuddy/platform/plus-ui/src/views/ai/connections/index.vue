<template>
  <div class="app-container p-4 external-connections">
    <div class="page-heading">
      <div>
        <h2>外部数据连接</h2>
        <p>集中配置优废看板和国家危险废物平台连接。凭据仅写入服务端，不会在页面、接口响应或浏览器存储中回显。</p>
      </div>
      <div class="heading-actions">
        <el-button :loading="loading" @click="load">刷新</el-button>
        <el-button type="primary" :disabled="loading || !catalog.length" @click="openEditor()">新建连接</el-button>
      </div>
    </div>

    <el-alert v-if="error" :title="error" type="error" :closable="false" class="mb-3" />
    <el-table v-loading="loading" :data="rows" row-key="id" empty-text="尚未配置外部业务连接">
      <el-table-column prop="name" label="连接名称" min-width="150" />
      <el-table-column label="连接器" min-width="160">
        <template #default="{ row }">{{ connectorName(row.type) }}</template>
      </el-table-column>
      <el-table-column prop="businessUnit" label="业务单位" min-width="150" show-overflow-tooltip />
      <el-table-column label="环境" width="100">
        <template #default="{ row }">
          <el-tag :type="row.environment === 'PRODUCTION' ? 'danger' : 'info'">
            {{ environmentName(row.environment) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="允许查询" min-width="170">
        <template #default="{ row }">{{ methodSummary(connectionRow(row)) }}</template>
      </el-table-column>
      <el-table-column label="验证" min-width="130">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.testedStatus)">{{ statusName(row.testedStatus) }}</el-tag>
          <div v-if="row.testedAt" class="subtle">{{ formatTime(row.testedAt) }}</div>
          <div v-if="row.lastError" class="connection-error">{{ connectionError(row.lastError) }}</div>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="100">
        <template #default="{ row }">{{ row.enabled ? '已启用' : '已停用' }}</template>
      </el-table-column>
      <el-table-column label="操作" min-width="350" fixed="right">
        <template #default="{ row }">
          <el-button link @click="openDetails(connectionRow(row))">详情</el-button>
          <el-button link @click="openEditor(connectionRow(row))">编辑</el-button>
          <el-button link :loading="rowBusy === row.id + ':verify'" @click="verify(connectionRow(row))">验证</el-button>
          <el-button link :disabled="!isReady(connectionRow(row))" @click="openExpert(connectionRow(row))">
            {{ row.assistantId ? '配置查询专家' : '创建查询专家' }}
          </el-button>
          <el-button link :disabled="!row.resourceId" @click="openShares(connectionRow(row))">共享</el-button>
          <el-button link @click="openCalls(connectionRow(row))">调用审计</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog
      v-model="editorVisible"
      :title="editing ? '编辑外部连接' : '新建外部连接'"
      width="820px"
      destroy-on-close
    >
      <el-alert v-if="dialogError" :title="dialogError" type="error" :closable="false" class="mb-3" />
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="连接名称" required>
            <el-input v-model="form.name" maxlength="100" placeholder="例如：华南区固废生产查询" />
          </el-form-item>
          <el-form-item label="连接器" required>
            <el-select v-model="form.type" :disabled="!!editing" @change="connectorChanged">
              <el-option v-for="item in catalog" :key="item.type" :label="item.displayName" :value="item.type" />
            </el-select>
          </el-form-item>
          <el-form-item label="业务单位" required>
            <el-input v-model="form.businessUnit" maxlength="120" placeholder="用于标识此连接服务的业务单位" />
          </el-form-item>
          <el-form-item label="环境" required>
            <el-select v-model="form.environment" @change="environmentChanged">
              <el-option
                v-for="item in currentConnector?.environments || []"
                :key="item.name"
                :label="environmentName(item.name)"
                :value="item.name"
              />
            </el-select>
          </el-form-item>
        </div>
        <el-form-item label="服务地址" required>
          <el-input v-model="form.baseUrl" placeholder="https://" />
          <div class="field-help">仅接受连接器目录中已确认的环境地址；尚未确认的正式地址不会猜测开放。</div>
        </el-form-item>
        <el-form-item :label="editing ? '更新访问凭据' : '访问凭据'">
          <el-input
            v-model="form.credential"
            type="password"
            autocomplete="new-password"
            show-password
            :disabled="form.clearCredential"
            :placeholder="
              editing && editing.credentialConfigured ? '留空保留已保存凭据' : '可稍后填写；无凭据时验证会明确失败'
            "
          />
          <div v-if="editing?.credentialConfigured" class="field-help">服务端已有凭据。页面不会读取或回显原值。</div>
          <el-checkbox
            v-if="editing?.credentialConfigured"
            v-model="form.clearCredential"
            @change="clearCredentialChanged"
          >
            显式清除已保存凭据并停用连接
          </el-checkbox>
        </el-form-item>

        <el-form-item label="允许的固定查询方法">
          <el-checkbox-group v-model="form.allowedMethods" class="method-list">
            <label
              v-for="method in currentConnector?.methods || []"
              :key="method.name"
              class="method-option"
              :class="{ disabled: !methodAvailable(method) }"
            >
              <el-checkbox :value="method.name" :disabled="!methodAvailable(method)">
                {{ method.title || method.name }}
                <el-tag v-if="methodAvailable(method)" size="small" type="success">只读可用</el-tag>
                <el-tag v-else size="small" type="info">暂不可用</el-tag>
              </el-checkbox>
              <span class="method-path">{{ method.path }}</span>
              <span v-if="method.timeSemantics">时间口径：{{ method.timeSemantics }}</span>
              <span v-if="method.unit">返回单位：{{ method.unit }}</span>
              <span v-if="method.environmentNotes">使用限制：{{ method.environmentNotes }}</span>
              <span v-if="method.safeCause">安全依据：{{ method.safeCause }}</span>
              <span v-if="!methodAvailable(method)">
                不可用原因：{{ method.unavailableReason || method.environmentNotes || '尚未完成接口能力验证' }}
              </span>
            </label>
          </el-checkbox-group>
          <el-empty
            v-if="currentConnector && !currentConnector.methods.length"
            description="连接器目录没有可授权的查询方法"
            :image-size="60"
          />
          <el-alert
            v-else-if="currentConnector && !currentConnector.methods.some(methodAvailable)"
            title="这些方法尚未完成接口契约验证，仅用于说明计划接入范围，当前不能授权调用。可以先保存连接配置。"
            type="warning"
            :closable="false"
          />
        </el-form-item>
        <el-form-item label="连接状态">
          <el-switch v-model="form.enabled" active-text="启用" inactive-text="停用" :disabled="form.clearCredential" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editorVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存连接</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="detailsVisible" title="连接详情" width="720px">
      <template v-if="selected">
        <el-alert
          v-if="selected.lastError"
          :title="`最近验证失败：${connectionError(selected.lastError)}`"
          type="error"
          :closable="false"
          class="mb-3"
        />
        <el-alert
          v-if="identityMismatch(selected)"
          title="配置的业务单位与接口验证返回的企业名称不一致，请核对是否连接了正确企业。"
          type="warning"
          :closable="false"
          class="mb-3"
        />
        <el-descriptions :column="1" border>
          <el-descriptions-item label="连接">
            {{ selected.name }} · {{ connectorName(selected.type) }}
          </el-descriptions-item>
          <el-descriptions-item label="业务单位">{{ selected.businessUnit }}</el-descriptions-item>
          <el-descriptions-item label="服务地址">{{ selected.baseUrl }}</el-descriptions-item>
          <el-descriptions-item label="凭据">
            {{ selected.credentialConfigured ? '已在服务端配置' : '未配置' }}
          </el-descriptions-item>
          <el-descriptions-item label="版本">v{{ selected.version }}</el-descriptions-item>
          <el-descriptions-item label="最近验证">
            {{ formatTime(selected.testedAt) || '尚未验证' }}
          </el-descriptions-item>
          <el-descriptions-item label="最近更新">{{ formatTime(selected.updatedAt) || '—' }}</el-descriptions-item>
        </el-descriptions>
        <h4>接口验证身份</h4>
        <el-empty
          v-if="!identity(selected)"
          :description="
            selected.verifiedIdentity === true
              ? '验证已通过，但服务端未返回可展示的企业身份字段'
              : '尚未取得接口验证身份'
          "
          :image-size="70"
        />
        <el-descriptions v-else :column="1" border>
          <el-descriptions-item label="企业 ID">{{ identity(selected)?.enterpriseId || '—' }}</el-descriptions-item>
          <el-descriptions-item label="企业名称">{{ identity(selected)?.name || '—' }}</el-descriptions-item>
          <el-descriptions-item label="统一社会信用代码">
            {{ identity(selected)?.creditCode || '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="验证时间">
            {{ formatTime(identity(selected)?.verifiedAt) || '—' }}
          </el-descriptions-item>
        </el-descriptions>
      </template>
    </el-dialog>

    <el-dialog v-model="expertVisible" title="配置跨系统查询专家" width="760px">
      <el-alert v-if="dialogError" :title="dialogError" type="error" :closable="false" class="mb-3" />
      <el-alert
        title="只会绑定本次明确勾选的连接。后续调整也不会自动加入其它业务单位。"
        type="info"
        :closable="false"
        class="mb-3"
      />
      <p>选择查询专家可使用的已启用、已验证连接（最多 8 个）：</p>
      <el-checkbox-group v-model="expertConnectionIds" class="expert-list">
        <label v-for="connection in readyConnections" :key="connection.id" class="expert-option">
          <el-checkbox :value="connection.id" :disabled="connection.id === expertPrimary?.id">
            {{ connection.name }}
          </el-checkbox>
          <span>
            {{ connectorName(connection.type) }} · {{ connection.businessUnit }} ·
            {{ environmentName(connection.environment) }}
          </span>
        </label>
      </el-checkbox-group>
      <el-empty v-if="!readyConnections.length" description="没有可绑定的已验证连接" :image-size="70" />
      <template #footer>
        <el-button @click="expertVisible = false">取消</el-button>
        <el-button
          type="primary"
          :disabled="!expertConnectionIds.length || expertConnectionIds.length > 8"
          :loading="rowBusy.endsWith(':expert')"
          @click="saveExpert"
        >
          {{ expertPrimary?.assistantId ? '更新专家绑定' : '创建查询专家' }}
        </el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="sharesVisible" title="查询专家共享" width="760px">
      <el-alert v-if="dialogError" :title="dialogError" type="error" :closable="false" class="mb-3" />
      <el-alert :title="shareDescription" type="info" :closable="false" class="mb-3" />
      <template v-if="selected?.resourceId">
        <div class="share-controls">
          <el-select v-model="targetType" aria-label="共享对象类型" @change="targetChanged">
            <el-option label="员工" value="USER" />
            <el-option label="角色" value="ROLE" />
            <el-option label="部门" value="DEPARTMENT" />
          </el-select>
          <el-input v-model="targetQuery" placeholder="至少输入两个字符" @keyup.enter="findTargets" />
          <el-button :disabled="targetQuery.trim().length < 2" :loading="shareBusy" @click="findTargets">
            查找
          </el-button>
        </div>
        <el-select v-model="targetId" class="target-select" placeholder="选择共享对象">
          <el-option v-for="item in targets" :key="item.id" :label="`${item.name} · ${item.id}`" :value="item.id" />
        </el-select>
        <el-button type="primary" :disabled="!targetId" :loading="shareBusy" @click="grantShare">
          {{ selected.assistantId ? '授权全部绑定连接与查询专家' : '授权此连接' }}
        </el-button>
        <el-table v-loading="shareBusy" :data="shareRows" empty-text="当前资源尚未共享">
          <el-table-column prop="resourceLabel" label="授权资源" min-width="130" />
          <el-table-column prop="name" label="对象" min-width="160" />
          <el-table-column prop="subjectType" label="类型" width="110" />
          <el-table-column label="权限" min-width="150">
            <template #default="{ row }">{{ actionsText(row.actions) }}</template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column label="操作" width="90">
            <template #default="{ row }">
              <el-button v-if="row.status === 'ACTIVE'" link type="danger" @click="revokeShare(row.id, row.resourceId)">
                撤回
              </el-button>
            </template>
          </el-table-column>
        </el-table>
      </template>
      <el-empty v-else description="此连接尚未生成可共享资源" :image-size="70" />
    </el-dialog>

    <el-dialog v-model="callsVisible" title="外部调用审计" width="880px">
      <el-alert v-if="dialogError" :title="dialogError" type="error" :closable="false" class="mb-3" />
      <p v-if="selected">{{ selected.name }} · 仅展示调用元数据，不展示访问凭据或接口原始响应。</p>
      <el-table v-loading="callsLoading" :data="calls" empty-text="暂无外部调用记录">
        <el-table-column prop="businessUnit" label="业务单位" min-width="140" />
        <el-table-column prop="method" label="查询方法" min-width="160" />
        <el-table-column prop="status" label="结果" width="110" />
        <el-table-column prop="errorCode" label="失败原因" min-width="150" />
        <el-table-column label="耗时" width="110">
          <template #default="{ row }">{{ durationText(callRow(row)) }}</template>
        </el-table-column>
        <el-table-column label="连接版本" width="100">
          <template #default="{ row }">v{{ row.connectionVersion ?? '—' }}</template>
        </el-table-column>
        <el-table-column prop="actorUserId" label="调用人 ID" min-width="120" />
        <el-table-column label="时间" min-width="170">
          <template #default="{ row }">{{ formatTime(row.createdAt) || '—' }}</template>
        </el-table-column>
      </el-table>
      <div class="pagination-row">
        <el-button
          :disabled="callsPage === 1 || callsLoading"
          @click="
            callsPage--;
            loadCalls();
          "
        >
          上一页
        </el-button>
        <span>第 {{ callsPage }} 页</span>
        <el-button
          :disabled="calls.length < 30 || callsLoading"
          @click="
            callsPage++;
            loadCalls();
          "
        >
          下一页
        </el-button>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  connectionApi,
  type ConnectionCall,
  type ConnectionEnvironment,
  type ConnectionInput,
  type ConnectorCatalog,
  type ConnectorType,
  type ExternalConnection
} from '@/api/ai/connections';
import request, { extractErrorMessage } from '@/utils/request';

type ShareRow = {
  id: string;
  name?: string;
  subjectType?: string;
  subjectId?: string;
  actions?: string[] | string;
  status?: string;
  resourceId?: string;
  resourceLabel?: string;
};
type ShareTarget = { id: string; name: string };
type FormState = {
  type: ConnectorType;
  name: string;
  businessUnit: string;
  environment: ConnectionEnvironment;
  baseUrl: string;
  credential: string;
  clearCredential: boolean;
  allowedMethods: string[];
  enabled: boolean;
};

const rows = ref<ExternalConnection[]>([]);
const catalog = ref<ConnectorCatalog[]>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const dialogError = ref('');
const rowBusy = ref('');
const editorVisible = ref(false);
const detailsVisible = ref(false);
const sharesVisible = ref(false);
const callsVisible = ref(false);
const expertVisible = ref(false);
const editing = ref<ExternalConnection>();
const selected = ref<ExternalConnection>();
const form = ref<FormState>(emptyForm());

const shareRows = ref<ShareRow[]>([]);
const targetType = ref<'USER' | 'ROLE' | 'DEPARTMENT'>('USER');
const targetQuery = ref('');
const targets = ref<ShareTarget[]>([]);
const targetId = ref('');
const shareBusy = ref(false);

const calls = ref<ConnectionCall[]>([]);
const callsPage = ref(1);
const callsLoading = ref(false);
const expertPrimary = ref<ExternalConnection>();
const expertConnectionIds = ref<string[]>([]);

const currentConnector = computed(() => catalog.value.find(item => item.type === form.value.type));
const readyConnections = computed(() => rows.value.filter(isReady));
const shareDescription = computed(() =>
  selected.value?.assistantId
    ? '员工需要同时获得全部已绑定外部连接和查询专家的查看、使用权限。下方操作不会展示或复制外部系统凭据。'
    : '此连接可独立共享给已有通用助手使用；授权不会创建专用专家，也不会展示或复制外部系统凭据。'
);

function emptyForm(): FormState {
  return {
    type: 'UFEI_DASHBOARD',
    name: '',
    businessUnit: '',
    environment: 'TEST',
    baseUrl: '',
    credential: '',
    clearCredential: false,
    allowedMethods: [],
    enabled: true
  };
}

function connectionRow(row: unknown) {
  return row as ExternalConnection;
}

function callRow(row: unknown) {
  return row as ConnectionCall;
}

async function message(errorValue: unknown, fallback: string) {
  const result = (await extractErrorMessage(errorValue)) || fallback;
  return result.includes('VersionConflict') ? '连接版本已变化，请关闭编辑窗口并重新加载后再试。' : result;
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const [catalogResult, connectionsResult] = await Promise.all([connectionApi.catalog(), connectionApi.list()]);
    catalog.value = catalogResult;
    rows.value = connectionsResult;
  } catch (cause) {
    error.value = await message(cause, '外部连接加载失败，请刷新后重试。');
  } finally {
    loading.value = false;
  }
}

function connectorName(type: ConnectorType) {
  return catalog.value.find(item => item.type === type)?.displayName || type;
}

function environmentName(environment: ConnectionEnvironment) {
  return environment === 'PRODUCTION' ? '生产' : '测试';
}

function connectionError(code?: string) {
  const messages: Record<string, string> = {
    ExternalCredentialRequired: '尚未配置访问凭据，请在编辑中安全填写',
    ConnectorCredentialInvalid: '凭据格式无效，请核对所属系统的凭据',
    NoVerifiedConnectorMethods: '逐方法接口合同尚未确认，暂不能开放查询',
    ConnectorContractUnverified: '接口合同尚未确认，暂不能开放查询',
    CONNECTOR_CONTRACT_UNVERIFIED: '接口合同尚未确认，暂不能开放查询',
    ConnectorAuthenticationFailed: '上游拒绝凭据，请核对是否失效或环境不符',
    ConnectorAccessDenied: '上游未授权此项访问',
    ConnectorTimeout: '上游请求超时，可稍后重试',
    ConnectorUnavailable: '上游暂不可达，请检查网络和服务状态',
    BUSINESS_IDENTITY_MISMATCH: '凭据所属企业与填写的实际业务单位不一致，请查看验证身份'
  };
  if (code?.startsWith('CswmBusinessCode')) return `国家平台业务拒绝（code=${code.slice('CswmBusinessCode'.length)}）`;
  return (code && messages[code]) || code || '请查看连接状态';
}

function statusName(status?: string) {
  const labels: Record<string, string> = {
    VERIFIED: '验证通过',
    READY: '验证通过',
    SUCCESS: '验证通过',
    FAILED: '验证失败',
    ERROR: '验证失败',
    NOT_TESTED: '尚未验证',
    PENDING: '待验证'
  };
  return labels[status || ''] || status || '尚未验证';
}

function statusTag(status?: string): 'success' | 'danger' | 'warning' | 'info' {
  if (['VERIFIED', 'READY', 'SUCCESS'].includes(status || '')) return 'success';
  if (['FAILED', 'ERROR'].includes(status || '')) return 'danger';
  if (status === 'PENDING') return 'warning';
  return 'info';
}

function isReady(row: ExternalConnection) {
  return row.enabled && row.credentialConfigured && ['VERIFIED', 'READY', 'SUCCESS'].includes(row.testedStatus);
}

function methodSummary(row: ExternalConnection) {
  const names = new Map(
    (catalog.value.find(item => item.type === row.type)?.methods || []).map(item => [
      item.name,
      item.title || item.name
    ])
  );
  if (!row.allowedMethods?.length) return '未授权';
  const preview = row.allowedMethods
    .slice(0, 2)
    .map(name => names.get(name) || name)
    .join('、');
  return `${row.allowedMethods.length} 项：${preview}${row.allowedMethods.length > 2 ? '等' : ''}`;
}

function openEditor(row?: ExternalConnection) {
  dialogError.value = '';
  editing.value = row;
  if (row) {
    form.value = {
      type: row.type,
      name: row.name,
      businessUnit: row.businessUnit,
      environment: row.environment,
      baseUrl: row.baseUrl,
      credential: '',
      clearCredential: false,
      allowedMethods: [...(row.allowedMethods || [])],
      enabled: row.enabled
    };
  } else {
    form.value = emptyForm();
    applyCatalogDefaults();
  }
  editorVisible.value = true;
}

function applyCatalogDefaults() {
  const connector = currentConnector.value;
  if (!connector) return;
  const environment =
    connector.environments.find(item => item.name === form.value.environment) || connector.environments[0];
  if (environment) {
    form.value.environment = environment.name;
    form.value.baseUrl = environment.baseUrl;
  }
  form.value.allowedMethods = connector.methods.filter(methodAvailable).map(method => method.name);
}

function connectorChanged() {
  applyCatalogDefaults();
}

function environmentChanged() {
  const environment = currentConnector.value?.environments.find(item => item.name === form.value.environment);
  if (environment) form.value.baseUrl = environment.baseUrl;
}

function clearCredentialChanged(value: unknown) {
  if (value) {
    form.value.credential = '';
    form.value.enabled = false;
  }
}

function validateForm() {
  const value = form.value;
  if (!value.name.trim()) return '请填写连接名称。';
  if (!value.businessUnit.trim()) return '请填写业务单位。';
  if (!/^https:\/\//i.test(value.baseUrl.trim())) return '服务地址必须使用 HTTPS。';
  if ((currentConnector.value?.methods || []).some(methodAvailable) && !value.allowedMethods.length)
    return '请至少选择一个可用的固定查询方法。';
  const allowed = new Set((currentConnector.value?.methods || []).filter(methodAvailable).map(method => method.name));
  if (value.allowedMethods.some(method => !allowed.has(method))) return '查询方法目录已变化，请重新选择。';
  return '';
}

async function save() {
  dialogError.value = validateForm();
  if (dialogError.value) return;
  saving.value = true;
  const value = form.value;
  const input: ConnectionInput = {
    type: value.type,
    name: value.name.trim(),
    businessUnit: value.businessUnit.trim(),
    environment: value.environment,
    baseUrl: value.baseUrl.trim(),
    allowedMethods: value.allowedMethods,
    enabled:
      value.enabled &&
      (editing.value?.credentialConfigured === true || Boolean(value.credential.trim())) &&
      !value.clearCredential
  };
  if (editing.value) {
    input.expectedVersion = editing.value.version;
    input.clearCredential = value.clearCredential;
    if (value.credential.trim()) input.credential = value.credential;
  } else {
    if (value.credential.trim()) input.credential = value.credential;
  }
  try {
    if (editing.value) await connectionApi.update(editing.value.id, input);
    else await connectionApi.create(input);
    editorVisible.value = false;
    ElMessage.success('外部连接已保存');
    await load();
  } catch (cause) {
    dialogError.value = await message(cause, '保存失败；连接可能已被其他管理员修改，请重新加载后再试。');
  } finally {
    form.value.credential = '';
    saving.value = false;
  }
}

async function verify(row: ExternalConnection) {
  rowBusy.value = row.id + ':verify';
  error.value = '';
  try {
    const result = await connectionApi.verify(row.id, row.version);
    if (result.testedStatus === 'READY') ElMessage.success('连接验证通过，已核对接口身份');
    else ElMessage.warning(`连接验证未通过：${connectionError(result.lastError)}`);
    await load();
  } catch (cause) {
    error.value = await message(cause, '连接验证失败，请核对地址、凭据、版本和服务状态。');
    await load();
  } finally {
    rowBusy.value = '';
  }
}

function openExpert(row: ExternalConnection) {
  expertPrimary.value = row;
  dialogError.value = '';
  const stored = (row.expertConnectionIds || []).filter(id =>
    readyConnections.value.some(connection => connection.id === id)
  );
  expertConnectionIds.value = [...new Set([row.id, ...stored])].slice(0, 8);
  expertVisible.value = true;
}

async function saveExpert() {
  const row = expertPrimary.value;
  if (!row) return;
  if (!expertConnectionIds.value.includes(row.id)) expertConnectionIds.value.unshift(row.id);
  if (expertConnectionIds.value.length > 8) {
    dialogError.value = '查询专家最多绑定 8 个连接。';
    return;
  }
  rowBusy.value = row.id + ':expert';
  error.value = '';
  dialogError.value = '';
  try {
    const expert = await connectionApi.expert(row.id, row.version, expertConnectionIds.value);
    const assistantId = String(expert.assistantId || '');
    ElMessage.success(row.assistantId ? '已复用现有查询专家' : '查询专家已创建并绑定');
    await load();
    const refreshed = rows.value.find(item => item.id === row.id);
    if (refreshed) selected.value = refreshed;
    if (!refreshed?.assistantId && assistantId) row.assistantId = assistantId;
    expertVisible.value = false;
  } catch (cause) {
    dialogError.value = await message(cause, '查询专家配置失败，请核对所选连接的验证状态和版本。');
  } finally {
    rowBusy.value = '';
  }
}

function openDetails(row: ExternalConnection) {
  selected.value = row;
  detailsVisible.value = true;
}

function identityMismatch(row: ExternalConnection) {
  const verified = identity(row);
  if (!verified) return row.verifiedIdentity === false;
  if (verified.businessUnitMatched !== undefined) return !verified.businessUnitMatched;
  if (verified.matched !== undefined) return !verified.matched;
  if (!verified.name) return false;
  const normalize = (value: string) => value.replace(/[\s（）()]/g, '').toLocaleLowerCase();
  return normalize(verified.name) !== normalize(row.businessUnit);
}

function identity(row: ExternalConnection) {
  if (!row.verifiedIdentity || typeof row.verifiedIdentity !== 'object') return undefined;
  return Object.keys(row.verifiedIdentity).length ? row.verifiedIdentity : undefined;
}

function methodAvailable(method: { readOnly: boolean; available?: boolean; status?: string }) {
  return method.readOnly && method.available !== false && method.status !== 'UNAVAILABLE';
}

async function api<T>(url: string, data?: unknown, method = data ? 'post' : 'get'): Promise<T> {
  return (await request({ url, method, data })).data;
}

async function openShares(row: ExternalConnection) {
  if (!row.resourceId) return;
  selected.value = row;
  sharesVisible.value = true;
  dialogError.value = '';
  targetChanged();
  await loadShares();
}

async function loadShares() {
  if (!selected.value?.resourceId) return;
  shareBusy.value = true;
  try {
    const resourceIds = shareResources(selected.value);
    const results = await Promise.all(
      resourceIds.map(async resource =>
        (await api<Record<string, unknown>[]>(`/ai/resources/${resource.id}/shares`)).map(row => ({
          id: String(row.id),
          name: String(row.name || ''),
          subjectType: String(row.subjectType || row.subject_type || ''),
          subjectId: String(row.subjectId || row.subject_id || ''),
          actions: parseActions(row.actions),
          status: String(row.status || ''),
          resourceId: resource.id,
          resourceLabel: resource.label
        }))
      )
    );
    shareRows.value = results.flat();
  } catch (cause) {
    dialogError.value = await message(cause, '共享信息加载失败。');
  } finally {
    shareBusy.value = false;
  }
}

function targetChanged() {
  targetQuery.value = '';
  targets.value = [];
  targetId.value = '';
}

async function findTargets() {
  if (targetQuery.value.trim().length < 2) return;
  shareBusy.value = true;
  dialogError.value = '';
  try {
    targets.value = await api<ShareTarget[]>(
      `/ai/share-targets?type=${targetType.value}&query=${encodeURIComponent(targetQuery.value.trim())}`
    );
    targetId.value = '';
  } catch (cause) {
    dialogError.value = await message(cause, '共享对象查询失败。');
  } finally {
    shareBusy.value = false;
  }
}

async function grantShare() {
  if (!selected.value?.resourceId || !targetId.value) return;
  shareBusy.value = true;
  dialogError.value = '';
  try {
    const payload = { subjectType: targetType.value, subjectId: targetId.value, actions: ['VIEW', 'USE'] };
    const targetsToGrant = shareResources(selected.value)
      .map(resource => resource.id)
      .filter(
        resourceId =>
          !shareRows.value.some(
            row =>
              row.resourceId === resourceId &&
              row.subjectType === targetType.value &&
              String(row.subjectId) === targetId.value &&
              row.status === 'ACTIVE'
          )
      );
    const results = await Promise.allSettled(
      targetsToGrant.map(resourceId => api(`/ai/resources/${resourceId}/shares`, payload))
    );
    if (results.some(result => result.status === 'rejected')) {
      await loadShares();
      dialogError.value = '授权只完成了一部分。请查看下方各项资源的状态后重试缺失授权。';
      return;
    }
    ElMessage.success(selected.value.assistantId ? '全部绑定连接与查询专家均已共享' : '外部连接已共享');
    targetId.value = '';
    await loadShares();
  } catch (cause) {
    dialogError.value = await message(cause, '共享失败，请检查资源版本和管理权限。');
  } finally {
    shareBusy.value = false;
  }
}

function shareResources(connection: ExternalConnection) {
  if (!connection.assistantId) return [{ id: connection.resourceId as string, label: '外部连接' }];
  const storedResourceIds = connection.expertResourceIds?.length
    ? connection.expertResourceIds
    : (connection.expertConnectionIds || [])
        .map(id => rows.value.find(row => row.id === id)?.resourceId)
        .filter((id): id is string => Boolean(id));
  const connectionResourceIds = [
    ...new Set([connection.resourceId, ...storedResourceIds].filter((id): id is string => Boolean(id)))
  ];
  return [
    ...connectionResourceIds.map(id => ({ id, label: id === connection.resourceId ? '主外部连接' : '绑定外部连接' })),
    { id: connection.assistantId, label: '查询专家' }
  ];
}

async function revokeShare(id: string, resourceId?: string) {
  if (!resourceId) return;
  try {
    await ElMessageBox.confirm('撤回后该对象将不能继续使用此项资源；其它有效授权不受影响。', '撤回共享', {
      type: 'warning'
    });
  } catch {
    return;
  }
  shareBusy.value = true;
  try {
    await api(`/ai/resources/${resourceId}/shares/${id}`, undefined, 'delete');
    ElMessage.success('共享已撤回');
    await loadShares();
  } catch (cause) {
    dialogError.value = await message(cause, '撤回共享失败。');
  } finally {
    shareBusy.value = false;
  }
}

function actionsText(actions?: string[] | string) {
  const value = parseActions(actions);
  return (
    value
      .map(action => ({ VIEW: '查看', USE: '使用' })[action] || action)
      .filter(Boolean)
      .join('、') || '—'
  );
}

function parseActions(actions: unknown): string[] {
  if (Array.isArray(actions)) return actions.map(String);
  const text = String(actions || '');
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map(String);
  } catch {
    // Older responses may serialize the SQL array as comma-separated text.
  }
  return text
    .split(',')
    .map(item => item.replace(/[{}"\s]/g, ''))
    .filter(Boolean);
}

async function openCalls(row: ExternalConnection) {
  selected.value = row;
  callsVisible.value = true;
  callsPage.value = 1;
  dialogError.value = '';
  await loadCalls();
}

async function loadCalls() {
  if (!selected.value) return;
  callsLoading.value = true;
  dialogError.value = '';
  try {
    calls.value = await connectionApi.calls(selected.value.id, callsPage.value);
  } catch (cause) {
    dialogError.value = await message(cause, '调用审计加载失败。');
  } finally {
    callsLoading.value = false;
  }
}

function durationText(row: ConnectionCall) {
  const value = row.durationMs;
  return value === undefined || value === null ? '—' : `${value} ms`;
}

function formatTime(value?: string) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false });
}

onMounted(load);
</script>

<style scoped>
.external-connections {
  max-width: 1500px;
}
.page-heading {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-start;
  margin-bottom: 18px;
}
.page-heading h2 {
  margin: 0 0 8px;
}
.page-heading p {
  margin: 0;
  color: var(--el-text-color-secondary);
}
.heading-actions {
  display: flex;
  gap: 10px;
  flex-shrink: 0;
}
.form-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0 18px;
}
.field-help,
.subtle {
  margin-top: 5px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.5;
}
.connection-error {
  margin-top: 4px;
  color: var(--el-color-danger);
  font-size: 12px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}
.method-list {
  display: grid;
  width: 100%;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
.method-option {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  color: var(--el-text-color-regular);
}
.method-option.disabled {
  opacity: 0.65;
}
.method-option span {
  font-size: 12px;
  line-height: 1.45;
}
.method-option .method-path {
  color: var(--el-text-color-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}
.share-controls {
  display: grid;
  grid-template-columns: 130px 1fr auto;
  gap: 10px;
  margin-bottom: 10px;
}
.expert-list {
  display: grid;
  gap: 10px;
}
.expert-option {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 12px;
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
}
.expert-option span {
  padding-left: 24px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.target-select {
  width: calc(100% - 190px);
  margin-right: 10px;
  margin-bottom: 16px;
}
.pagination-row {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
}
@media (max-width: 900px) {
  .page-heading,
  .form-grid {
    display: block;
  }
  .heading-actions {
    margin-top: 12px;
  }
  .method-list {
    grid-template-columns: 1fr;
  }
  .share-controls {
    grid-template-columns: 1fr;
  }
  .target-select {
    width: 100%;
  }
}
</style>
