import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Empty,
  Form,
  Input,
  List,
  Message,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Upload,
} from '@arco-design/web-react';
import { Delete, FolderOpen, Plus, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import {
  enterpriseControl,
  enterpriseRequest,
  newIdempotencyKey,
  workspaceErrorCode,
  workspaceErrorTranslationKey,
} from './workspaceApi';
import { availableModelId, catalogOrigin, preferredAvailableModel, type AvailableModel } from './workspaceCatalog';
import type { ResourceScope, WorkspaceResource } from './workspaceTypes';
import McpConnections from './capabilities/McpConnections';

type CapabilityType = 'MODEL' | 'ASSISTANT' | 'SKILL' | 'MCP' | 'TOOL';
type AssistantConfig = {
  avatar?: string;
  instruction: string;
  modelId: string;
  skillIds?: string[];
  mcpIds?: string[];
  toolIds?: string[];
  knowledgeIds?: string[];
};
type SkillFile = { path: string; content: string; encoding: 'base64'; executable: boolean; sha256?: string };
type SkillConfig = { source: string; files: SkillFile[]; manifest?: { name?: string } };
type AssistantResource = WorkspaceResource & { config: AssistantConfig };
type SkillResource = WorkspaceResource & { config: SkillConfig };
type RuntimeIssue = {
  type: 'SKILL' | 'MCP' | 'ASSISTANT';
  id: string;
  code: string;
};
type EditorValue = {
  name: string;
  description: string;
  instruction: string;
  skillIds: string[];
  mcpIds: string[];
  enabled: boolean;
};

const describeRuntimeIssues = (issues: RuntimeIssue[]): string =>
  issues.map((issue) => `${issue.type}:${issue.id} (${issue.code})`).join(', ');

const relativePath = (file: File): string =>
  ((file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name).replaceAll('\\', '/');

const readBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => reject(reader.error || new Error('FILE_READ_FAILED')), { once: true });
    reader.addEventListener(
      'load',
      () => {
        const value = typeof reader.result === 'string' ? reader.result : '';
        const separator = value.indexOf(',');
        if (separator < 0) reject(new Error('FILE_READ_FAILED'));
        else resolve(value.slice(separator + 1));
      },
      { once: true }
    );
    reader.readAsDataURL(file);
  });

