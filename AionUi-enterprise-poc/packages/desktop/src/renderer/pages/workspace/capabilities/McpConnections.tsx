import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Form,
  Input,
  List,
  Message,
  Space,
  Spin,
  Switch,
  Tag,
} from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enterpriseControl, workspaceErrorCode, workspaceErrorTranslationKey } from '../workspaceApi';
import type { WorkspaceResource } from '../workspaceTypes';

type McpTemplateConfig = {
  transport: 'STREAMABLE_HTTP';
  endpoint?: string;
  managedProfile?: string;
  authType: 'BEARER' | 'NONE';
  allowedTools: string[];
  toolEffects?: Record<string, 'READ' | 'WRITE' | 'SEND' | 'APPROVAL'>;
  timeoutSeconds: number;
};

type McpResource = WorkspaceResource & { config: McpTemplateConfig };
type McpTool = { name?: string; description?: string; effect?: string };
type McpConnection = {
  id: string;
  resource_id: string;
  scope: 'PERSONAL' | 'ENTERPRISE';
  template_version: number;
  enabled: boolean;
  version: number;
  status: string;
  last_error?: string | null;
  tested_at?: string | null;
  secretConfigured: boolean;
  tools: McpTool[];
};
type ConnectionForm = { secret: string; enabled: boolean; clearSecret: boolean };

type McpConnectionsProps = {
  resource: WorkspaceResource | null;
  onClose: () => void;
};

