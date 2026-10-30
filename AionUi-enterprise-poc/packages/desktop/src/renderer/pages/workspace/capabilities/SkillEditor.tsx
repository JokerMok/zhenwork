import { Alert, Button, Drawer, Input, Message, Select, Space } from '@arco-design/web-react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { enterpriseControl, newIdempotencyKey, workspaceErrorCode } from '../workspaceApi';
import type { WorkspaceResource } from '../workspaceTypes';

type SkillFile = {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  executable: boolean;
  sha256?: string;
};
export type SkillResource = WorkspaceResource & {
  config: { source: string; files: SkillFile[]; manifest?: { name?: string } };
};
export const editableSkill = (resource: SkillResource) =>
  resource.ownerType === 'USER' && resource.actions.includes('EDIT');
const textFile = (file: SkillFile) => {
  if (file.encoding !== 'base64') return file.content;
  try {
    const bytes = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
};
const digest = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');

export async function copiedSkill(resource: SkillResource, name: string, suffix: string) {
  const lineage = {
    sourceConfigSha256: await digest(JSON.stringify(resource.config)),
    sourceInstructionSha256: await digest(resource.config.source),
    sourceResourceId: resource.id,
    sourceVersion: resource.publishedVersion || resource.version,
    sourceName: resource.name,
    sourceConfig: resource.config.files.map(({ path, sha256 }) => ({ path, sha256 })),
    copiedAt: new Date().toISOString(),
    updatePolicy: 'explicit-only',
  };
  const source = resource.config.source.replace(/^name:\s*.+$/m, 'name: zhenwork-personal-' + suffix);
  return {
    name,
    description: resource.description || '',
    config: {
      source,
      files: [
        ...resource.config.files.filter((f) => f.path !== 'references/derived-from.json'),
        {
          path: 'references/derived-from.json',
          content: JSON.stringify(lineage, null, 2),
          encoding: 'utf8',
          executable: false,
        },
      ],
    },
  };
}
export default function SkillEditor({
  resource,
  onClose,
  onSaved,
  onUse,
}: {
  resource: SkillResource | null;
  onClose: () => void;
  onSaved: (value: SkillResource) => void;
  onUse: (value: SkillResource) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [message, context] = Message.useMessage();
  const [selected, setSelected] = useState('SKILL.md');
  const [name, setName] = useState('');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<'view' | 'copy'>('view');
  useEffect(() => {
    setSelected('SKILL.md');
    setName(resource?.name || '');
    setDrafts({});
    setMode('view');
  }, [resource?.id, resource?.version]);
  const canEdit = Boolean(resource && (editableSkill(resource) || mode === 'copy'));
  const files = useMemo(
    () =>
      resource
        ? [
            {
              path: 'SKILL.md',
              content: resource.config.source,
              encoding: 'utf8' as const,
              executable: false,
            },
            ...resource.config.files,
          ]
        : [],
    [resource]
  );
  const file = files.find((f) => f.path === selected);
  const original = file ? textFile(file) : null;
  const readable = original !== null && original.length <= 128 * 1024 && !original.includes('\0');
  const locked = selected === 'references/derived-from.json' || selected.startsWith('scripts/');
  const value = drafts[selected] ?? original ?? '';
  const save = async () => {
    if (!resource || !canEdit || !name.trim()) return;
    setSaving(true);
    try {
      const suffix = newIdempotencyKey().replaceAll('-', '').slice(0, 12);
      const base =
        mode === 'copy'
          ? await copiedSkill(resource, name.trim(), suffix)
          : {
              name: name.trim(),
              description: resource.description || '',
              config: { source: resource.config.source, files: resource.config.files },
            };
      const config = {
        source: drafts['SKILL.md'] ?? base.config.source,
        files: base.config.files.map((f) =>
          drafts[f.path] === undefined
            ? f
            : { path: f.path, content: drafts[f.path], encoding: 'utf8', executable: f.executable }
        ),
      };
      // A private copy must keep its own runtime name even after editing its instructions.
      if (mode === 'copy') config.source = config.source.replace(/^name:\s*.+$/m, 'name: zhenwork-personal-' + suffix);
      const saved = await enterpriseControl<SkillResource>(
        mode === 'copy' ? '/ai/resources' : `/ai/resources/${resource.id}`,
        {
          method: mode === 'copy' ? 'POST' : 'PUT',
          body: JSON.stringify({
            ...base,
            config,
            ...(mode === 'copy'
              ? { resourceType: 'SKILL', enterprise: false, idempotencyKey: newIdempotencyKey() }
              : { expectedVersion: resource.version }),
          }),
        }
      );
      await enterpriseControl(`/ai/resources/${saved.id}/activate`, {
        method: 'POST',
        body: JSON.stringify({ version: saved.version }),
      });
      const active = await enterpriseControl<SkillResource>(`/ai/resources/${saved.id}`);
      onSaved(active);
      setMode('view');
      setDrafts({});
      message.success(t('workspace.abilities.methodSaved'));
    } catch (error) {
      message.error(t('workspace.abilities.methodSaveFailed', { code: workspaceErrorCode(error) }));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Drawer
      width={840}
      visible={Boolean(resource)}
      title={resource?.name || t('workspace.abilities.packageDetail')}
      onCancel={onClose}
      footer={null}
    >
      {context}
      {resource && (
        <div className='flex flex-col gap-12px'>
          <Space wrap>
            <span>
              {t('workspace.abilities.versionLabel')} v{resource.version}
            </span>
            {mode !== 'copy' && (
              <Button
                data-testid='skill-copy'
                onClick={() => {
                  setMode('copy');
                  setName(t('workspace.abilities.personalMethodName', { name: resource.name }));
                }}
              >
                {t('workspace.abilities.copyMethod')}
              </Button>
            )}
            {canEdit && (
              <Button type='primary' loading={saving} data-testid='skill-save' onClick={() => void save()}>
                {t('workspace.abilities.saveMethod')}
              </Button>
            )}
            {mode !== 'copy' && (
              <Button
                data-testid='skill-use'
                disabled={Object.keys(drafts).length > 0}
                onClick={() => void onUse(resource)}
              >
                {t('workspace.abilities.use')}
              </Button>
            )}
          </Space>
          {canEdit && (
            <Input aria-label={t('workspace.abilities.methodName')} value={name} onChange={setName} maxLength={80} />
          )}
          <Select aria-label={t('workspace.abilities.packageFiles')} value={selected} onChange={setSelected} showSearch>
            {files.map((f) => (
              <Select.Option key={f.path} value={f.path}>
                {f.path}
              </Select.Option>
            ))}
          </Select>
          {locked && <Alert type='info' content={t('workspace.abilities.methodProtectedFile')} />}
          {readable ? (
            <Input.TextArea
              aria-label={t('workspace.abilities.methodContent')}
              value={value}
              readOnly={!canEdit || locked}
              onChange={(text) => setDrafts((d) => ({ ...d, [selected]: text }))}
              autoSize={{ minRows: 18, maxRows: 30 }}
              style={{ fontFamily: 'monospace' }}
            />
          ) : (
            <Alert type='info' content={t('workspace.abilities.methodBinaryFile')} />
          )}
        </div>
      )}
    </Drawer>
  );
}