const frontmatterValue = (source: string, key: string): string => {
  const match = source.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm'));
  return (match?.[1] || '').replace(/^['"]|['"]$/g, '').trim();
};

const WorkspaceCapabilities: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [message, messageContext] = Message.useMessage();
  const [form] = Form.useForm<EditorValue>();
  const [scope, setScope] = useState<ResourceScope>('available');
  const [capabilityType, setCapabilityType] = useState<CapabilityType>('ASSISTANT');
  const [items, setItems] = useState<WorkspaceResource[]>([]);
  const [models, setModels] = useState<AvailableModel[]>([]);
  const [organizationDefaultModel, setOrganizationDefaultModel] = useState<AvailableModel | null>(null);
  const [runtimeIssues, setRuntimeIssues] = useState<RuntimeIssue[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssistantResource | 'new' | null>(null);
  const [skillDetail, setSkillDetail] = useState<SkillResource | null>(null);
  const [mcpResource, setMcpResource] = useState<WorkspaceResource | null>(null);
  const [assistantSkills, setAssistantSkills] = useState<WorkspaceResource[]>([]);
  const [assistantMcps, setAssistantMcps] = useState<WorkspaceResource[]>([]);
  const [readiness, setReadiness] = useState<{
    ready: boolean;
    issues?: Array<{ type?: string; id?: string; code?: string }>;
  } | null>(null);
  const [saving, setSaving] = useState(false);
  const [refreshingResources, setRefreshingResources] = useState(false);
  const [openingResourceId, setOpeningResourceId] = useState<string | null>(null);
  const packageSignature = useRef('');
  const loadGeneration = useRef(0);

  useEffect(
    () => () => {
      loadGeneration.current += 1;
    },
    []
  );

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      if (capabilityType === 'MODEL') {
        const value = await enterpriseControl<AvailableModel[]>('/ai/models/available');
        if (generation !== loadGeneration.current) return;
        setModels(Array.isArray(value) ? value : []);
        setOrganizationDefaultModel(value.find((model) => model.source === 'ORGANIZATION' && model.isDefault) || null);
        setItems([]);
        setRuntimeIssues([]);
        setErrorCode(null);
        return;
      }
      const [value, issues, availableModels] = await Promise.all([
        enterpriseControl<WorkspaceResource[]>(`/ai/resources?type=${capabilityType}&scope=${scope}&page=1`),
        enterpriseControl<RuntimeIssue[]>('/ai/resources/runtime-issues'),
        capabilityType === 'ASSISTANT' || capabilityType === 'TOOL'
          ? enterpriseControl<AvailableModel[]>('/ai/models/available').catch((): AvailableModel[] => [])
          : Promise.resolve([] as AvailableModel[]),
      ]);
      if (generation !== loadGeneration.current) return;
      setItems(Array.isArray(value) ? value : []);
      setModels([]);
      setOrganizationDefaultModel(
        availableModels.find((model) => model.source === 'ORGANIZATION' && model.isDefault) || null
      );
      setRuntimeIssues(Array.isArray(issues) ? issues : []);
      setErrorCode(null);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setItems([]);
      setModels([]);
      setOrganizationDefaultModel(null);
      setRuntimeIssues([]);
      setErrorCode(workspaceErrorCode(error));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [capabilityType, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshRuntimeResources = useCallback(async () => {
    const result = await enterpriseRequest<{ ok?: boolean; state?: string }>('/enterprise/resources/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (result.ok !== true) throw new Error('RESOURCE_REFRESH_FAILED');
    return result;
  }, []);

  const refreshCapabilities = useCallback(async () => {
    setRefreshingResources(true);
    try {
      const result = await refreshRuntimeResources();
      await load();
      if (result.state === 'pending') message.info(t('workspace.status.resourceUpdatePending'));
      else message.success(t('workspace.abilities.resourcesRefreshed'));
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(
        code === 'RESOURCE_REFRESH_TASK_ACTIVE'
          ? t('workspace.abilities.resourcesRefreshBusy')
          : t('workspace.abilities.resourcesRefreshFailed', { code })
      );
    } finally {
      setRefreshingResources(false);
    }
  }, [load, message, refreshRuntimeResources, t]);

  const useCapability = useCallback(
    async (item: WorkspaceResource) => {
      setOpeningResourceId(item.id);
      try {
        const result = await refreshRuntimeResources();
        if (result.state === 'pending') { message.info(t('workspace.status.resourceUpdatePending'));return; }
        let selectedSkillName: string | undefined;
        if (item.resourceType === 'SKILL') {
          const detail = await enterpriseControl<SkillResource>(`/ai/resources/${item.id}`);
          selectedSkillName = detail.config.manifest?.name || frontmatterValue(detail.config.source, 'name');
          if (!selectedSkillName) throw new Error('SKILL_NAME_UNAVAILABLE');
        }
        navigate('/guid', {
          state: item.resourceType === 'ASSISTANT' ? { selectedAssistantId: `rc2-${item.id}` } : { selectedSkillName },
        });
      } catch (error) {
        const code = workspaceErrorCode(error);
        message.error(
          code === 'RESOURCE_REFRESH_TASK_ACTIVE'
            ? t('workspace.abilities.resourcesRefreshBusy')
            : t('workspace.abilities.resourcesRefreshFailed', { code })
        );
      } finally {
        setOpeningResourceId(null);
      }
    },
    [message, navigate, refreshRuntimeResources, t]
  );

  const openAssistantEditor = async (item?: WorkspaceResource) => {
    setReadiness(null);
    const dependencies = await Promise.all([
      enterpriseControl<WorkspaceResource[]>('/ai/resources?type=SKILL&scope=available&page=1').catch(
        (): WorkspaceResource[] => []
      ),
      enterpriseControl<WorkspaceResource[]>('/ai/resources?type=MCP&scope=available&page=1').catch(
        (): WorkspaceResource[] => []
      ),
    ]);
    const [skills, mcps] = dependencies;
    setAssistantSkills(skills.filter((skill) => skill.actions.includes('USE')));
    setAssistantMcps(mcps.filter((mcp) => mcp.actions.includes('USE')));
    if (!item) {
      setEditing('new');
      form.setFieldsValue({ name: '', description: '', instruction: '', skillIds: [], mcpIds: [], enabled: true });
      return;
    }
    try {
      const [detail, state] = await Promise.all([
        enterpriseControl<AssistantResource>(`/ai/resources/${item.id}`),
        enterpriseControl<{ ready: boolean; issues?: Array<{ type?: string; id?: string; code?: string }> }>(
          `/ai/resources/${item.id}/readiness`
        ).catch((): null => null),
      ]);
      setEditing(detail);
      setReadiness(state);
      form.setFieldsValue({
        name: detail.name,
        description: detail.description || '',
        instruction: detail.config.instruction || '',
        skillIds: detail.config.skillIds || [],
        mcpIds: detail.config.mcpIds || [],
        enabled: detail.enabled,
      });
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    }
  };

  const openSkill = async (item: WorkspaceResource) => {
    try {
      setSkillDetail(await enterpriseControl<SkillResource>(`/ai/resources/${item.id}`));
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    }
  };

  const saveAssistant = async () => {
    const values = await form.validate();
    setSaving(true);
    try {
      let saved: AssistantResource;
      if (editing === 'new') {
        const models = await enterpriseControl<AvailableModel[]>('/ai/models/available');
        const modelId = availableModelId(preferredAvailableModel(models) || {});
        if (!modelId) throw new Error('ModelUnavailable');
        saved = await enterpriseControl<AssistantResource>('/ai/resources', {
          method: 'POST',
          body: JSON.stringify({
            resourceType: 'ASSISTANT',
            name: values.name.trim(),
            description: values.description.trim(),
            enterprise: false,
            config: {
              instruction: values.instruction.trim(),
              modelId,
              skillIds: values.skillIds || [],
              mcpIds: values.mcpIds || [],
            },
            idempotencyKey: newIdempotencyKey(),
          }),
        });
      } else if (editing) {
        saved = await enterpriseControl<AssistantResource>(`/ai/resources/${editing.id}`, {
          method: 'PUT',
          body: JSON.stringify({
            expectedVersion: editing.version,
            name: values.name.trim(),
            description: values.description.trim(),
            config: {
              ...editing.config,
              instruction: values.instruction.trim(),
              skillIds: values.skillIds || [],
              mcpIds: values.mcpIds || [],
            },
          }),
        });
      } else return;
      await enterpriseControl(`/ai/resources/${saved.id}/activate`, {
        method: 'POST',
        body: JSON.stringify({ version: saved.version }),
      });
      if (saved.enabled !== values.enabled) {
        await enterpriseControl(`/ai/resources/${saved.id}/enabled`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: values.enabled, reason: '' }),
        });
      }
      message.success(t('workspace.abilities.saved'));
      setEditing(null);
      await load();
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    } finally {
      setSaving(false);
    }
  };

  const importSkillPackage = async (selected: File[]) => {
    setSaving(true);
    try {
      const skillFiles = selected.filter((file) => /(^|\/)SKILL\.md$/i.test(relativePath(file)));
      if (skillFiles.length !== 1) {
        message.error(t('workspace.abilities.packageSkillFile'));
        return;
      }
      const skillFile = skillFiles[0];
      const skillPath = relativePath(skillFile);
      const root = skillPath.slice(0, -'SKILL.md'.length);
      const source = await skillFile.text();
      const companion = selected.filter((file) => {
        const path = relativePath(file);
        const local = path.startsWith(root) ? path.slice(root.length) : '';
        return local && !/^SKILL\.md$/i.test(local) && !local.split('/').some((part) => part.startsWith('.'));
      });
      const files: SkillFile[] = await Promise.all(
        companion.map(async (file) => ({
          path: relativePath(file).slice(root.length),
          content: await readBase64(file),
          encoding: 'base64' as const,
          executable: relativePath(file).slice(root.length).startsWith('scripts/'),
        }))
      );
      const fallbackName = root.replace(/\/$/, '').split('/').at(-1) || 'Imported ability';
      const saved = await enterpriseControl<SkillResource>('/ai/resources', {
        method: 'POST',
        body: JSON.stringify({
          resourceType: 'SKILL',
          name: (frontmatterValue(source, 'name') || fallbackName).slice(0, 100),
          description: frontmatterValue(source, 'description').slice(0, 500),
          enterprise: false,
          config: { source, files },
          idempotencyKey: newIdempotencyKey(),
        }),
      });
      await enterpriseControl(`/ai/resources/${saved.id}/activate`, {
        method: 'POST',
        body: JSON.stringify({ version: saved.version }),
      });
      message.success(t('workspace.abilities.packageImported', { count: files.length }));
      await load();
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    } finally {
      setSaving(false);
    }
  };

  const interceptPackage = (_file: File, selected: File[]) => {
    const signature = selected
      .map((file) => `${relativePath(file)}:${file.size}:${file.lastModified}`)
      .toSorted()
      .join('|');
    if (signature && packageSignature.current !== signature) {
      packageSignature.current = signature;
      void importSkillPackage(selected).finally(() => {
        packageSignature.current = '';
      });
    }
    return false;
  };

  const remove = (item: WorkspaceResource) => {
    Modal.confirm({
      title: t('workspace.abilities.deleteTitle'),
      content: t('workspace.abilities.deleteConfirm', { name: item.name }),
      okButtonProps: { status: 'danger' },
      onOk: async () => {
        try {
          await enterpriseControl(`/ai/resources/${item.id}`, { method: 'DELETE' });
          message.success(t('workspace.abilities.deleted'));
          await load();
        } catch (error) {
          const code = workspaceErrorCode(error);
          message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
          throw error;
        }
      },
    });
  };

  const canEdit = editing !== null && (editing === 'new' || editing.actions.includes('EDIT'));
  const packageBudgetIssues = runtimeIssues.filter((issue) => issue.code === 'PACKAGE_BUDGET_EXCEEDED');
  const otherRuntimeIssues = runtimeIssues.filter((issue) => issue.code !== 'PACKAGE_BUDGET_EXCEEDED');
  const nativeOfficeCapability =
    scope === 'available' && organizationDefaultModel && (capabilityType === 'ASSISTANT' || capabilityType === 'TOOL');

  return (
    <div className='flex flex-col gap-12px'>
      {messageContext}
      <div className='flex flex-wrap items-start justify-between gap-8px'>
        <div>
          <div className='text-20px font-semibold text-t-primary'>{t('workspace.abilities.title')}</div>
          <div className='mt-3px text-13px text-t-secondary'>{t('workspace.abilities.subtitle')}</div>
        </div>
        <Space wrap>
          <Select value={capabilityType} onChange={setCapabilityType} style={{ width: 145 }}>
            <Select.Option value='MODEL'>{t('workspace.abilities.models')}</Select.Option>
            <Select.Option value='ASSISTANT'>{t('workspace.abilities.assistants')}</Select.Option>
            <Select.Option value='SKILL'>{t('workspace.abilities.skillPackages')}</Select.Option>
            <Select.Option value='MCP'>{t('workspace.abilities.mcpConnections')}</Select.Option>
            <Select.Option value='TOOL'>{t('workspace.abilities.tools')}</Select.Option>
          </Select>
          {capabilityType !== 'MODEL' ? (
            <Select value={scope} onChange={setScope} style={{ width: 150 }}>
              <Select.Option value='available'>{t('workspace.scope.available')}</Select.Option>
              <Select.Option value='mine'>{t('workspace.scope.mine')}</Select.Option>
              <Select.Option value='shared'>{t('workspace.scope.shared')}</Select.Option>
            </Select>
          ) : null}
          {scope === 'mine' && capabilityType === 'ASSISTANT' ? (
            <Button type='primary' icon={<Plus />} onClick={() => void openAssistantEditor()}>
              {t('workspace.abilities.create')}
            </Button>
          ) : null}
          {scope === 'mine' && capabilityType === 'SKILL' ? (
            <Upload directory multiple showUploadList={false} autoUpload={false} beforeUpload={interceptPackage}>
              <Button type='primary' icon={<FolderOpen />} loading={saving}>
                {t('workspace.abilities.importPackage')}
              </Button>
            </Upload>
          ) : null}
          <Button
            icon={<Refresh />}
            onClick={() => void (capabilityType === 'MODEL' ? load() : refreshCapabilities())}
            loading={capabilityType === 'MODEL' ? loading : refreshingResources}
            disabled={Boolean(openingResourceId)}
          >
            {t('common.refresh')}
          </Button>
        </Space>
      </div>
      {capabilityType === 'SKILL' ? (
        <Alert type='info' showIcon content={t('workspace.abilities.packageHint')} />
      ) : null}
      {packageBudgetIssues.length > 0 ? (
        <Alert
          type='warning'
          showIcon
          content={t('workspace.abilities.packageBudgetWarning', {
            issues: describeRuntimeIssues(packageBudgetIssues),
          })}
        />
      ) : null}
      {otherRuntimeIssues.length > 0 ? (
        <Alert
          type='warning'
          showIcon
          content={t('workspace.abilities.runtimeIssuesWarning', {
            issues: describeRuntimeIssues(otherRuntimeIssues),
          })}
        />
      ) : null}
      {nativeOfficeCapability ? (
        <List
          dataSource={[capabilityType]}
          render={() => (
            <List.Item>
              <List.Item.Meta
                title={
                  <div className='flex flex-wrap items-center gap-8px'>
                    <span>
                      {capabilityType === 'ASSISTANT'
                        ? t('workspace.abilities.nativeAssistant')
                        : t('workspace.abilities.nativeTools')}
                    </span>
                    <Tag color='arcoblue'>{t('workspace.abilities.origin.organization')}</Tag>
                    <Tag>{t('workspace.abilities.workspaceBuiltin')}</Tag>
                    <Tag color='green'>{t('workspace.abilities.available')}</Tag>
                  </div>
                }
                description={t('workspace.abilities.nativeOfficeDescription', {
                  model:
                    organizationDefaultModel.name ||
                    organizationDefaultModel.code ||
                    availableModelId(organizationDefaultModel),
                })}
              />
            </List.Item>
          )}
        />
      ) : null}
      {errorCode ? (
        <Alert
          type='error'
          showIcon
          content={t(workspaceErrorTranslationKey(errorCode, 'load'), { code: errorCode })}
        />
      ) : null}
      <Spin loading={loading} className='w-full'>
        {capabilityType === 'MODEL' ? (
          models.length === 0 && !loading ? (
            <Empty description={t('workspace.abilities.modelsEmpty')} />
          ) : (
            <List
              dataSource={models}
              render={(model) => (
                <List.Item key={availableModelId(model) || model.code || model.name}>
                  <List.Item.Meta
                    title={
                      <div className='flex flex-wrap items-center gap-8px'>
                        <span>{model.name || model.code || availableModelId(model)}</span>
                        <Tag color={catalogOrigin(model) === 'organization' ? 'arcoblue' : 'purple'}>
                          {t(`workspace.abilities.origin.${catalogOrigin(model)}`)}
                        </Tag>
                        {model.isDefault ? <Tag color='green'>{t('workspace.abilities.default')}</Tag> : null}
                        <Tag color='blue'>{t('workspace.abilities.available')}</Tag>
                      </div>
                    }
                    description={model.code || availableModelId(model) || t('workspace.none')}
                  />
                </List.Item>
              )}
            />
          )
        ) : items.length === 0 && !loading && !nativeOfficeCapability ? (
          <Empty
            description={scope === 'mine' ? t('workspace.abilities.personalEmpty') : t('workspace.abilities.empty')}
          />
        ) : (
          <List
            dataSource={items}
            render={(item) => (
              <List.Item
                key={item.id}
                actions={[
                  <Button
                    key='view'
                    type='text'
                    onClick={() => {
                      if (capabilityType === 'ASSISTANT') void openAssistantEditor(item);
                      else if (capabilityType === 'SKILL') void openSkill(item);
                      else setMcpResource(item);
                    }}
                  >
                    {capabilityType === 'ASSISTANT' && item.actions.includes('EDIT')
                      ? t('common.edit')
                      : t('workspace.view')}
                  </Button>,
                  ...((capabilityType === 'ASSISTANT' || capabilityType === 'SKILL') &&
                  item.actions.includes('USE') &&
                  item.enabled &&
                  !item.securityDisabled
                    ? [
                        <Button
                          key='use'
                          type='text'
                          loading={openingResourceId === item.id}
                          disabled={
                            refreshingResources || (openingResourceId !== null && openingResourceId !== item.id)
                          }
                          onClick={() => void useCapability(item)}
                        >
                          {t('workspace.abilities.use')}
                        </Button>,
                      ]
                    : []),
                  ...(scope === 'mine' && item.actions.includes('DELETE')
                    ? [
                        <Button key='delete' type='text' status='danger' icon={<Delete />} onClick={() => remove(item)}>
                          {t('common.delete')}
                        </Button>,
                      ]
                    : []),
                ]}
              >
                <List.Item.Meta
                  title={
                    <div className='flex flex-wrap items-center gap-8px'>
                      <span>{item.name}</span>
                      <Tag color={catalogOrigin(item) === 'organization' ? 'arcoblue' : 'purple'}>
                        {t(`workspace.abilities.origin.${catalogOrigin(item)}`)}
                      </Tag>
                      {item.isDefault ? <Tag color='green'>{t('workspace.abilities.default')}</Tag> : null}
                      <Tag>{t('workspace.abilities.version', { version: item.version })}</Tag>
                      <Tag color={item.enabled && !item.securityDisabled ? 'blue' : 'gray'}>
                        {item.enabled && !item.securityDisabled
                          ? t('workspace.abilities.configuredEnabled')
                          : t('workspace.abilities.configuredDisabled')}
                      </Tag>
                    </div>
                  }
                  description={`${item.description || t('workspace.none')} · ${t('workspace.abilities.authorization', { actions: item.actions.join(', ') || '-' })}`}
                />
              </List.Item>
            )}
          />
        )}
      </Spin>
      <Modal
        visible={editing !== null}
        title={editing === 'new' ? t('workspace.abilities.create') : t('workspace.abilities.detail')}
        onCancel={() => setEditing(null)}
        onOk={canEdit ? () => void saveAssistant() : undefined}
        okButtonProps={canEdit ? { loading: saving } : { style: { display: 'none' } }}
        autoFocus={false}
        focusLock
      >
        {readiness && !readiness.ready ? (
          <Alert
            className='mb-12px'
            type='warning'
            showIcon
            content={t('workspace.abilities.readinessError', {
              errors: readiness.issues?.map((issue) => issue.code || issue.type).join(', ') || '-',
            })}
          />
        ) : null}
        {editing && editing !== 'new' ? (
          <Descriptions
            className='mb-12px'
            column={2}
            border
            data={[
              { label: t('workspace.abilities.versionLabel'), value: `v${editing.version}` },
              { label: t('workspace.abilities.permissionLabel'), value: editing.actions.join(', ') || '-' },
            ]}
          />
        ) : null}
        <Form form={form} layout='vertical' disabled={!canEdit}>
          <Form.Item field='name' label={t('workspace.abilities.name')} rules={[{ required: true }]}>
            <Input maxLength={100} />
          </Form.Item>
          <Form.Item field='description' label={t('workspace.abilities.description')}>
            <Input maxLength={500} />
          </Form.Item>
          <Form.Item field='instruction' label={t('workspace.abilities.instructions')} rules={[{ required: true }]}>
            <Input.TextArea maxLength={4000} autoSize={{ minRows: 5, maxRows: 10 }} />
          </Form.Item>
          <Form.Item field='skillIds' label={t('workspace.abilities.linkedSkills')}>
            <Select mode='multiple' maxTagCount={3} allowClear>
              {assistantSkills.map((skill) => (
                <Select.Option key={skill.id} value={skill.id}>
                  {skill.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item field='mcpIds' label={t('workspace.abilities.linkedMcps')}>
            <Select mode='multiple' maxTagCount={3} allowClear>
              {assistantMcps.map((mcp) => (
                <Select.Option key={mcp.id} value={mcp.id}>
                  {mcp.name}
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item field='enabled' label={t('workspace.abilities.enabled')} triggerPropName='checked'>
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        width={680}
        visible={Boolean(skillDetail)}
        title={skillDetail?.name || t('workspace.abilities.packageDetail')}
        footer={null}
        onCancel={() => setSkillDetail(null)}
      >
        {skillDetail ? (
          <div className='flex flex-col gap-12px'>
            <Descriptions
              column={1}
              border
              data={[
                { label: t('workspace.abilities.versionLabel'), value: `v${skillDetail.version}` },
                { label: t('workspace.abilities.permissionLabel'), value: skillDetail.actions.join(', ') || '-' },
                {
                  label: t('workspace.abilities.packageFiles'),
                  value: skillDetail.config.files.map((file) => file.path).join(', ') || t('workspace.none'),
                },
              ]}
            />
            <pre className='m-0 max-h-520px overflow-auto whitespace-pre-wrap break-words rd-6px bg-fill-1 p-12px text-13px leading-21px text-t-primary'>
              {skillDetail.config.source}
            </pre>
          </div>
        ) : null}
      </Drawer>
      <McpConnections resource={mcpResource} onClose={() => setMcpResource(null)} />
    </div>
  );
};

export default WorkspaceCapabilities;
