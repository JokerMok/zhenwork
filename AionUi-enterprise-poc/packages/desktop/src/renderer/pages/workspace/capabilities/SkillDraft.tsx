import { Alert, Button, Collapse, Input, Space, Typography } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enterpriseControl, workspaceErrorCode } from '../workspaceApi';
import type { SkillResource } from './SkillEditor';

type DraftChange = { path: string; before: string; after: string };
export type PersonalSkillDraft = {
  resourceId: string;
  expectedVersion: number;
  source: string;
  files: SkillResource['config']['files'];
  summary: string;
  changes: DraftChange[];
  permissionChanges: never[];
};

export function preferenceChanges(before: string, after: string) {
  const changes: Array<{ key: string; before: string; after: string }> = [];
  const visit = (old: Record<string, unknown>, next: Record<string, unknown>, prefix = '') => {
    for (const key of Object.keys(next)) {
      const a = old[key],
        b = next[key],
        name = prefix + key;
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
        visit(a as Record<string, unknown>, b as Record<string, unknown>, name + '.');
      } else changes.push({ key: name, before: JSON.stringify(a), after: JSON.stringify(b) });
    }
  };
  visit(JSON.parse(before) as Record<string, unknown>, JSON.parse(after) as Record<string, unknown>);
  return changes;
}

const instructionBody = (source: string) => source.replace(/^---\n[\s\S]*?\n---\n/, '').trim();

export default function SkillDraft({
  resource,
  disabled,
  onApply,
}: {
  resource: SkillResource;
  disabled: boolean;
  onApply: (draft: PersonalSkillDraft) => void;
}) {
  const { t } = useTranslation();
  const [request, setRequest] = useState('');
  const [draft, setDraft] = useState<PersonalSkillDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const sequence = useRef(0);
  const active = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      sequence.current++;
      active.current?.abort();
    },
    []
  );
  const generate = async () => {
    if (busy || disabled || !request.trim()) return;
    const n = ++sequence.current;
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(undefined);
    setDraft(undefined);
    try {
      const result = await enterpriseControl<PersonalSkillDraft>(`/ai/resources/${resource.id}/personal-draft`, {
        method: 'POST',
        signal: controller.signal,
        body: JSON.stringify({ expectedVersion: resource.version, instruction: request.trim() }),
      });
      if (n !== sequence.current) return;
      if (
        result.resourceId !== resource.id ||
        result.expectedVersion !== resource.version ||
        result.permissionChanges.length
      ) {
        throw Error('InvalidSkillDraft');
      }
      setDraft(result);
    } catch (e) {
      if (n === sequence.current && !controller.signal.aborted) setError(workspaceErrorCode(e));
    } finally {
      if (n === sequence.current) setBusy(false);
    }
  };
  const unsupported = error === 'UnsupportedMethodChange' || error === 'ProtectedMethodField';
  return (
    <div className='flex flex-col gap-8px' data-testid='skill-natural-editor'>
      <Input.TextArea
        aria-label={t('workspace.abilities.naturalRequest')}
        value={request}
        onChange={(value) => {
          setRequest(value);
          setDraft(undefined);
        }}
        maxLength={2000}
        autoSize={{ minRows: 2, maxRows: 5 }}
        placeholder={t('workspace.abilities.naturalPlaceholder')}
        disabled={disabled || busy}
      />
      <Space>
        <Button
          onClick={() => void generate()}
          loading={busy}
          disabled={disabled || !request.trim()}
          data-testid='skill-draft-generate'
        >
          {t('workspace.abilities.generateDraft')}
        </Button>
        {draft && (
          <Button
            type='primary'
            disabled={disabled || busy}
            data-testid='skill-draft-apply'
            onClick={() => {
              onApply(draft);
              setDraft(undefined);
            }}
          >
            {t('workspace.abilities.applyDraft')}
          </Button>
        )}
      </Space>
      {error && (
        <Alert
          type='error'
          content={t(
            unsupported
              ? 'workspace.abilities.protectedChange'
              : error === 'VersionConflict'
                ? 'workspace.abilities.draftVersionConflict'
                : 'workspace.abilities.draftFailed'
          )}
        />
      )}
      {draft && (
        <>
          {draft.summary && <Typography.Paragraph>{draft.summary}</Typography.Paragraph>}
          <Alert type='info' content={t('workspace.abilities.draftBoundary')} />
          <Collapse defaultActiveKey={['changes']}>
            <Collapse.Item name='changes' header={t('workspace.abilities.draftChanges')}>
              {draft.changes.map((change) =>
                change.path === 'references/preferences.json' ? (
                  <div key={change.path}>
                    {preferenceChanges(change.before, change.after).map((row) => (
                      <div key={row.key} className='grid grid-cols-3 gap-8px py-4px'>
                        <span>
                          {t(`workspace.abilities.preferenceLabels.${row.key.split('.').at(-1)}`, {
                            defaultValue: row.key,
                          })}
                        </span>
                        <span>{row.before}</span>
                        <strong>{row.after}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div key={change.path} className='grid grid-cols-2 gap-12px'>
                    <div>
                      <Typography.Text type='secondary'>{t('workspace.abilities.beforeChange')}</Typography.Text>
                      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                        {instructionBody(change.before)}
                      </Typography.Paragraph>
                    </div>
                    <div>
                      <Typography.Text type='secondary'>{t('workspace.abilities.afterChange')}</Typography.Text>
                      <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                        {instructionBody(change.after)}
                      </Typography.Paragraph>
                    </div>
                  </div>
                )
              )}
            </Collapse.Item>
          </Collapse>
        </>
      )}
    </div>
  );
}