const McpConnections: React.FC<McpConnectionsProps> = ({ resource, onClose }) => {
  const { t } = useTranslation();
  const [message, messageContext] = Message.useMessage();
  const [form] = Form.useForm<ConnectionForm>();
  const [detail, setDetail] = useState<McpResource | null>(null);
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const requestId = useRef(0);

  const personal = useMemo(() => connections.find((item) => item.scope === 'PERSONAL') || null, [connections]);
  const enterprise = useMemo(() => connections.find((item) => item.scope === 'ENTERPRISE') || null, [connections]);

  const load = useCallback(async () => {
    const generation = ++requestId.current;
    if (!resource) return;
    setLoading(true);
    setErrorCode(null);
    try {
      const usable = resource.actions.includes('USE');
      const [nextDetail, nextConnections] = await Promise.all([
        enterpriseControl<McpResource>(`/ai/resources/${resource.id}${usable ? '?active=true' : ''}`),
        usable ? enterpriseControl<McpConnection[]>(`/ai/mcp/connections?resourceId=${resource.id}`) : [],
      ]);
      if (generation !== requestId.current) return;
      if (!Array.isArray(nextConnections)) throw new Error('INVALID_CATALOG_RESPONSE');
      setDetail(nextDetail);
      setConnections(nextConnections);
      const existing = nextConnections.find((item) => item.scope === 'PERSONAL');
      form.setFieldsValue({ secret: '', enabled: existing?.enabled ?? true, clearSecret: false });
    } catch (error) {
      if (generation !== requestId.current) return;
      setDetail(null);
      setConnections([]);
      setErrorCode(workspaceErrorCode(error));
    } finally {
      if (generation === requestId.current) setLoading(false);
    }
  }, [form, resource]);

  useEffect(() => {
    setDetail(null);
    setConnections([]);
    void load();
    return () => {
      requestId.current += 1;
    };
  }, [load]);

  const currentDetail = !errorCode && detail && detail.id === resource?.id ? detail : null;
  const canConnect = Boolean(
    currentDetail && resource?.actions.includes('USE') && currentDetail.config.managedProfile !== 'external-query'
  );

  const save = async () => {
    if (!currentDetail || !canConnect || loading || saving) return;
    const generation = requestId.current;
    const values = await form.validate().catch((): null => null);
    if (!values || generation !== requestId.current) return;
    setSaving(true);
    try {
      const templateVersion = currentDetail.publishedVersion ?? currentDetail.version;
      const body = JSON.stringify({
        resourceId: currentDetail.id,
        scope: 'PERSONAL',
        templateVersion,
        secret: values.secret.trim() || null,
        clearSecret: values.clearSecret === true,
        enabled: values.clearSecret ? false : values.enabled,
        expectedVersion: personal?.version,
      });
      await enterpriseControl(personal ? `/ai/mcp/connections/${personal.id}` : '/ai/mcp/connections', {
        method: personal ? 'PUT' : 'POST',
        body,
      });
      message.success(t('workspace.abilities.mcp.saved'));
      if (generation === requestId.current) await load();
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    } finally {
      setSaving(false);
    }
  };

  const test = async (connection: McpConnection) => {
    if (!canConnect || loading || saving) return;
    const generation = requestId.current;
    setSaving(true);
    try {
      const result = await enterpriseControl<{ status: string; latencyMs: number; toolCount: number }>(
        `/ai/mcp/connections/${connection.id}/tests`,
        { method: 'POST' }
      );
      if (result.status === 'PASS') {
        message.success(
          t('workspace.abilities.mcp.testPassed', { count: result.toolCount, latency: result.latencyMs })
        );
      } else message.error(t('workspace.abilities.mcp.testFailed'));
      if (generation === requestId.current) await load();
    } catch (error) {
      const code = workspaceErrorCode(error);
      message.error(t(workspaceErrorTranslationKey(code, 'action'), { code }));
    } finally {
      setSaving(false);
    }
  };

  const connectionSummary = (connection: McpConnection) => (
    <div className='flex flex-wrap items-center gap-8px'>
      <Tag>
        {connection.scope === 'PERSONAL'
          ? t('workspace.abilities.mcp.personal')
          : t('workspace.abilities.mcp.enterprise')}
      </Tag>
      <Tag color={connection.status === 'READY' ? 'green' : connection.status === 'ERROR' ? 'red' : 'orange'}>
        {connection.status}
      </Tag>
      <span className='text-12px text-t-secondary'>v{connection.version}</span>
    </div>
  );

  return (
    <Drawer
      width={720}
      visible={Boolean(resource)}
      title={resource?.name || t('workspace.abilities.mcp.title')}
      footer={null}
      onCancel={onClose}
    >
      {messageContext}
      <Spin loading={loading} className='w-full'>
        <div className='flex flex-col gap-14px'>
          {errorCode ? (
            <Alert
              type='error'
              showIcon
              content={t(workspaceErrorTranslationKey(errorCode, 'load'), { code: errorCode })}
              action={
                <Button size='small' onClick={() => void load()}>
                  {t('common.retry')}
                </Button>
              }
            />
          ) : null}
          {currentDetail && !loading ? (
            <Descriptions
              column={1}
              border
              data={[
                {
                  label: t('workspace.abilities.mcp.endpoint'),
                  value: currentDetail.config.endpoint || currentDetail.config.managedProfile || t('workspace.none'),
                },
                { label: t('workspace.abilities.mcp.transport'), value: currentDetail.config.transport },
                { label: t('workspace.abilities.mcp.authorization'), value: currentDetail.config.authType },
                { label: t('workspace.abilities.mcp.timeout'), value: `${currentDetail.config.timeoutSeconds}s` },
              ]}
            />
          ) : null}
          {currentDetail && !loading && enterprise ? (
            <Alert
              type='info'
              showIcon
              content={t('workspace.abilities.mcp.enterpriseAvailable', { status: enterprise.status })}
            />
          ) : null}
          {canConnect && currentDetail && !loading ? (
            <Form form={form} layout='vertical'>
              {currentDetail.config.authType === 'BEARER' ? (
                <>
                  <Form.Item field='secret' label={t('workspace.abilities.mcp.credential')}>
                    <Input.Password
                      autoComplete='new-password'
                      placeholder={
                        personal?.secretConfigured
                          ? t('workspace.abilities.mcp.credentialKeep')
                          : t('workspace.abilities.mcp.credentialRequired')
                      }
                    />
                  </Form.Item>
                  {personal?.secretConfigured ? (
                    <Form.Item field='clearSecret' triggerPropName='checked'>
                      <Switch /> <span className='ml-8px'>{t('workspace.abilities.mcp.clearCredential')}</span>
                    </Form.Item>
                  ) : null}
                </>
              ) : null}
              <Form.Item field='enabled' label={t('workspace.abilities.mcp.enabled')} triggerPropName='checked'>
                <Switch />
              </Form.Item>
              <Space>
                <Button type='primary' loading={saving} onClick={() => void save()}>
                  {personal ? t('workspace.abilities.mcp.update') : t('workspace.abilities.mcp.connect')}
                </Button>
                {personal?.enabled ? (
                  <Button loading={saving} onClick={() => void test(personal)}>
                    {t('workspace.abilities.mcp.test')}
                  </Button>
                ) : null}
                <Button icon={<Refresh />} onClick={() => void load()}>
                  {t('common.refresh')}
                </Button>
              </Space>
            </Form>
          ) : null}
          {currentDetail && !loading && (personal?.tools.length || enterprise?.tools.length) ? (
            <List
              header={t('workspace.abilities.mcp.discoveredTools')}
              dataSource={personal?.tools.length ? personal.tools : enterprise?.tools || []}
              render={(tool) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <div className='flex items-center gap-8px'>
                        <span>{tool.name || '-'}</span>
                        <Tag>{t(`workspace.abilities.mcp.effects.${tool.effect || 'APPROVAL'}`)}</Tag>
                      </div>
                    }
                    description={tool.description || t('workspace.none')}
                  />
                </List.Item>
              )}
            />
          ) : canConnect && !loading ? (
            <Alert type='info' showIcon content={t('workspace.abilities.mcp.testHint')} />
          ) : null}
          {currentDetail && !loading && personal ? connectionSummary(personal) : null}
          {currentDetail && !loading && enterprise ? connectionSummary(enterprise) : null}
          {currentDetail && !loading && personal?.last_error ? (
            <Alert type='error' showIcon content={personal.last_error} />
          ) : null}
        </div>
      </Spin>
    </Drawer>
  );
};

export default McpConnections;
