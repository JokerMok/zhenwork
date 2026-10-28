import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Checkbox,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Pagination,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { emitter } from '@/renderer/utils/emitter';
import { isEnterpriseWeb } from '@/renderer/utils/platform';
import { enterpriseRequest, workspaceErrorCode } from '../../workspaceApi';
import { useTaskWork } from '../api';
import { detail, importData, type Dataset, type DataDetail, type Mapping, type AnalysisSummary } from './api';

const fields = ['date', 'weight', 'unit', 'id', 'node', 'source', 'category', 'status', 'organization', 'wasteName'];
export function DataMappingDrawer({
  id,
  onClose,
  conversationId,
}: {
  id: string;
  onClose: () => void;
  conversationId?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [data, setData] = useState<DataDetail>();
  const [mapping, setMapping] = useState<Mapping>();
  const [period, setPeriod] = useState('');
  const [rule, setRule] = useState('');
  const [template, setTemplate] = useState(true);
  const [issuePages, setIssuePages] = useState<Record<string, number>>({});
  const loadIssues = async (id: string, page: number): Promise<void> => {
    setBusy(true);
    try {
      const value = await enterpriseRequest<AnalysisSummary>(
        `/enterprise/data/${id}/analysis?offset=${(page - 1) * 80}`
      );
      setData((current) =>
        current ? { ...current, analyses: current.analyses?.map((a) => (a.id === id ? value : a)) } : current
      );
      setIssuePages((current) => ({ ...current, [id]: page }));
    } catch (e) {
      setError(workspaceErrorCode(e));
    } finally {
      setBusy(false);
    }
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const load = useCallback(async () => {
    const n = ++generation.current;
    setBusy(true);
    try {
      const value = await detail(id, AbortSignal.timeout(15000));
      if (n !== generation.current) return;
      setData(value);
      setMapping(value.dataset.mapping);
      setPeriod(value.dataset.period || '');
      setRule(value.dataset.ruleId || (value.policies.length === 1 ? value.policies[0].id : ''));
      setError('');
    } catch (e) {
      if (n === generation.current) setError(workspaceErrorCode(e));
    } finally {
      if (n === generation.current) setBusy(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
    return () => {
      generation.current++;
    };
  }, [load]);
  const policy = data?.policies.find((p) => p.id === rule);
  const sheet = data?.dataset.structure.sheets.find((s) => s.name === mapping?.sheet);
  const valid =
    !!mapping &&
    ['date', 'weight', 'id', 'node', 'source', 'category'].every((k) => mapping.fields[k] !== undefined) &&
    /^\d{4}-(0[1-9]|1[0-2])$/.test(period) &&
    !!policy;
  const save = async (continueWork: boolean) => {
    if (!valid || !mapping || busy) return;
    setBusy(true);
    setError('');
    try {
      await enterpriseRequest('/enterprise/data/' + id + '/mapping', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mapping, period, ruleId: rule, saveTemplate: template }),
      });
      window.dispatchEvent(new Event('data-analysis:changed'));
      if (continueWork) {
        const prompt = t('workspace.dataAnalysis.continuePrompt', {
          path: data?.dataset.sourcePath || data?.dataset.name,
          period,
        });
        onClose();
        if (conversationId) emitter.emit('sendbox.fill', '\n' + prompt);
        else navigate('/guid', { state: { prefillPrompt: prompt, focusPrefill: true } });
      } else await load();
    } catch (e) {
      setError(workspaceErrorCode(e));
    } finally {
      setBusy(false);
    }
  };
  const change = (key: string, value: number | undefined) =>
    setMapping((current) => {
      if (!current) return current;
      const next = { ...current.fields };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return { ...current, fields: next };
    });
  return (
    <Drawer
      visible
      title={t('workspace.dataAnalysis.title')}
      width={Math.min(960, window.innerWidth - 32)}
      onCancel={onClose}
      footer={
        <Space>
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button disabled={!valid} loading={busy} onClick={() => void save(false)}>
            {t('workspace.dataAnalysis.save')}
          </Button>
          <Button type='primary' disabled={!valid} loading={busy} onClick={() => void save(true)}>
            {t('workspace.dataAnalysis.continue')}
          </Button>
        </Space>
      }
    >
      <Spin loading={busy} className='w-full'>
        {error && (
          <Alert
            type='error'
            content={t('workspace.dataAnalysis.error', { code: error })}
            action={<Button onClick={() => void load()}>{t('common.retry')}</Button>}
          />
        )}
        {data && mapping && (
          <div className='flex flex-col gap-16px'>
            <Typography.Title heading={6}>{data.dataset.name}</Typography.Title>
            <Descriptions
              column={2}
              data={[
                {
                  label: t('workspace.dataAnalysis.version'),
                  value: data.dataset.source.versionId,
                },
                { label: t('workspace.dataAnalysis.mappingVersion'), value: mapping.version },
                {
                  label: t('workspace.dataAnalysis.encoding'),
                  value: data.dataset.structure.meta.encoding || 'XLSX',
                },
                { label: t('workspace.dataAnalysis.rows'), value: sheet?.rowCount },
              ]}
            />
            <Space wrap>
              <span>{t('workspace.dataAnalysis.sheet')}</span>
              <Select
                aria-label={t('workspace.dataAnalysis.sheet')}
                style={{ width: 200 }}
                value={mapping.sheet}
                onChange={(v) => setMapping({ ...mapping, sheet: v, fields: {} })}
                options={data.dataset.structure.sheets.map((s) => ({
                  label: s.name,
                  value: s.name,
                }))}
              />
              <span>{t('workspace.dataAnalysis.header')}</span>
              <InputNumber
                aria-label={t('workspace.dataAnalysis.header')}
                min={1}
                max={25}
                value={mapping.headerRow}
                onChange={(v) => setMapping({ ...mapping, headerRow: v })}
              />
            </Space>
            <Alert content={t('workspace.dataAnalysis.previewLimit')} type='info' />
            {sheet && (
              <Table
                size='small'
                pagination={false}
                scroll={{ x: Math.max(600, sheet.columns.length * 150), y: 240 }}
                data={sheet.sample.map((r) => ({
                  key: r.row,
                  row: r.row,
                  ...Object.fromEntries(r.values.map((v, i) => ['c' + i, v])),
                }))}
                columns={[
                  {
                    title: t('workspace.dataAnalysis.row'),
                    dataIndex: 'row',
                    width: 80,
                    fixed: 'left',
                  },
                  ...sheet.columns.map((c, i) => ({
                    title: c || String(i + 1),
                    dataIndex: 'c' + i,
                    width: 150,
                    ellipsis: true,
                  })),
                ]}
              />
            )}
            <div className='grid grid-cols-2 gap-12px'>
              {fields.map((k) => (
                <div key={k} className='flex items-center gap-8px'>
                  <span className='w-120px shrink-0'>
                    {t('workspace.dataAnalysis.fields.' + k)}
                    {['date', 'weight', 'id', 'node', 'source', 'category'].includes(k) ? ' *' : ''}
                  </span>
                  <Select
                    aria-label={t('workspace.dataAnalysis.fields.' + k)}
                    allowClear
                    value={mapping.fields[k]}
                    options={sheet?.columns.map((c, i) => ({ label: `${i + 1} · ${c}`, value: i }))}
                    onChange={(v) => change(k, v)}
                  />
                </div>
              ))}
            </div>
            <Space wrap>
              <span>{t('workspace.dataAnalysis.defaultUnit')}</span>
              <Input
                aria-label={t('workspace.dataAnalysis.defaultUnit')}
                value={mapping.defaultUnit || ''}
                style={{ width: 120 }}
                onChange={(v) => setMapping({ ...mapping, defaultUnit: v })}
              />
              <span>{t('workspace.dataAnalysis.period')}</span>
              <Input
                aria-label={t('workspace.dataAnalysis.period')}
                placeholder='YYYY-MM'
                value={period}
                style={{ width: 140 }}
                onChange={setPeriod}
              />
            </Space>
            <Space>
              <span>{t('workspace.dataAnalysis.rule')}</span>
              <Select
                aria-label={t('workspace.dataAnalysis.rule')}
                value={rule}
                onChange={setRule}
                style={{ width: 420 }}
                options={data.policies.map((p) => ({
                  label: p.name + ' v' + p.version,
                  value: p.id,
                }))}
              />
            </Space>
            {!data.policies.length && <Alert type='warning' content={t('workspace.dataAnalysis.noRule')} />}
            {policy && (
              <Typography.Paragraph>
                {policy.definition.meaning} · {policy.definition.scope} · {t('workspace.dataAnalysis.nodes')}:{' '}
                {policy.definition.includeNodes.join('、')}
              </Typography.Paragraph>
            )}
            <Checkbox checked={template} onChange={setTemplate}>
              {t('workspace.dataAnalysis.template')}
            </Checkbox>
            {!valid && <Typography.Text type='secondary'>{t('workspace.dataAnalysis.required')}</Typography.Text>}
            {(data.analyses || []).toReversed().map((a) => (
              <div key={a.id} className='border-t border-solid border-base pt-12px'>
                <Space>
                  <Tag color={a.result.status === 'validated' ? 'green' : 'red'}>
                    {t('workspace.dataAnalysis.' + (a.result.status === 'validated' ? 'validated' : 'blocked'))}
                  </Tag>
                  <span>
                    {a.policy.name} v{a.policy.version}
                  </span>
                  <span>
                    {a.result.rowCount} {t('workspace.dataAnalysis.rows')} · {a.result.summary?.weightKg || '—'} kg
                  </span>
                </Space>
                {!!a.result.issues.length && (
                  <Table
                    size='small'
                    pagePosition='bottomCenter'
                    pagination={false}
                    data={a.result.issues.map((i, n) => ({ ...i, key: n }))}
                    columns={[
                      { title: t('workspace.dataAnalysis.sheet'), dataIndex: 'sheet' },
                      { title: t('workspace.dataAnalysis.row'), dataIndex: 'row' },
                      {
                        title: t('workspace.dataAnalysis.problem'),
                        render: (_, row) =>
                          t('workspace.dataAnalysis.reasons.' + row.code, {
                            defaultValue: t('workspace.dataAnalysis.checkSource'),
                          }),
                      },
                      {
                        title: t('workspace.dataAnalysis.handling'),
                        render: (_, row) =>
                          t('workspace.dataAnalysis.' + (row.severity === 'blocker' ? 'blocked' : 'excluded')),
                      },
                    ]}
                  />
                )}
                {a.issueCount > 80 && (
                  <Pagination
                    total={a.issueCount}
                    pageSize={80}
                    current={issuePages[a.id] || 1}
                    onChange={(page) => void loadIssues(a.id, page)}
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </Spin>
    </Drawer>
  );
}
export default function DataAnalysisControl({
  conversationId,
  filePath,
  autoOpen = false,
}: {
  conversationId?: string;
  filePath?: string;
  autoOpen?: boolean;
}) {
  const { t } = useTranslation();
  const { attempt } = useTaskWork(conversationId);
  const [items, setItems] = useState<Dataset[]>([]);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(false);
  const reload = useCallback(async () => {
    if (!conversationId || !isEnterpriseWeb() || request.current || document.visibilityState !== 'visible') return;
    request.current = true;
    try {
      const data = await enterpriseRequest<{ items: Dataset[] }>(
        '/enterprise/data?conversation=' + encodeURIComponent(conversationId),
        { signal: AbortSignal.timeout(10000) }
      );
      setItems(data.items);
    } catch {
      /* No blank/error panel before an import exists. */
    } finally {
      request.current = false;
    }
  }, [conversationId]);
  useEffect(() => {
    void reload();
    const tick = (): void => {
      void reload();
    };
    window.addEventListener('data-analysis:changed', tick);
    return () => window.removeEventListener('data-analysis:changed', tick);
  }, [reload, attempt?.steps.length, attempt?.state]);
  const open = useCallback(async () => {
    if (!filePath || busy) return;
    setBusy(true);
    setError('');
    try {
      setSelected((await importData(filePath, conversationId)).dataset.id);
    } catch (e) {
      setError(workspaceErrorCode(e));
    } finally {
      setBusy(false);
    }
  }, [filePath, conversationId, busy]);
  useEffect(() => {
    if (autoOpen && filePath) void open();
  }, [autoOpen, filePath]);
  if (!isEnterpriseWeb() || (!filePath && !items.length && !error)) return null;
  return (
    <>
      <Space wrap>
        {filePath ? (
          autoOpen ? null : (
            <Button type='text' loading={busy} onClick={() => void open()}>
              {t('workspace.dataAnalysis.title')}
            </Button>
          )
        ) : (
          items.map((item) => (
            <Button key={item.id} size='small' onClick={() => setSelected(item.id)}>
              {t('workspace.dataAnalysis.title')} · {item.name}
            </Button>
          ))
        )}
      </Space>
      {error && <Alert type='error' content={t('workspace.dataAnalysis.error', { code: error })} />}
      {selected && (
        <DataMappingDrawer id={selected} conversationId={conversationId} onClose={() => setSelected(undefined)} />
      )}
    </>
  );
}
